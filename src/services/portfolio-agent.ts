import OpenAI from "openai";
import { z } from "zod";

import {
  opportunitySchema,
  portfolioPlanSchema,
  type Opportunity,
  type PaymentReceipt,
  type PortfolioPlan,
  type PortfolioSnapshot,
} from "../domain.js";
import type {
  Canix402Client,
  McpToolDefinition,
} from "../integrations/canix402/client.js";
import { prepareAgentTools } from "../integrations/canix402/client.js";
import type { PortfolioReader } from "../integrations/algorand/portfolio.js";
import { prefetchHostResearch } from "./host-research.js";
import {
  parseInferenceCostFromHeaders,
  summarizeInferenceCosts,
  type InferenceCostCharge,
  type InferenceCostSummary,
} from "./inference-cost.js";
import { sanitizeErrorMessage } from "../util/errors.js";
import { normalizePortfolioPlan } from "./portfolio-policy.js";
import { formatBaseUnits } from "./money.js";

export { formatBaseUnits };

const SKIPPABLE_RESEARCH_TOOLS = new Set(["canix_get_protocol_opportunities"]);

/** Tools the model may call. Catalog/OpenAPI/strategy/execution tools are excluded. */
const AGENT_TOOL_ALLOWLIST = new Set([
  "canix_list_opportunities",
  "canix_search_opportunities",
  "canix_get_personalized_opportunities",
  "canix_get_protocol_opportunities",
  "canix_list_execution_shapes",
  "canix_get_quote",
  "canix_get_token_prices",
]);

const OPPORTUNITY_RESEARCH_TOOLS = new Set([
  "canix_list_opportunities",
  "canix_search_opportunities",
  "canix_get_personalized_opportunities",
  "canix_get_protocol_opportunities",
]);

/** Hard cap per opportunity MCP call (API allows up to 200). Model-facing rows stay small for ZS latency. */
export const MAX_OPPORTUNITY_TOOL_LIMIT = 10;

/** Host-only after policy approval. Never expose to the planning agent. */
const FINAL_EXECUTION_TOOLS = new Set([
  "canix_get_execution_quote",
  "canix_optin",
  "canix_swap",
]);

const responseSchema = z
  .object({
    /** ZeroSignal may return an empty top-level id; treat as missing. */
    id: z.string().optional(),
    output: z.array(z.unknown()).default([]),
    output_text: z.string().optional(),
  })
  .passthrough();

export type NormalizedAgentResponse = {
  id?: string;
  output: unknown[];
  output_text?: string;
  raw: Record<string, unknown>;
};

/** Normalize Responses API payloads (including ZeroSignal empty `id`). */
export function normalizeAgentResponse(raw: unknown): NormalizedAgentResponse {
  const parsed = responseSchema.parse(raw);
  const id =
    typeof parsed.id === "string" && parsed.id.trim().length > 0
      ? parsed.id
      : undefined;
  const output_text =
    parsed.output_text && parsed.output_text.length > 0
      ? parsed.output_text
      : extractOutputText(parsed.output);
  return {
    id,
    output: parsed.output,
    output_text,
    raw: parsed as Record<string, unknown>,
  };
}

/** Pull assistant `output_text` parts when the SDK does not set `output_text`. */
export function extractOutputText(output: unknown[]): string | undefined {
  const texts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (record.type !== "message" || !Array.isArray(record.content)) {
      continue;
    }
    for (const part of record.content) {
      if (!part || typeof part !== "object") {
        continue;
      }
      const content = part as Record<string, unknown>;
      if (
        content.type === "output_text" &&
        typeof content.text === "string" &&
        content.text.length > 0
      ) {
        texts.push(content.text);
      }
    }
  }
  return texts.length > 0 ? texts.join("") : undefined;
}

const functionCallSchema = z.object({
  type: z.literal("function_call"),
  call_id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.string(),
});

export interface ResponsesClient {
  responses: {
    /**
     * Returns either the Responses body, or `{ data, response }` /
     * `{ data, headers }` so zs-proxy `X-Zs-*` cost headers can be read.
     */
    create(request: unknown): Promise<unknown>;
  };
}

export interface PortfolioAgentResult {
  snapshot: PortfolioSnapshot;
  /** Present when portfolio_plan JSON parsed successfully. */
  plan?: PortfolioPlan;
  /** Best-effort agent text when structured plan parse failed. */
  planRawText?: string;
  planParseError?: string;
  opportunities: Opportunity[];
  payments: PaymentReceipt[];
  toolCalls: string[];
  inferenceCost?: InferenceCostSummary;
}

export interface PortfolioAgent {
  run(): Promise<PortfolioAgentResult>;
}

export interface PreferredHoldAsset {
  assetId: number;
  targetPortfolioPct: number;
}

export interface PortfolioHostGuidance {
  maxPositionPct: number;
  maxProtocolPct: number;
  minLiquidReservePct: number;
  minTvlUsd: number;
  maxSourceAgeHours: number;
  minProjectedNetImprovementUsd: number;
  /**
   * Soft operator preferences: hold these ASAs near targetPortfolioPct of
   * portfolio USD. Not hard-enforced by policy.
   */
  preferredHoldAssets: PreferredHoldAsset[];
}

export type PortfolioAiMode = "full" | "lite";

export interface PortfolioAgentOptions {
  model: string;
  reasoningEffort: "low" | "medium" | "high";
  /** `full` = LLM tool loop; `lite` = host research + single decide call. */
  aiMode: PortfolioAiMode;
  maxToolCalls: number;
  walletAddress: string;
  hostGuidance: PortfolioHostGuidance;
  signingEnabled: boolean;
}

const PORTFOLIO_AGENT_PROMPT_SHARED = `You are Brownie, an autonomous Algorand treasury portfolio manager (once per day).

GOAL
Deploy idle capital into high-TVL, execution-ready yield after fees/slippage/risk. Keep minLiquidReservePct liquid. Prefer deeper liquidity over peak APY. Host guidance numbers are in the task input—plan toward them; the host hard-enforces structure when signing.

SNAPSHOT
Host already loaded positions + liquid balances. Treat null/partial protocol data as incomplete, not zero. For liquidBalances: use amount/spendableAmount/usdValue for judgment and summaries; use amountRaw/spendableAmountRaw only in authorizedSpends and executionInput. Never multiply amountRaw by a USD price. Never invent decimals.

CAPITAL
Deploy surplus above the reserve when eligible executable opportunities exist. Hold only with named rejected candidates (id, APY, TVL, why). Ending liquid USDC (asset 31566704) should be ~5+ for ops (Canix x402 + ZeroSignal); if short, end with a small consolidate-usdc-buffer swap. Do not invent secrets, mnemonics, or payment details.
Swaps are not only precursors to deposits: use swap to rotate idle liquid ASAs into USDC/ALGO for yield, to rebalance toward hostGuidance.preferredHoldAssets targetPortfolioPct, or to free capital—when fees/slippage are justified. Do not swap preferred-hold assets that are already near their target %.
Preferred holds (hostGuidance.preferredHoldAssets): soft long-term targets as % of portfolio USD. Treat listed assets as intentional holdings up to targetPortfolioPct; do not nag or force-rotate them when near target. Below target, prefer accumulating via surplus rather than liquidating productive yield. Above target, trim only when net benefit clearly exceeds costs. Unlisted idle ASAs may be rotated into yield or preferred holds when economics work.

PLAN ACTIONS
- Prefer executionReady with non-empty shapeKeys; empty shapeKeys = research-only—never invent keys.
- open/increase: one capital action per opportunity; executionShapeKey from shapeKeys (deposit/addLiquidity-style); authorizedSpends + amountRaw/fromAssetId; executionInput may be null (host completes). No separate setup/escrow/opt-in plan actions.
- close/reduce/claim: executionShapeKey from position compatibleExitShapeKeys / compatibleManageShapeKeys; size with amountRaw / executionInput; authorizedSpends may be []. Never invent keys; empty catalogs = no supported path.
- Tinyman farm rewards: claim against the reward position (positionType reward / opportunityId ending :farm) using that row's compatibleManageShapeKeys (e.g. mainnet:tinyman:staking-v1:farm:claimRewards). Do NOT claim against the farmed LP row — its manage keys are empty by design (exit is removeLiquidity + farm:uncommit only).
- Swaps: (1) unlock required assets for a following open/increase, (2) consolidate USDC ops buffer, (3) rotate non-preferred idle liquid into deployable capital or preferred holds. Prefer canix_get_quote before sizing. If a quote tool returns an error (timeout, liquidity, impact), retry with a different size/pair or skip that swap and continue the plan—do not stop the whole review.
- Missing required assets: prior swap action(s), then depend on those action ids only.
- dependencies: only other action ids in this plan.
- projectedNetBenefitUsd: honest yield-vs-idle over holdingHorizonDays (often 30–90) minus one-time costs; use base supply/deposit APY, not reward boosts.
- Re-evaluate every position each run; avoid churn only when net improvement is small vs costs.

OUTPUT
Return ONLY one top-level JSON object (no portfolio_plan wrapper). No markdown, tables, or code fences.
Do not invent alternate field names. Allocations must NOT use label/usdValue/name — only the keys below.

Top-level (all required):
currentAllocations, targetAllocations, actions, holdDecisions,
currentAnnualizedReturnPct, targetAnnualizedReturnPct, estimatedOneTimeCostsUsd,
projectedNetBenefitUsd, holdingHorizonDays, evidence, assumptions, risks, confidence, summary

Allocation object (each currentAllocations/targetAllocations item):
key (string id, e.g. "liquid-usdc" or "folks:xalgo"), protocol (string|null), opportunityId (string|null),
assetIds (number[]), weightPct (0–100), expectedApyPct (number|null)
Do not put usdValue on allocations.

Action object:
id, type (hold|open|increase|reduce|close|swap|claim), protocol, opportunityId, positionId,
amountRaw, fromAssetId, toAssetId, targetWeightPct, executionShapeKey, executionInput,
authorizedSpends ([{assetId, amountRaw}]), rationale, dependencies
Use id not actionId; rationale not reason; spend assetId not fromAssetId.

summary must be a string. holdDecisions is a string[]. Nullable action fields may be null.`;

export const PORTFOLIO_AGENT_PROMPT_V1 = `${PORTFOLIO_AGENT_PROMPT_SHARED}

FULL MODE — RESEARCH
1. Call canix_get_personalized_opportunities once (managed wallet).
2. Call canix_search_opportunities or canix_list_opportunities once for high-TVL / executionReady (prefer limit ≤ 10).
3. Stop after those two unless you truly need one more (e.g. canix_get_quote for a planned swap). Avoid canix_list_execution_shapes and canix_get_token_prices unless shapeKeys or usdValue are missing.
Tool rows are skinny (shapeKeys only); host keeps full shapes for policy/execution. Do not favor named protocols—rank by TVL, readiness, net benefit, concentration.`;

export const PORTFOLIO_AGENT_PROMPT_LITE = `${PORTFOLIO_AGENT_PROMPT_SHARED}

LITE MODE — NO TOOLS
Host already researched (personalized + high-TVL). Use researchedOpportunities / candidates only. Prefer executionReady with non-empty shapeKeys. Rank by TVL, readiness, net benefit, concentration—not named protocols.`;

const PLAN_JSON_REPAIR_USER_MESSAGE =
  "Your previous reply was not valid portfolio_plan JSON. Reply with ONLY one top-level JSON object (no portfolio_plan wrapper). " +
  "Allocations: [{key, protocol, opportunityId, assetIds, weightPct, expectedApyPct}] — never label/usdValue. " +
  "Actions: [{id, type, protocol, opportunityId, positionId, amountRaw, fromAssetId, toAssetId, targetWeightPct, executionShapeKey, executionInput, authorizedSpends:[{assetId,amountRaw}], rationale, dependencies}]. " +
  "Also include: holdDecisions (string[]), currentAnnualizedReturnPct, targetAnnualizedReturnPct, estimatedOneTimeCostsUsd, projectedNetBenefitUsd, holdingHorizonDays, evidence, assumptions, risks, confidence, summary (string). " +
  "No markdown, headings, tables, or code fences.";

const planFormat = {
  type: "json_schema",
  name: "portfolio_plan",
  strict: false,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      currentAllocations: { type: "array", items: allocationJsonSchema() },
      targetAllocations: { type: "array", items: allocationJsonSchema() },
      actions: {
        type: "array",
        maxItems: 30,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            type: {
              type: "string",
              enum: [
                "hold",
                "open",
                "increase",
                "reduce",
                "close",
                "swap",
                "claim",
              ],
            },
            protocol: { type: ["string", "null"] },
            opportunityId: { type: ["string", "null"] },
            positionId: { type: ["string", "null"] },
            amountRaw: { type: ["string", "null"], pattern: "^[0-9]+$" },
            fromAssetId: { type: ["integer", "null"], minimum: 0 },
            toAssetId: { type: ["integer", "null"], minimum: 0 },
            targetWeightPct: {
              type: ["number", "null"],
              minimum: 0,
              maximum: 100,
            },
            executionShapeKey: { type: ["string", "null"] },
            executionInput: {
              type: ["object", "null"],
              additionalProperties: true,
            },
            authorizedSpends: {
              type: "array",
              maxItems: 4,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  assetId: { type: "integer", minimum: 0 },
                  amountRaw: {
                    type: "string",
                    pattern: "^[1-9][0-9]*$",
                  },
                },
                required: ["assetId", "amountRaw"],
              },
            },
            rationale: { type: "string" },
            dependencies: { type: "array", items: { type: "string" } },
          },
          required: [
            "id",
            "type",
            "protocol",
            "opportunityId",
            "positionId",
            "amountRaw",
            "fromAssetId",
            "toAssetId",
            "targetWeightPct",
            "executionShapeKey",
            "executionInput",
            "authorizedSpends",
            "rationale",
            "dependencies",
          ],
        },
      },
      holdDecisions: { type: "array", items: { type: "string" } },
      currentAnnualizedReturnPct: { type: ["number", "null"] },
      targetAnnualizedReturnPct: { type: ["number", "null"] },
      estimatedOneTimeCostsUsd: { type: "number", minimum: 0 },
      projectedNetBenefitUsd: { type: "number" },
      holdingHorizonDays: { type: "integer", minimum: 1 },
      evidence: { type: "array", items: { type: "string" } },
      assumptions: { type: "array", items: { type: "string" } },
      risks: { type: "array", items: { type: "string" } },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      summary: { type: "string" },
    },
    required: [
      "currentAllocations",
      "targetAllocations",
      "actions",
      "holdDecisions",
      "currentAnnualizedReturnPct",
      "targetAnnualizedReturnPct",
      "estimatedOneTimeCostsUsd",
      "projectedNetBenefitUsd",
      "holdingHorizonDays",
      "evidence",
      "assumptions",
      "risks",
      "confidence",
      "summary",
    ],
  },
} as const;

export class OpenAiPortfolioAgent implements PortfolioAgent {
  constructor(
    private readonly openai: ResponsesClient,
    private readonly canix: Canix402Client,
    private readonly portfolioReader: PortfolioReader,
    private readonly options: PortfolioAgentOptions,
  ) {}

  async run(): Promise<PortfolioAgentResult> {
    const discoveredTools = await this.canix.listTools();
    assertRequiredCapabilities(discoveredTools, this.options.signingEnabled);
    const { snapshot, payments } = await this.portfolioReader.read();

    if (this.options.aiMode === "lite") {
      return this.runLite(snapshot, payments);
    }
    return this.runFull(discoveredTools, snapshot, payments);
  }

  private async runLite(
    snapshot: PortfolioSnapshot,
    payments: PaymentReceipt[],
  ): Promise<PortfolioAgentResult> {
    const research = await prefetchHostResearch(this.canix, {
      walletAddress: this.options.walletAddress,
    });
    payments.push(...research.payments);
    const toolCalls = ["canix_get_positions", ...research.toolCalls];
    const inferenceCharges: InferenceCostCharge[] = [];
    const researchedOpportunities = compactOpportunitiesForModel(
      research.opportunities,
      {
        minTvlUsd: this.options.hostGuidance.minTvlUsd,
        maxRows: MAX_OPPORTUNITY_TOOL_LIMIT,
      },
    );
    const initialInput = JSON.stringify({
      task: "Produce today's portfolio plan from host-researched opportunities.",
      managedWallet: this.options.walletAddress,
      inferenceProvider: "zerosignal",
      aiMode: "lite",
      hostGuidance: this.options.hostGuidance,
      portfolioSnapshot: compactSnapshotForModel(snapshot),
      researchedOpportunities,
      candidates: researchedOpportunities,
    });

    const { data, headers } = await createAgentResponse(this.openai, {
      model: this.options.model,
      instructions: PORTFOLIO_AGENT_PROMPT_LITE,
      input: initialInput,
      store: false,
      reasoning: { effort: this.options.reasoningEffort },
      text: { format: planFormat },
    });
    recordInferenceCharge(inferenceCharges, headers);
    const response = normalizeAgentResponse(data);

    if (
      response.output.some((item) => {
        const parsed = functionCallSchema.safeParse(item);
        return parsed.success;
      })
    ) {
      throw new Error(
        "Portfolio agent lite mode returned tool calls; tools are disabled in lite mode",
      );
    }

    const parsed = await this.parsePlanWithOptionalRepair(response, {
      instructions: PORTFOLIO_AGENT_PROMPT_LITE,
      initialInput,
      conversationItems: [],
      inferenceCharges,
    });

    if (!parsed.ok) {
      console.error(
        `[portfolio-agent] Plan still invalid after repair; returning report-only: ${parsed.planParseError}`,
      );
      return {
        snapshot,
        planRawText: parsed.planRawText,
        planParseError: parsed.planParseError,
        opportunities: research.opportunities,
        payments,
        toolCalls,
        inferenceCost: summarizeInferenceCosts(inferenceCharges),
      };
    }

    return {
      snapshot,
      plan: normalizePortfolioPlan(
        parsed.plan,
        research.opportunities,
        snapshot,
      ),
      opportunities: research.opportunities,
      payments,
      toolCalls,
      inferenceCost: summarizeInferenceCosts(inferenceCharges),
    };
  }

  private async runFull(
    discoveredTools: McpToolDefinition[],
    snapshot: PortfolioSnapshot,
    payments: PaymentReceipt[],
  ): Promise<PortfolioAgentResult> {
    const definitions = selectAgentTools(
      prepareAgentTools(discoveredTools),
      this.options.signingEnabled,
    );
    const tools = definitions.map(toOpenAiTool);
    const toolCalls: string[] = ["canix_get_positions"];
    const opportunities: Opportunity[] = [];
    const inferenceCharges: InferenceCostCharge[] = [];
    const initialInput = JSON.stringify({
      task: "Research and produce today's portfolio plan.",
      managedWallet: this.options.walletAddress,
      inferenceProvider: "zerosignal",
      aiMode: "full",
      hostGuidance: this.options.hostGuidance,
      portfolioSnapshot: compactSnapshotForModel(snapshot),
    });
    /** Explicit client-side transcript; never use previous_response_id (ZS/privacy). */
    let conversationItems: unknown[] = [];
    const first = await createAgentResponse(this.openai, {
      model: this.options.model,
      instructions: PORTFOLIO_AGENT_PROMPT_V1,
      input: initialInput,
      store: false,
      reasoning: { effort: this.options.reasoningEffort },
      tools,
      tool_choice: "auto",
      text: { format: planFormat },
    });
    recordInferenceCharge(inferenceCharges, first.headers);
    let response = normalizeAgentResponse(first.data);

    let calls = 0;
    while (true) {
      const functionCalls = response.output
        .map((item) => functionCallSchema.safeParse(item))
        .flatMap((parsed) => (parsed.success ? [parsed.data] : []));
      if (functionCalls.length === 0) {
        if (
          !toolCalls.some((name) =>
            [
              "canix_list_opportunities",
              "canix_search_opportunities",
              "canix_get_personalized_opportunities",
              "canix_get_protocol_opportunities",
            ].includes(name),
          )
        ) {
          throw new Error(
            "Portfolio agent returned a plan without researching opportunities",
          );
        }
        const parsed = await this.parsePlanWithOptionalRepair(response, {
          instructions: PORTFOLIO_AGENT_PROMPT_V1,
          initialInput,
          conversationItems,
          inferenceCharges,
        });
        if (!parsed.ok) {
          console.error(
            `[portfolio-agent] Plan still invalid after repair; returning report-only: ${parsed.planParseError}`,
          );
          return {
            snapshot,
            planRawText: parsed.planRawText,
            planParseError: parsed.planParseError,
            opportunities,
            payments,
            toolCalls,
            inferenceCost: summarizeInferenceCosts(inferenceCharges),
          };
        }
        return {
          snapshot,
          plan: normalizePortfolioPlan(
            parsed.plan,
            opportunities,
            snapshot,
          ),
          opportunities,
          payments,
          toolCalls,
          inferenceCost: summarizeInferenceCosts(inferenceCharges),
        };
      }

      calls += functionCalls.length;
      if (calls > this.options.maxToolCalls) {
        throw new Error(
          `Portfolio agent exceeded ${this.options.maxToolCalls} MCP tool calls`,
        );
      }
      const outputs: Array<Record<string, unknown>> = [];
      for (const call of functionCalls) {
        const args = normalizeAgentToolArgs(
          call.name,
          parseArguments(call.arguments),
        );
        if (FINAL_EXECUTION_TOOLS.has(call.name)) {
          outputs.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify({
              error: "EXECUTION_HOST_ONLY",
              message:
                "Final execution tools run only after the plan is approved. Use research and canix_get_quote for planning; do not call canix_get_execution_quote, canix_optin, or canix_swap.",
            }),
          });
          continue;
        }
        if (!AGENT_TOOL_ALLOWLIST.has(call.name)) {
          outputs.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify({
              error: "TOOL_NOT_AVAILABLE",
              tool: call.name,
              message:
                "This tool is not exposed to the portfolio agent. Use opportunity research and quote tools only.",
            }),
          });
          continue;
        }
        try {
          const result = await this.canix.callManagedTool(
            call.name,
            args,
            this.options.walletAddress,
          );
          toolCalls.push(call.name);
          if (result.payment) {
            payments.push(result.payment);
          }
          collectOpportunities(result.data, opportunities);
          outputs.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify(
              compactToolResultForModel(call.name, result.data, {
                minTvlUsd: this.options.hostGuidance.minTvlUsd,
                maxRows: MAX_OPPORTUNITY_TOOL_LIMIT,
              }),
            ),
          });
        } catch (error) {
          // Allowlisted research/quote tools: return the failure to the model so
          // it can retry, change pair/size, or continue without aborting the run.
          if (!AGENT_TOOL_ALLOWLIST.has(call.name)) {
            throw error;
          }
          const message = safeErrorMessage(error);
          const argsForLog = sanitizeToolArgsForLog(args);
          const gatewayTimeout = isGatewayTimeoutToolError(error);
          console.error(
            `[portfolio-agent] Tool ${call.name} failed; returning error to model: ${message}`,
          );
          console.error(
            `[portfolio-agent] Tool args: ${JSON.stringify(argsForLog)}`,
          );
          toolCalls.push(call.name);
          outputs.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify({
              error: gatewayTimeout ? "GATEWAY_TIMEOUT" : "TOOL_ERROR",
              tool: call.name,
              message,
              args: argsForLog,
              retryable: gatewayTimeout,
              skipped: SKIPPABLE_RESEARCH_TOOLS.has(call.name),
              hint:
                call.name === "canix_get_quote"
                  ? "Quote failed. Retry with a different size or pair, or skip this swap and continue the plan with other actions."
                  : "Tool failed. Continue with other research or plan without this result.",
            }),
          });
        }
      }

      conversationItems = [...conversationItems, ...response.output, ...outputs];
      const next = await createAgentResponse(this.openai, {
        model: this.options.model,
        instructions: PORTFOLIO_AGENT_PROMPT_V1,
        input: [
          { role: "user", content: initialInput },
          ...conversationItems,
        ],
        store: false,
        reasoning: { effort: this.options.reasoningEffort },
        tools,
        tool_choice: "auto" as const,
        text: { format: planFormat },
      });
      recordInferenceCharge(inferenceCharges, next.headers);
      response = normalizeAgentResponse(next.data);
    }
  }

  /**
   * Parse the structured plan; if the model returned markdown/prose, make one
   * tools-off repair turn that demands JSON only. On final failure, soft-succeed
   * with raw text instead of throwing.
   */
  private async parsePlanWithOptionalRepair(
    response: NormalizedAgentResponse,
    context: {
      instructions: string;
      initialInput: string;
      conversationItems: unknown[];
      inferenceCharges: InferenceCostCharge[];
    },
  ): Promise<ParsePlanOutcome> {
    try {
      return { ok: true, plan: parsePlan(response.output_text) };
    } catch (firstError) {
      console.error(
        `[portfolio-agent] Plan JSON invalid; requesting one repair turn: ${safeErrorMessage(firstError)}`,
      );
      const repaired = await createAgentResponse(this.openai, {
        model: this.options.model,
        instructions: context.instructions,
        input: [
          { role: "user", content: context.initialInput },
          ...context.conversationItems,
          ...response.output,
          {
            role: "user",
            content: PLAN_JSON_REPAIR_USER_MESSAGE,
          },
        ],
        store: false,
        reasoning: { effort: this.options.reasoningEffort },
        tools: [],
        text: { format: planFormat },
      });
      recordInferenceCharge(context.inferenceCharges, repaired.headers);
      const repairedResponse = normalizeAgentResponse(repaired.data);
      try {
        return { ok: true, plan: parsePlan(repairedResponse.output_text) };
      } catch (secondError) {
        const planRawText =
          repairedResponse.output_text?.trim() ||
          response.output_text?.trim() ||
          "";
        return {
          ok: false,
          planRawText:
            planRawText.length > 0
              ? planRawText
              : "(empty agent output)",
          planParseError: safeErrorMessage(secondError),
        };
      }
    }
  }
}

export function createPortfolioAgent(
  apiKey: string,
  canix: Canix402Client,
  portfolioReader: PortfolioReader,
  options: PortfolioAgentOptions,
  baseURL: string,
): OpenAiPortfolioAgent {
  const openai = new OpenAI({ apiKey, baseURL });
  const client: ResponsesClient = {
    responses: {
      async create(request: unknown) {
        const { data, response } = await openai.responses
          .create(request as never)
          .withResponse();
        return { data, response };
      },
    },
  };
  return new OpenAiPortfolioAgent(client, canix, portfolioReader, options);
}

/** Normalize OpenAI SDK / test mocks into body + optional HTTP headers. */
export async function createAgentResponse(
  openai: ResponsesClient,
  request: unknown,
): Promise<{ data: unknown; headers?: Headers }> {
  const result = await openai.responses.create(request);
  if (!result || typeof result !== "object") {
    return { data: result };
  }
  const record = result as {
    data?: unknown;
    response?: { headers?: Headers };
    headers?: Headers | Record<string, string>;
  };
  if ("data" in record && record.data !== undefined) {
    if (record.response?.headers) {
      return { data: record.data, headers: record.response.headers };
    }
    if (record.headers) {
      return {
        data: record.data,
        headers:
          record.headers instanceof Headers
            ? record.headers
            : headersFromRecord(record.headers),
      };
    }
    return { data: record.data };
  }
  return { data: result };
}

function recordInferenceCharge(
  charges: InferenceCostCharge[],
  headers: Headers | undefined,
): void {
  const charge = parseInferenceCostFromHeaders(headers);
  if (charge) {
    charges.push(charge);
  }
}

function headersFromRecord(record: Record<string, string>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(record)) {
    headers.set(key, value);
  }
  return headers;
}

function toOpenAiTool(tool: McpToolDefinition) {
  return {
    type: "function",
    name: tool.name,
    description: tool.description ?? `Call ${tool.name}`,
    strict: false,
    parameters: tool.inputSchema,
  };
}

export function selectAgentTools(
  tools: McpToolDefinition[],
  _signingEnabled: boolean,
): McpToolDefinition[] {
  return tools.filter(
    (tool) =>
      AGENT_TOOL_ALLOWLIST.has(tool.name) &&
      !FINAL_EXECUTION_TOOLS.has(tool.name),
  );
}

export function clampOpportunityToolArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!OPPORTUNITY_RESEARCH_TOOLS.has(toolName)) {
    return args;
  }
  const requested =
    typeof args.limit === "number" && Number.isFinite(args.limit)
      ? Math.trunc(args.limit)
      : MAX_OPPORTUNITY_TOOL_LIMIT;
  return {
    ...args,
    limit: Math.min(
      Math.max(1, requested),
      MAX_OPPORTUNITY_TOOL_LIMIT,
    ),
  };
}

/**
 * Normalize LLM tool args before Canix calls.
 * Models often emit asset ids as strings; execution uses numbers.
 */
export function normalizeAgentToolArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const next = clampOpportunityToolArgs(toolName, args);
  if (toolName !== "canix_get_quote") {
    return next;
  }
  const fromAssetId = coerceNonNegativeInt(next.fromAssetId);
  const toAssetId = coerceNonNegativeInt(next.toAssetId);
  const amount = coerceAmountString(next.amount);
  return {
    ...next,
    ...(fromAssetId !== undefined ? { fromAssetId } : {}),
    ...(toAssetId !== undefined ? { toAssetId } : {}),
    ...(amount !== undefined ? { amount } : {}),
  };
}

function coerceNonNegativeInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

function coerceAmountString(value: unknown): string | undefined {
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return String(Math.trunc(value));
  }
  return undefined;
}

export function compactToolResultForModel(
  toolName: string,
  data: unknown,
  options: { minTvlUsd: number; maxRows: number },
): unknown {
  const cleaned = stripPaymentNoise(data);
  if (!OPPORTUNITY_RESEARCH_TOOLS.has(toolName)) {
    return cleaned;
  }
  if (!cleaned || typeof cleaned !== "object") {
    return cleaned;
  }
  const record = cleaned as Record<string, unknown>;
  if (!Array.isArray(record.data)) {
    return cleaned;
  }
  const parsed = record.data.flatMap((item) => {
    const opportunity = opportunitySchema.safeParse(item);
    return opportunity.success ? [opportunity.data] : [];
  });
  return compactOpportunitiesForModel(parsed, options, record.meta);
}

/** Compact a host-collected opportunity list for a decide-only LLM turn. */
export function compactOpportunitiesForModel(
  opportunities: Opportunity[],
  options: { minTvlUsd: number; maxRows: number },
  meta?: unknown,
): unknown {
  const eligible = opportunities
    .filter(
      (item) => item.tvlUsd >= options.minTvlUsd || item.executionReady,
    )
    .sort((left, right) => {
      if (left.executionReady !== right.executionReady) {
        return left.executionReady ? -1 : 1;
      }
      return right.tvlUsd - left.tvlUsd;
    });
  const selected = eligible.slice(0, options.maxRows);
  return {
    data: selected.map(compactOpportunityForModel),
    meta: {
      ...(typeof meta === "object" && meta
        ? (meta as Record<string, unknown>)
        : {}),
      sourceCount: opportunities.length,
      returnedCount: selected.length,
      truncated: opportunities.length > selected.length,
      hostNote:
        "Compacted by host: sorted executionReady then TVL, capped rows, shapeKeys only (full shapes kept host-side).",
    },
  };
}

function compactOpportunityForModel(opportunity: Opportunity) {
  return {
    protocol: opportunity.protocol,
    opportunityType: opportunity.opportunityType,
    opportunityId: opportunity.opportunityId,
    assetPair: opportunity.assetPair,
    assetIds: opportunity.assetIds,
    apy: opportunity.apy,
    apr: opportunity.apr,
    yieldBasis: opportunity.yieldBasis,
    tvlUsd: opportunity.tvlUsd,
    sourceTimestamp: opportunity.sourceTimestamp,
    executionReady: opportunity.executionReady,
    shapeKeys: opportunity.executionShapes.map((shape) => shape.shapeKey),
  };
}

function compactSnapshotForModel(snapshot: PortfolioSnapshot) {
  return {
    address: snapshot.address,
    fetchedAt: snapshot.fetchedAt,
    complete: snapshot.complete,
    caveats: snapshot.caveats,
    totals: snapshot.totals,
    minimumBalanceRaw: snapshot.minimumBalanceRaw,
    liquidBalances: snapshot.liquidBalances.map((balance) => {
      const decimals = balance.decimals;
      const scaled =
        decimals === undefined
          ? {}
          : {
              amount: formatBaseUnits(balance.amountRaw, decimals),
              spendableAmount: formatBaseUnits(
                balance.spendableAmountRaw ?? balance.amountRaw,
                decimals,
              ),
            };
      // Human units + usdValue first so models do not treat amountRaw as the
      // display quantity when writing tables or sizing in prose.
      return {
        assetId: balance.assetId,
        symbol: balance.symbol,
        decimals,
        ...scaled,
        usdValue: balance.usdValue ?? null,
        amountRaw: balance.amountRaw,
        spendableAmountRaw: balance.spendableAmountRaw,
        frozen: balance.frozen,
      };
    }),
    protocols: snapshot.protocols,
    positions: snapshot.positions.map((position) => ({
      protocol: position.protocol,
      positionType: position.positionType,
      positionId: position.positionId,
      opportunityId: position.opportunityId,
      assetId: position.assetId,
      assetSymbol: position.assetSymbol,
      amountRaw: position.amountRaw,
      amount: position.amount,
      usdValue: position.usdValue,
      healthFactor: position.healthFactor,
      compatibleExitShapeKeys: position.compatibleExitShapeKeys,
      compatibleManageShapeKeys: position.compatibleManageShapeKeys,
    })),
  };
}

function stripPaymentNoise(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(stripPaymentNoise);
  }
  const record = { ...(value as Record<string, unknown>) };
  delete record.mcpPayment;
  delete record.paymentRequired;
  delete record.paymentRequiredHeader;
  delete record.paymentResponseHeader;
  for (const [key, nested] of Object.entries(record)) {
    if (nested && typeof nested === "object") {
      record[key] = stripPaymentNoise(nested);
    }
  }
  return record;
}

function assertRequiredCapabilities(
  tools: McpToolDefinition[],
  signingEnabled: boolean,
): void {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const contracts: Record<string, string[]> = {
    canix_get_positions: ["address"],
    canix_list_opportunities: [],
    canix_search_opportunities: [],
    canix_get_personalized_opportunities: ["address"],
    canix_list_execution_shapes: [],
    canix_get_quote: ["address", "fromAssetId", "toAssetId", "amount"],
    ...(signingEnabled
      ? {
          canix_get_execution_quote: ["quotes"],
          canix_optin: ["address", "quote"],
          canix_swap: ["address", "quote", "slippage"],
        }
      : {}),
  };
  const missing = Object.keys(contracts).filter((name) => !byName.has(name));
  const incompatible = Object.entries(contracts).flatMap(
    ([name, requiredProperties]) => {
      const tool = byName.get(name);
      if (!tool) {
        return [];
      }
      const properties = schemaProperties(tool.inputSchema);
      return requiredProperties.every((property) => properties.has(property))
        ? []
        : [name];
    },
  );
  if (signingEnabled) {
    const properties = byName.get("canix_get_execution_quote")?.inputSchema
      .properties as Record<string, unknown> | undefined;
    const quotesSchema = properties?.quotes;
    const quoteItemProperties =
      quotesSchema &&
      typeof quotesSchema === "object" &&
      "items" in quotesSchema &&
      quotesSchema.items &&
      typeof quotesSchema.items === "object"
        ? schemaProperties(quotesSchema.items as Record<string, unknown>)
        : new Set<string>();
    if (
      !quoteItemProperties.has("shapeKey") ||
      !quoteItemProperties.has("input")
    ) {
      incompatible.push("canix_get_execution_quote");
    }
  }
  if (missing.length > 0 || incompatible.length > 0) {
    const details = [
      missing.length > 0 ? `missing: ${missing.join(", ")}` : undefined,
      incompatible.length > 0
        ? `incompatible schemas: ${[...new Set(incompatible)].join(", ")}`
        : undefined,
    ].filter(Boolean);
    throw new Error(
      `Canix402 MCP capability check failed (${details.join("; ")})`,
    );
  }
}

function schemaProperties(schema: Record<string, unknown>): Set<string> {
  if (!schema.properties || typeof schema.properties !== "object") {
    return new Set();
  }
  return new Set(Object.keys(schema.properties));
}

function parseArguments(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    const message = safeErrorMessage(error);
    console.error(
      `[portfolio-agent] Failed to parse tool arguments JSON: ${message}`,
    );
    console.error(`[portfolio-agent] Raw tool arguments: ${truncateForLog(text)}`);
    throw new Error(
      `Portfolio agent returned invalid tool arguments (JSON parse failed: ${message})`,
      { cause: error },
    );
  }
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  if (!parsed.success) {
    const details = formatZodIssues(parsed.error);
    console.error(
      `[portfolio-agent] Tool arguments schema validation failed: ${details}`,
    );
    console.error(`[portfolio-agent] Raw tool arguments: ${truncateForLog(text)}`);
    throw new Error(
      `Portfolio agent returned invalid tool arguments: ${details}`,
    );
  }
  return parsed.data;
}

/** Prefer raw JSON, then fenced ```json, then the outermost `{...}` object. */
export function extractStructuredPlanText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("{")) {
    return trimmed;
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const inner = fenced[1].trim();
    if (inner.length > 0) {
      return inner;
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return trimmed;
}

type ParsePlanOutcome =
  | { ok: true; plan: PortfolioPlan }
  | { ok: false; planRawText: string; planParseError: string };

const PLAN_WRAPPER_KEYS = new Set([
  "portfolio_plan",
  "plan",
  "portfolioPlan",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Accept finite numbers and numeric strings models often emit ("0.72", "12.5").
 * Strips a trailing % before parsing.
 */
function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim().replace(/%$/, "");
    if (trimmed.length === 0) {
      return undefined;
    }
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

/** Confidence is 0–1; coerce "0.7", "70%", or 70 → 0.7. */
function asConfidence(value: unknown): number | undefined {
  const raw = asNumber(value);
  if (raw === undefined) {
    return undefined;
  }
  if (raw > 1 && raw <= 100) {
    return raw / 100;
  }
  return raw;
}

function coerceHoldDecisions(value: unknown): string[] | undefined {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((item) => {
    if (typeof item === "string") {
      return item;
    }
    if (!isPlainObject(item)) {
      return JSON.stringify(item);
    }
    const id =
      asString(item.positionId) ??
      asString(item.opportunityId) ??
      asString(item.id) ??
      "unknown";
    const reason =
      asString(item.reason) ??
      asString(item.rationale) ??
      asString(item.why) ??
      JSON.stringify(item);
    return `${id}: ${reason}`;
  });
}

function coerceAuthorizedSpend(
  spend: unknown,
): Record<string, unknown> | undefined {
  if (!isPlainObject(spend)) {
    return undefined;
  }
  const next = { ...spend };
  if (next.assetId === undefined && next.fromAssetId !== undefined) {
    next.assetId = next.fromAssetId;
  }
  return next;
}

function coerceAllocation(allocation: unknown): unknown {
  if (!isPlainObject(allocation)) {
    return allocation;
  }
  const next: Record<string, unknown> = { ...allocation };
  if (next.key === undefined) {
    const alias =
      asString(next.label) ?? asString(next.name) ?? asString(next.id);
    if (alias) {
      next.key = alias;
    }
  }
  if (!("protocol" in next)) {
    next.protocol = null;
  }
  if (!("opportunityId" in next)) {
    next.opportunityId = null;
  }
  if (!Array.isArray(next.assetIds)) {
    next.assetIds = [];
  }
  if (!("expectedApyPct" in next) || typeof next.expectedApyPct === "string") {
    const apy =
      asNumber(next.expectedApyPct) ??
      asNumber(next.apy) ??
      asNumber(next.apyPct);
    next.expectedApyPct = apy ?? null;
  }
  if (next.weightPct === undefined || typeof next.weightPct === "string") {
    const weight =
      asNumber(next.weightPct) ?? asNumber(next.weight) ?? asNumber(next.pct);
    if (weight !== undefined) {
      next.weightPct = weight;
    }
  }
  return next;
}

function coerceAction(action: unknown): unknown {
  if (!isPlainObject(action)) {
    return action;
  }
  const next: Record<string, unknown> = { ...action };
  if (next.id === undefined) {
    const alias = asString(next.actionId) ?? asString(next.action_id);
    if (alias) {
      next.id = alias;
    }
  }
  if (next.rationale === undefined) {
    const alias = asString(next.reason);
    if (alias) {
      next.rationale = alias;
    }
  }
  for (const key of [
    "protocol",
    "opportunityId",
    "positionId",
    "amountRaw",
    "fromAssetId",
    "toAssetId",
    "targetWeightPct",
    "executionShapeKey",
    "executionInput",
  ] as const) {
    if (!(key in next)) {
      next[key] = null;
    }
  }
  if (!Array.isArray(next.dependencies)) {
    next.dependencies = [];
  }
  if (Array.isArray(next.authorizedSpends)) {
    next.authorizedSpends = next.authorizedSpends
      .map(coerceAuthorizedSpend)
      .filter((spend): spend is Record<string, unknown> => spend !== undefined);
  } else if (!("authorizedSpends" in next)) {
    next.authorizedSpends = [];
  }
  return next;
}

/**
 * Normalize common LLM schema drift before Zod validation.
 * Does not invent action types or executionShapeKey values.
 */
export function coercePortfolioPlanValue(raw: unknown): unknown {
  let value = raw;
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && PLAN_WRAPPER_KEYS.has(keys[0]!)) {
      const wrapped = value[keys[0]!];
      if (isPlainObject(wrapped)) {
        value = wrapped;
      }
    }
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const next: Record<string, unknown> = { ...value };
  const summarySource = next.summary;

  if (Array.isArray(next.currentAllocations)) {
    next.currentAllocations = next.currentAllocations.map(coerceAllocation);
  } else {
    next.currentAllocations = [];
  }
  if (Array.isArray(next.targetAllocations)) {
    next.targetAllocations = next.targetAllocations.map(coerceAllocation);
  } else {
    next.targetAllocations = [];
  }
  if (Array.isArray(next.actions)) {
    next.actions = next.actions.map(coerceAction);
  } else {
    next.actions = [];
  }

  if (!Array.isArray(next.holdDecisions)) {
    const fromAliases =
      coerceHoldDecisions(next.noActionPositions) ??
      coerceHoldDecisions(next.holds) ??
      coerceHoldDecisions(next.rejectedCandidates);
    next.holdDecisions = fromAliases ?? [];
  }

  if (isPlainObject(summarySource)) {
    const benefit = asNumber(summarySource.totalProjectedNetBenefitUsd);
    if (next.projectedNetBenefitUsd === undefined && benefit !== undefined) {
      next.projectedNetBenefitUsd = benefit;
    }
    const serialized = JSON.stringify(summarySource);
    next.summary =
      serialized.length > 4_000 ? serialized.slice(0, 4_000) : serialized;
  } else if (typeof summarySource !== "string") {
    if (summarySource !== undefined && summarySource !== null) {
      const serialized = JSON.stringify(summarySource);
      next.summary =
        serialized.length > 4_000 ? serialized.slice(0, 4_000) : serialized;
    }
  }

  if (!Array.isArray(next.evidence)) {
    const fromRejected = coerceHoldDecisions(next.rejectedCandidates);
    const fromNotes = coerceHoldDecisions(next.concentrationNotes);
    next.evidence = fromRejected ?? fromNotes ?? [];
  }
  if (!Array.isArray(next.assumptions)) {
    next.assumptions = [];
  }
  if (!Array.isArray(next.risks)) {
    next.risks = [];
  }

  if (next.holdingHorizonDays === undefined) {
    next.holdingHorizonDays = 30;
  } else {
    const horizon = asNumber(next.holdingHorizonDays);
    if (horizon !== undefined) {
      next.holdingHorizonDays = Math.max(1, Math.round(horizon));
    }
  }
  if (next.estimatedOneTimeCostsUsd === undefined) {
    next.estimatedOneTimeCostsUsd = 0;
  } else {
    const costs = asNumber(next.estimatedOneTimeCostsUsd);
    if (costs !== undefined) {
      next.estimatedOneTimeCostsUsd = costs;
    }
  }
  const confidence = asConfidence(next.confidence);
  next.confidence = confidence ?? 0.5;
  if (!("currentAnnualizedReturnPct" in next)) {
    next.currentAnnualizedReturnPct = null;
  } else if (next.currentAnnualizedReturnPct !== null) {
    const current = asNumber(next.currentAnnualizedReturnPct);
    next.currentAnnualizedReturnPct =
      current !== undefined ? current : next.currentAnnualizedReturnPct;
  }
  if (!("targetAnnualizedReturnPct" in next)) {
    next.targetAnnualizedReturnPct = null;
  } else if (next.targetAnnualizedReturnPct !== null) {
    const target = asNumber(next.targetAnnualizedReturnPct);
    next.targetAnnualizedReturnPct =
      target !== undefined ? target : next.targetAnnualizedReturnPct;
  }
  if (next.projectedNetBenefitUsd === undefined) {
    next.projectedNetBenefitUsd = 0;
  } else {
    const benefit = asNumber(next.projectedNetBenefitUsd);
    if (benefit !== undefined) {
      next.projectedNetBenefitUsd = benefit;
    }
  }
  if (typeof next.summary !== "string" || next.summary.length === 0) {
    next.summary = "Agent returned a plan without a string summary.";
  }

  return next;
}

function parsePlan(text: string | undefined): PortfolioPlan {
  if (!text) {
    throw new Error("Portfolio agent returned no structured plan");
  }
  const candidate = extractStructuredPlanText(text);
  let value: unknown;
  try {
    value = JSON.parse(candidate) as unknown;
  } catch (error) {
    const message = safeErrorMessage(error);
    console.error(
      `[portfolio-agent] Failed to parse structured plan JSON: ${message}`,
    );
    console.error(`[portfolio-agent] Raw plan text: ${truncateForLog(text)}`);
    throw new Error(
      `Portfolio agent returned an invalid structured plan (JSON parse failed: ${message})`,
      { cause: error },
    );
  }
  const coerced = coercePortfolioPlanValue(value);
  const parsed = portfolioPlanSchema.safeParse(coerced);
  if (!parsed.success) {
    const details = formatZodIssues(parsed.error);
    console.error(
      `[portfolio-agent] Structured plan schema validation failed: ${details}`,
    );
    console.error(`[portfolio-agent] Raw plan text: ${truncateForLog(text)}`);
    throw new Error(
      `Portfolio agent returned an invalid structured plan: ${details}`,
    );
  }
  return parsed.data;
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function truncateForLog(text: string, maxLength = 4_000): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}… [truncated ${text.length - maxLength} chars]`;
}

function safeErrorMessage(error: unknown): string {
  return sanitizeErrorMessage(error);
}

function collectOpportunities(payload: unknown, target: Opportunity[]): void {
  if (!payload || typeof payload !== "object") {
    return;
  }
  const data = (payload as Record<string, unknown>).data;
  if (!Array.isArray(data)) {
    return;
  }
  for (const item of data) {
    const parsed = opportunitySchema.safeParse(item);
    if (
      parsed.success &&
      !target.some(
        (candidate) =>
          candidate.opportunityId === parsed.data.opportunityId &&
          candidate.protocol === parsed.data.protocol,
      )
    ) {
      target.push(parsed.data);
    }
  }
}

/** Log-safe tool args: drop payment signatures and truncate long strings. */
export function sanitizeToolArgsForLog(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (/payment|signature|mnemonic|private/i.test(key)) {
      next[key] = "[redacted]";
      continue;
    }
    if (typeof value === "string" && value.length > 200) {
      next[key] = `${value.slice(0, 200)}…`;
      continue;
    }
    next[key] = value;
  }
  return next;
}

/** Match Canix CDN/edge 504 timeouts already retried by the client. */
function isGatewayTimeoutToolError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message;
  return (
    message.includes("GATEWAY_CLIENT_ERROR") &&
    (/\bstatus=504\b/.test(message) || /\bgot 504\b/.test(message))
  );
}

function allocationJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      key: { type: "string" },
      protocol: { type: ["string", "null"] },
      opportunityId: { type: ["string", "null"] },
      assetIds: { type: "array", items: { type: "integer", minimum: 0 } },
      weightPct: { type: "number", minimum: 0, maximum: 100 },
      expectedApyPct: { type: ["number", "null"] },
    },
    required: [
      "key",
      "protocol",
      "opportunityId",
      "assetIds",
      "weightPct",
      "expectedApyPct",
    ],
  };
}
