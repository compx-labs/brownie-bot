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

const SKIPPABLE_RESEARCH_TOOLS = new Set(["canix_get_protocol_opportunities"]);

const responseSchema = z
  .object({
    id: z.string().min(1),
    output: z.array(z.unknown()),
    output_text: z.string().optional(),
  })
  .passthrough();

const functionCallSchema = z.object({
  type: z.literal("function_call"),
  call_id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.string(),
});

export interface ResponsesClient {
  responses: {
    create(request: unknown): Promise<unknown>;
  };
}

export interface PortfolioAgentResult {
  snapshot: PortfolioSnapshot;
  plan: PortfolioPlan;
  opportunities: Opportunity[];
  payments: PaymentReceipt[];
  toolCalls: string[];
}

export interface PortfolioAgent {
  run(): Promise<PortfolioAgentResult>;
}

export interface PortfolioHostGuidance {
  maxPositionPct: number;
  maxProtocolPct: number;
  minLiquidReservePct: number;
  minTvlUsd: number;
  maxSourceAgeHours: number;
  minProjectedNetImprovementUsd: number;
}

const FINAL_EXECUTION_TOOLS = new Set([
  "canix_get_execution_quote",
  "canix_optin",
  "canix_swap",
]);

export interface PortfolioAgentOptions {
  model: string;
  reasoningEffort: "low" | "medium" | "high";
  maxToolCalls: number;
  walletAddress: string;
  hostGuidance: PortfolioHostGuidance;
  signingEnabled: boolean;
}

export const PORTFOLIO_AGENT_PROMPT_V1 = `You are Brownie, an autonomous Algorand treasury portfolio manager that runs once per day.

OBJECTIVE
Maximize the treasury's expected net return over time after fees, slippage, x402 costs, switching costs, and material risk—not headline APY alone. Preserve enough liquidity for operations and maintain diversification; never place the portfolio into one position or protocol merely because it advertises the highest yield.

HOST GUIDANCE (plan toward these; they inform your allocations and do not need to be gamed)
The host supplies numeric guidance in the task input (maxPositionPct, maxProtocolPct, minLiquidReservePct, minTvlUsd, maxSourceAgeHours, minProjectedNetImprovementUsd). Prefer target allocations that keep any single deployed (protocol != null) position and any single protocol at or below those caps. Liquid wallet holdings (protocol=null) are the reserve: they may be any share from minLiquidReservePct up to nearly 100% and are not limited by maxPositionPct. Only propose non-hold actions when projected net benefit clears the guidance floor. Prefer opportunities that meet TVL and freshness guidance. The host still hard-enforces executable structure (valid dependencies that reference other action ids in this plan, execution shapes, spends within balances) when signing is enabled.

REQUIRED WORKFLOW
1. The host calls canix_get_positions and reads liquid Algorand balances before you begin. Inspect the supplied snapshot: open protocol positions (including compatibleExitShapeKeys / compatibleManageShapeKeys), LP tokens, lending/staking deposits, debts, rewards, valuations, protocol availability, caveats, liquid balances, and available exit paths. Never treat a null value or partial/unavailable protocol result as zero or as a complete portfolio. If caveats mark the snapshot incomplete, prefer hold or clearly justified exits unless evidence is strong.
2. Research broadly. Use personalized opportunities for assets already held, then use global, protocol, and filtered/search tools to find better uses of capital, including opportunities that require changing asset exposure through a supported Haystack route. Prefer opportunities with executionReady=true and a non-empty executionShapes array (enter shapes from Canix). Treat empty executionShapes as research-only—do not invent shape keys.
3. Compare the current portfolio with a diversified target portfolio. You may choose to hold, claim, open, increase, reduce, close, or swap when supported. Set dependencies only to other action ids in this plan (for example a swap that must finish before an open). Preserve the guided liquid reserve.
4. There is no minimum holding period. Re-evaluate every held position on each run. Exit, reduce, claim, or rotate when rewards end, APY collapses, risk worsens, or a clearly better risk-adjusted use of capital appears after fees and slippage. Avoid churn only when the expected net improvement is small versus costs—not because a position is "too new."
5. Produce a coherent action plan with current and target allocations, integer base-unit amounts, and an exhaustive authorizedSpends list for every asset the treasury will transfer in each action. Include expected return impact, costs, dependencies, rationale, risks, and evidence from tool results. Use holdingHorizonDays as the assumed window for projecting net benefit of today's plan—not as a lock-up that prevents later exits.
6. Execution wiring from Canix facts only:
   - open/increase: set executionShapeKey to a shapeKey from that opportunity's executionShapes (never invent). Merge that shape's inputHints into executionInput and supply base-unit amounts for requiredInputs. The host expands multi-step enter shapes (ordered by executionShapes.order) at quote time.
   - If liquid balances lack any requiredAssetIds for the chosen enter shape(s), emit prior Haystack swap action(s) (fromAssetId/toAssetId/amountRaw) and list those action ids in dependencies.
   - reduce/close/claim: set executionShapeKey from the position's compatibleExitShapeKeys or compatibleManageShapeKeys.
   - Swaps use canix_get_quote for planning; do not call canix_get_execution_quote, canix_swap, or canix_optin for final groups—the host does that only when signing is enabled. Do not claim a transaction has executed.

DECISION RULES
- Plan within host guidance; do not alter inputs to evade structural checks.
- Treat APY/APR as variable estimates. Consider TVL, freshness, protocol and asset concentration, impermanent loss, smart-contract risk, liquidity, slippage, and incomplete data. Prefer exiting a dead or collapsing yield position over waiting.
- Use only tool facts. Never invent balances, positions, prices, supported execution paths, safety claims, or transactions.
- Never request or reveal a mnemonic, private key, payment signature, signed transaction, API key, or secret.
- Never change the managed wallet. Holding is valid when evidence is insufficient or net improvement is not compelling.

FINAL OUTPUT
Return the required structured plan with current and target allocations, ordered actions, hold decisions, expected annualized return before and after, one-time costs, projected net benefit over the plan's assumed holdingHorizonDays, evidence, assumptions, risks, confidence, and concise summary.`;

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
    assertRequiredCapabilities(
      discoveredTools,
      this.options.signingEnabled,
    );
    const definitions = prepareAgentTools(discoveredTools).filter(
      (tool) =>
        this.options.signingEnabled || !FINAL_EXECUTION_TOOLS.has(tool.name),
    );
    const { snapshot, payments } = await this.portfolioReader.read();
    const tools = definitions.map(toOpenAiTool);
    const toolCalls: string[] = ["canix_get_positions"];
    const opportunities: Opportunity[] = [];
    let response = responseSchema.parse(
      await this.openai.responses.create({
        model: this.options.model,
        instructions: PORTFOLIO_AGENT_PROMPT_V1,
        input: JSON.stringify({
          task: "Research and produce today's portfolio plan.",
          managedWallet: this.options.walletAddress,
          hostGuidance: this.options.hostGuidance,
          portfolioSnapshot: snapshot,
        }),
        reasoning: { effort: this.options.reasoningEffort },
        tools,
        tool_choice: "auto",
        text: { format: planFormat },
      }),
    );

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
        return {
          snapshot,
          plan: parsePlan(response.output_text),
          opportunities,
          payments,
          toolCalls,
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
        const args = parseArguments(call.arguments);
        if (
          !this.options.signingEnabled &&
          FINAL_EXECUTION_TOOLS.has(call.name)
        ) {
          outputs.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify({
              error: "EXECUTION_DISABLED",
              message:
                "Final execution tools are unavailable while transaction signing is disabled",
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
            output: JSON.stringify(result.data),
          });
        } catch (error) {
          if (!SKIPPABLE_RESEARCH_TOOLS.has(call.name)) {
            throw error;
          }
          const message = safeErrorMessage(error);
          console.error(
            `[portfolio-agent] Skipping ${call.name}: ${message}`,
          );
          toolCalls.push(call.name);
          outputs.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify({
              error: "TOOL_UNAVAILABLE",
              tool: call.name,
              message,
              skipped: true,
            }),
          });
        }
      }
      response = responseSchema.parse(
        await this.openai.responses.create({
          model: this.options.model,
          previous_response_id: response.id,
          input: outputs,
          reasoning: { effort: this.options.reasoningEffort },
          tools,
          tool_choice: "auto",
          text: { format: planFormat },
        }),
      );
    }
  }
}

export function createPortfolioAgent(
  apiKey: string,
  canix: Canix402Client,
  portfolioReader: PortfolioReader,
  options: PortfolioAgentOptions,
): OpenAiPortfolioAgent {
  return new OpenAiPortfolioAgent(
    new OpenAI({ apiKey }),
    canix,
    portfolioReader,
    options,
  );
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
  try {
    const value = JSON.parse(text) as unknown;
    return z.record(z.string(), z.unknown()).parse(value);
  } catch {
    throw new Error("Portfolio agent returned invalid tool arguments");
  }
}

function parsePlan(text: string | undefined): PortfolioPlan {
  if (!text) {
    throw new Error("Portfolio agent returned no structured plan");
  }
  try {
    return portfolioPlanSchema.parse(JSON.parse(text));
  } catch {
    throw new Error("Portfolio agent returned an invalid structured plan");
  }
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
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
