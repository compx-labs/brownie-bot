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
import { normalizePortfolioPlan } from "./portfolio-policy.js";

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

/** Hard cap per opportunity MCP call (API allows up to 200). */
export const MAX_OPPORTUNITY_TOOL_LIMIT = 25;

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
  plan: PortfolioPlan;
  opportunities: Opportunity[];
  payments: PaymentReceipt[];
  toolCalls: string[];
  inferenceCost?: InferenceCostSummary;
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

export const PORTFOLIO_AGENT_PROMPT_V1 = `You are Brownie, an autonomous Algorand treasury portfolio manager that runs once per day.

OBJECTIVE
Put idle capital to work. Maximize the treasury's expected net return over time after fees, slippage, x402 costs, switching costs, and material risk—not headline APY alone. Preserve the guided liquid reserve and stay diversified across positions/protocols, but do not leave large liquid balances idle when researched, executable yield exists. Prefer high-TVL, liquid venues over thin pools that advertise peak APY.

HOST GUIDANCE (plan toward these; they inform your allocations and do not need to be gamed)
The host supplies numeric guidance in the task input (maxPositionPct, maxProtocolPct, minLiquidReservePct, minTvlUsd, maxSourceAgeHours, minProjectedNetImprovementUsd). Prefer target allocations that keep any single deployed (protocol != null) position and any single protocol at or below those caps. Liquid wallet holdings (protocol=null) are an operational reserve floor (minLiquidReservePct), not a license to stay ~100% cash. Surplus liquid capital above that floor should be deployed when eligible opportunities exist. Liquid holdings are not limited by maxPositionPct. Only propose non-hold actions when projected net benefit clears the guidance floor. Prefer opportunities that meet TVL and freshness guidance; among eligible options, favor higher TVL for safety and exit liquidity. The host still hard-enforces executable structure (valid dependencies that reference other action ids in this plan, execution shapes, spends within balances) when signing is enabled.

IDLE CAPITAL (default bias: deploy)
- Compute deployable surplus = liquid share above minLiquidReservePct (and any liquid ALGO/USDC/other assets that are not needed for the reserve).
- Shared USDC ops budget: the managed wallet's liquid USDC (asset 31566704) pays both Canix402 x402 tool calls and ZeroSignal inference (host zs-proxy uses the same mnemonic as the x402 payer). Treat them as one ops sink—do not plan as if inference were a separate card or API key.
- USDC operations buffer (end-of-run target): after all planned actions settle, liquid USDC should be at least ~5 USDC (5_000_000 base units) so later Canix402 / x402 calls and ZeroSignal inference can pay. This is an ending balance target, not a freeze on deploying USDC mid-plan.
  - You may deploy or spend USDC into yield when that is the best use of capital.
  - If the projected ending liquid USDC would be below ~5 (including when starting below 5, or after deploying most USDC), add a final consolidation Haystack swap: convert a small amount of other liquid tokens (prefer deep/liquid pairs; ALGO or other stables first) into enough USDC to restore the ~5 USDC buffer. Size that swap only for the shortfall plus a small cushion for slippage/fees—do not dump large idle balances into USDC just for the buffer.
  - Put consolidation last in the action order (depend on prior opens/swaps if needed so it runs after capital deployment). Prefer a dedicated swap action id such as "consolidate-usdc-buffer".
  - If other liquid assets cannot fund the shortfall without breaking minLiquidReservePct or leaving the wallet unable to pay fees, say so in evidence and keep as much USDC as practical.
  - Never request or invent mnemonic, zs-proxy, or payment details; the host wires inference.
- If surplus is material and tool research returns executable opportunities that clear TVL, freshness, and net-benefit guidance, prefer opening/increasing (with swaps if needed) over a pure hold.
- A pure hold / no-op is allowed only when you can justify it: name the best candidates you considered (protocol, opportunityId, APY, TVL, executionReady) and why each failed (TVL, stale data, research-only shapes, net benefit below floor, concentration, incomplete snapshot, or missing from tools after required searches).
- Incomplete snapshot caveats raise caution for exits and sizing; they do not automatically justify leaving surplus idle if other protocols still return executable enter paths.

REQUIRED WORKFLOW
1. The host calls canix_get_positions and reads liquid Algorand balances before you begin. Inspect the supplied snapshot: open protocol positions (including compatibleExitShapeKeys / compatibleManageShapeKeys), LP tokens, lending/staking deposits, debts, rewards, valuations, protocol availability, caveats, liquid balances, and available exit paths. Never treat a null value or partial/unavailable protocol result as zero or as a complete portfolio. For liquidBalances, amountRaw/spendableAmountRaw are integer on-chain base units; amount/spendableAmount are host-scaled human units using decimals (e.g. USDC decimals=6 so amountRaw "30000000" means amount "30"). Use amount for sizing judgment; use amountRaw in plan authorizedSpends and executionInput. Never rescale amountRaw by inventing decimals.
2. Research with both personalization and high-TVL discovery (do not skip either). The host caps each opportunity tool to at most 25 rows and returns a compact payload—request only what you need (prefer limit ≤ 25, sort/filter toward high TVL and executionReady):
   - Always call canix_get_personalized_opportunities for the managed wallet so recommendations match assets already held.
   - Always use canix_search_opportunities (and/or list/filter) sorted or filtered toward the highest-TVL opportunities that meet minTvlUsd—use this for safety reasoning and better liquidity, not only for peak APY.
   - Also use global/protocol tools for better uses of capital, including opportunities that need a Haystack swap first. Do not favor any named protocol over others; choose from tool facts by TVL, readiness, net benefit, and concentration.
   - Prefer opportunities with executionReady=true and a non-empty executionShapes array. Treat empty executionShapes as research-only—do not invent shape keys. If the best asset-matched venues are missing or research-only, retry search/protocol queries before concluding no-op; record what the tools returned.
   - Do not call OpenAPI, discovery, metadata, health, or strategy tools—the host does not expose them.
3. Compare the current portfolio with a diversified target that deploys surplus above the reserve. You may hold, claim, open, increase, reduce, close, or swap when supported. Set dependencies only to other action ids in this plan (for example a swap that must finish before an open). Keep at least minLiquidReservePct liquid; ensure ending liquid USDC is ~5+ (for Canix402 x402 and ZeroSignal inference) via deployment sizing and/or a final USDC consolidation swap when short.
4. There is no minimum holding period. Re-evaluate every held position on each run. Exit, reduce, claim, or rotate when rewards end, APY collapses, risk worsens, or a clearly better risk-adjusted use of capital appears after fees and slippage. Avoid churn only when the expected net improvement is small versus costs—not because a position is "too new."
5. Produce a coherent action plan with current and target allocations, integer base-unit amounts, and an exhaustive authorizedSpends list for every asset the treasury will transfer in each action. Include expected return impact, costs, dependencies, rationale, risks, and evidence from tool results. Use holdingHorizonDays as the assumed window for projecting net benefit of today's plan—not as a lock-up that prevents later exits.
6. Net benefit math (be honest; idle APY is ~0):
   projectedNetBenefitUsd ≈ sum over deployments of (deployedUsd × (targetApyPct − currentApyPct) / 100 × holdingHorizonDays / 365) − estimatedOneTimeCostsUsd.
   Use a realistic horizon (often 30–90 days) so genuine yield on surplus capital is not understated into a false no-op.
   For lending/deposit yields, use the opportunity's base supply/deposit APY (or APR when yieldBasis says so) from tool facts. Do not inflate projected returns with reward multipliers, boost badges, or unclear blended figures—if tools expose both a base rate and a boosted/reward rate, prefer the base lending APY for allocations and projectedNetBenefitUsd and note any rewards separately in evidence.
7. Execution wiring from Canix facts only:
   - open/increase: emit ONE action per opportunity entry. Set executionShapeKey to a capital-deploying enter shapeKey from that opportunity's executionShapes (e.g. deposit/addLiquidity—never invent). Merge that shape's inputHints into executionInput and supply base-unit amounts for requiredInputs. Put the full treasury asset transfer in that action's authorizedSpends. The host expands multi-step enter shapes (setup/escrow prerequisites ordered by executionShapes.order) at quote time—do NOT emit separate plan actions for create-escrow, setup, market opt-in, or other prerequisite shapes, and do NOT put shapeKey strings in dependencies.
   - If liquid balances lack any requiredAssetIds for the chosen enter shape(s), emit prior Haystack swap action(s) (fromAssetId/toAssetId/amountRaw), list those action ids in dependencies, and size the open's authorizedSpends to the intended deposit (existing liquid of that asset plus expected swap proceeds). The host handles ASA opt-in for swap outputs during swap execution—do NOT emit a separate opt-in plan action.
   - dependencies may ONLY list other action id strings from this plan (e.g. "swap-algo-to-usdc"). Never list executionShapeKey values, opportunityIds, or protocol setup step names.
   - reduce/close/claim: set executionShapeKey from the position's compatibleExitShapeKeys or compatibleManageShapeKeys.
   - Swaps use canix_get_quote for planning; do not call canix_get_execution_quote, canix_swap, or canix_optin for final groups—the host does that only when signing is enabled. Do not claim a transaction has executed.

DECISION RULES
- Plan within host guidance; do not alter inputs to evade structural checks.
- Bias toward deploying surplus into high-TVL, execution-ready yield; do not treat "already mostly liquid" as success.
- Among eligible opportunities, prefer higher TVL and deeper liquidity for safer entries/exits; do not chase the single highest APY in a thin pool.
- Treat APY/APR as variable estimates. Consider TVL, freshness, protocol and asset concentration, impermanent loss, smart-contract risk, liquidity, slippage, and incomplete data. Prefer exiting a dead or collapsing yield position over waiting.
- Use only tool facts. Never invent balances, positions, prices, supported execution paths, safety claims, or transactions.
- Never request or reveal a mnemonic, private key, payment signature, signed transaction, API key, or secret.
- Never change the managed wallet. Holding is valid only when surplus is immaterial, no eligible executable opportunity clears guidance after the required research, or risks clearly outweigh expected net benefit—and that case must be evidenced with named rejected candidates.

FINAL OUTPUT
Return the required structured plan with current and target allocations, ordered actions, hold decisions, expected annualized return before and after, one-time costs, projected net benefit over the plan's assumed holdingHorizonDays, evidence (include key candidates considered and pass/fail reasons), assumptions, risks, confidence, and concise summary.`;

export const PORTFOLIO_AGENT_PROMPT_LITE = `You are Brownie, an autonomous Algorand treasury portfolio manager that runs once per day.

OBJECTIVE
Put idle capital to work. Maximize the treasury's expected net return over time after fees, slippage, x402 costs, switching costs, and material risk—not headline APY alone. Preserve the guided liquid reserve and stay diversified across positions/protocols, but do not leave large liquid balances idle when researched, executable yield exists. Prefer high-TVL, liquid venues over thin pools that advertise peak APY.

HOST GUIDANCE (plan toward these; they inform your allocations and do not need to be gamed)
The host supplies numeric guidance in the task input (maxPositionPct, maxProtocolPct, minLiquidReservePct, minTvlUsd, maxSourceAgeHours, minProjectedNetImprovementUsd). Prefer target allocations that keep any single deployed (protocol != null) position and any single protocol at or below those caps. Liquid wallet holdings (protocol=null) are an operational reserve floor (minLiquidReservePct), not a license to stay ~100% cash. Surplus liquid capital above that floor should be deployed when eligible opportunities exist. Liquid holdings are not limited by maxPositionPct. Only propose non-hold actions when projected net benefit clears the guidance floor. Prefer opportunities that meet TVL and freshness guidance; among eligible options, favor higher TVL for safety and exit liquidity. The host still hard-enforces executable structure (valid dependencies that reference other action ids in this plan, execution shapes, spends within balances) when signing is enabled.

IDLE CAPITAL (default bias: deploy)
- Compute deployable surplus = liquid share above minLiquidReservePct (and any liquid ALGO/USDC/other assets that are not needed for the reserve).
- Shared USDC ops budget: the managed wallet's liquid USDC (asset 31566704) pays both Canix402 x402 tool calls and ZeroSignal inference (host zs-proxy uses the same mnemonic as the x402 payer). Treat them as one ops sink—do not plan as if inference were a separate card or API key.
- USDC operations buffer (end-of-run target): after all planned actions settle, liquid USDC should be at least ~5 USDC (5_000_000 base units) so later Canix402 / x402 calls and ZeroSignal inference can pay. This is an ending balance target, not a freeze on deploying USDC mid-plan.
  - You may deploy or spend USDC into yield when that is the best use of capital.
  - If the projected ending liquid USDC would be below ~5 (including when starting below 5, or after deploying most USDC), add a final consolidation Haystack swap: convert a small amount of other liquid tokens (prefer deep/liquid pairs; ALGO or other stables first) into enough USDC to restore the ~5 USDC buffer. Size that swap only for the shortfall plus a small cushion for slippage/fees—do not dump large idle balances into USDC just for the buffer.
  - Put consolidation last in the action order (depend on prior opens/swaps if needed so it runs after capital deployment). Prefer a dedicated swap action id such as "consolidate-usdc-buffer".
  - If other liquid assets cannot fund the shortfall without breaking minLiquidReservePct or leaving the wallet unable to pay fees, say so in evidence and keep as much USDC as practical.
  - Never request or invent mnemonic, zs-proxy, or payment details; the host wires inference.
- If surplus is material and host research returns executable opportunities that clear TVL, freshness, and net-benefit guidance, prefer opening/increasing (with swaps if needed) over a pure hold.
- A pure hold / no-op is allowed only when you can justify it: name the best candidates you considered (protocol, opportunityId, APY, TVL, executionReady) and why each failed (TVL, stale data, research-only shapes, net benefit below floor, concentration, incomplete snapshot, or missing from host research after required searches).
- Incomplete snapshot caveats raise caution for exits and sizing; they do not automatically justify leaving surplus idle if other protocols still return executable enter paths.

REQUIRED WORKFLOW
1. The host calls canix_get_positions and reads liquid Algorand balances before you begin. Inspect the supplied snapshot: open protocol positions (including compatibleExitShapeKeys / compatibleManageShapeKeys), LP tokens, lending/staking deposits, debts, rewards, valuations, protocol availability, caveats, liquid balances, and available exit paths. Never treat a null value or partial/unavailable protocol result as zero or as a complete portfolio. For liquidBalances, amountRaw/spendableAmountRaw are integer on-chain base units; amount/spendableAmount are host-scaled human units using decimals (e.g. USDC decimals=6 so amountRaw "30000000" means amount "30"). Use amount for sizing judgment; use amountRaw in plan authorizedSpends and executionInput. Never rescale amountRaw by inventing decimals.
2. The host has already researched opportunities (personalized + high-TVL list). Use the supplied researchedOpportunities / candidates only—do not call tools (none are available). Prefer opportunities with executionReady=true and a non-empty executionShapes array. Treat empty executionShapes as research-only—do not invent shape keys. Do not favor any named protocol; choose from host research by TVL, readiness, net benefit, and concentration. If the best asset-matched venues are missing or research-only, record what host research returned and justify hold vs deploy from those facts.
3. Compare the current portfolio with a diversified target that deploys surplus above the reserve. You may hold, claim, open, increase, reduce, close, or swap when supported. Set dependencies only to other action ids in this plan (for example a swap that must finish before an open). Keep at least minLiquidReservePct liquid; ensure ending liquid USDC is ~5+ (for Canix402 x402 and ZeroSignal inference) via deployment sizing and/or a final USDC consolidation swap when short.
4. There is no minimum holding period. Re-evaluate every held position on each run. Exit, reduce, claim, or rotate when rewards end, APY collapses, risk worsens, or a clearly better risk-adjusted use of capital appears after fees and slippage. Avoid churn only when the expected net improvement is small versus costs—not because a position is "too new."
5. Produce a coherent action plan with current and target allocations, integer base-unit amounts, and an exhaustive authorizedSpends list for every asset the treasury will transfer in each action. Include expected return impact, costs, dependencies, rationale, risks, and evidence from host research. Use holdingHorizonDays as the assumed window for projecting net benefit of today's plan—not as a lock-up that prevents later exits.
6. Net benefit math (be honest; idle APY is ~0):
   projectedNetBenefitUsd ≈ sum over deployments of (deployedUsd × (targetApyPct − currentApyPct) / 100 × holdingHorizonDays / 365) − estimatedOneTimeCostsUsd.
   Use a realistic horizon (often 30–90 days) so genuine yield on surplus capital is not understated into a false no-op.
   For lending/deposit yields, use the opportunity's base supply/deposit APY (or APR when yieldBasis says so) from research facts. Do not inflate projected returns with reward multipliers, boost badges, or unclear blended figures—if research exposes both a base rate and a boosted/reward rate, prefer the base lending APY for allocations and projectedNetBenefitUsd and note any rewards separately in evidence.
7. Execution wiring from Canix facts only:
   - open/increase: emit ONE action per opportunity entry. Set executionShapeKey to a capital-deploying enter shapeKey from that opportunity's executionShapes (e.g. deposit/addLiquidity—never invent). Merge that shape's inputHints into executionInput and supply base-unit amounts for requiredInputs. Put the full treasury asset transfer in that action's authorizedSpends. The host expands multi-step enter shapes (setup/escrow prerequisites ordered by executionShapes.order) at quote time—do NOT emit separate plan actions for create-escrow, setup, market opt-in, or other prerequisite shapes, and do NOT put shapeKey strings in dependencies.
   - If liquid balances lack any requiredAssetIds for the chosen enter shape(s), emit prior Haystack swap action(s) (fromAssetId/toAssetId/amountRaw), list those action ids in dependencies, and size the open's authorizedSpends to the intended deposit (existing liquid of that asset plus expected swap proceeds). The host handles ASA opt-in for swap outputs during swap execution—do NOT emit a separate opt-in plan action.
   - dependencies may ONLY list other action id strings from this plan (e.g. "swap-algo-to-usdc"). Never list executionShapeKey values, opportunityIds, or protocol setup step names.
   - reduce/close/claim: set executionShapeKey from the position's compatibleExitShapeKeys or compatibleManageShapeKeys.
   - Swaps may be planned from snapshot balances and opportunity requiredAssetIds; the host obtains final execution quotes only when signing is enabled. Do not claim a transaction has executed.

DECISION RULES
- Plan within host guidance; do not alter inputs to evade structural checks.
- Bias toward deploying surplus into high-TVL, execution-ready yield; do not treat "already mostly liquid" as success.
- Among eligible opportunities, prefer higher TVL and deeper liquidity for safer entries/exits; do not chase the single highest APY in a thin pool.
- Treat APY/APR as variable estimates. Consider TVL, freshness, protocol and asset concentration, impermanent loss, smart-contract risk, liquidity, slippage, and incomplete data. Prefer exiting a dead or collapsing yield position over waiting.
- Use only host-supplied facts. Never invent balances, positions, prices, supported execution paths, safety claims, or transactions.
- Never request or reveal a mnemonic, private key, payment signature, signed transaction, API key, or secret.
- Never change the managed wallet. Holding is valid only when surplus is immaterial, no eligible executable opportunity clears guidance after the required research, or risks clearly outweigh expected net benefit—and that case must be evidenced with named rejected candidates.

FINAL OUTPUT
Return the required structured plan with current and target allocations, ordered actions, hold decisions, expected annualized return before and after, one-time costs, projected net benefit over the plan's assumed holdingHorizonDays, evidence (include key candidates considered and pass/fail reasons), assumptions, risks, confidence, and concise summary.`;

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

    return {
      snapshot,
      plan: normalizePortfolioPlan(
        parsePlan(response.output_text),
        research.opportunities,
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
    /** When the provider omits response ids, replay the conversation explicitly. */
    let conversationItems: unknown[] = [];
    const first = await createAgentResponse(this.openai, {
      model: this.options.model,
      instructions: PORTFOLIO_AGENT_PROMPT_V1,
      input: initialInput,
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
        return {
          snapshot,
          plan: normalizePortfolioPlan(
            parsePlan(response.output_text),
            opportunities,
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
        const args = clampOpportunityToolArgs(
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
          if (!SKIPPABLE_RESEARCH_TOOLS.has(call.name)) {
            throw error;
          }
          const message = safeErrorMessage(error);
          console.error(`[portfolio-agent] Skipping ${call.name}: ${message}`);
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

      conversationItems = [...conversationItems, ...response.output, ...outputs];
      const followUp =
        response.id !== undefined
          ? {
              model: this.options.model,
              previous_response_id: response.id,
              input: outputs,
              reasoning: { effort: this.options.reasoningEffort },
              tools,
              tool_choice: "auto" as const,
              text: { format: planFormat },
            }
          : {
              model: this.options.model,
              instructions: PORTFOLIO_AGENT_PROMPT_V1,
              input: [
                { role: "user", content: initialInput },
                ...conversationItems,
              ],
              reasoning: { effort: this.options.reasoningEffort },
              tools,
              tool_choice: "auto" as const,
              text: { format: planFormat },
            };

      const next = await createAgentResponse(this.openai, followUp);
      recordInferenceCharge(inferenceCharges, next.headers);
      response = normalizeAgentResponse(next.data);
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
        "Compacted by host: sorted executionReady then TVL, capped rows, shapes trimmed to wiring fields.",
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
    executionShapes: opportunity.executionShapes.map((shape) => ({
      shapeKey: shape.shapeKey,
      action: shape.action,
      order: shape.order,
      requiredInputs: shape.requiredInputs,
      requiredAssetIds: shape.requiredAssetIds,
      inputHints: shape.inputHints,
    })),
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
      return {
        assetId: balance.assetId,
        symbol: balance.symbol,
        decimals,
        amountRaw: balance.amountRaw,
        spendableAmountRaw: balance.spendableAmountRaw,
        ...scaled,
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

/** Format integer base units with asset decimals (no float rounding). */
export function formatBaseUnits(amountRaw: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error(`Invalid decimals: ${decimals}`);
  }
  if (!/^[0-9]+$/.test(amountRaw)) {
    throw new Error(`Invalid amountRaw: ${amountRaw}`);
  }
  if (decimals === 0) {
    return amountRaw.replace(/^0+(?=\d)/, "") || "0";
  }
  const padded = amountRaw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals).replace(/^0+(?=\d)/, "") || "0";
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole;
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

function parsePlan(text: string | undefined): PortfolioPlan {
  if (!text) {
    throw new Error("Portfolio agent returned no structured plan");
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
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
  const parsed = portfolioPlanSchema.safeParse(value);
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
