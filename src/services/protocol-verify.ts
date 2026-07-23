import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type { ProtocolVerifyConfig } from "../cli/config.js";
import type {
  Opportunity,
  OpportunityExecutionShape,
  PortfolioAction,
  PortfolioPlan,
  PortfolioSnapshot,
  Position,
} from "../domain.js";
import { AlgorandExecutionService } from "../integrations/algorand/execution.js";
import { LocalFolksEscrowStore } from "../integrations/algorand/folks-escrow-store.js";
import { AlgorandPortfolioReader } from "../integrations/algorand/portfolio.js";
import {
  Canix402Client,
  McpSdkToolCaller,
} from "../integrations/canix402/client.js";
import { AlgorandPaymentBuilder } from "../integrations/canix402/payment.js";
import { walletFromMnemonic } from "../integrations/canix402/wallet.js";
import { PortfolioPolicy, normalizePortfolioPlan } from "./portfolio-policy.js";

export const ALGO_ASSET_ID = 0;
export const USDC_ASSET_ID = 31_566_704;
export const FOLKS_XALGO_ASSET_ID = 1_134_696_561;
/** Myth Finance dualSTAKE paired ASA used by the verify suite. */
export const ORA_ASSET_ID = 1_284_444_444;
export const FOLKS_XALGO_STAKE_SHAPE =
  "mainnet:folks-finance:xalgo-v1:stake:immediate";
/** Exists in Canix registry with opportunityRole=exit; not attached to opportunity enter shapes. */
export const FOLKS_XALGO_UNSTAKE_SHAPE =
  "mainnet:folks-finance:xalgo-v1:unstake:immediate";
export const FOLKS_USDC_WITHDRAW_SHAPE =
  "mainnet:folks-finance:v2:withdraw:escrow";
export const RETI_STAKE_SHAPE = "mainnet:reti:v1:stake:algo";
export const RETI_UNSTAKE_SHAPE = "mainnet:reti:v1:unstake:algo";
/** Stable verify pin — ungated validator the TEST_WALLET can enter. */
export const RETI_VERIFY_OPPORTUNITY_ID = "reti-staking-220";
export const MYTH_MINT_SHAPE =
  "mainnet:myth-finance:dualstake-v1:mint:lst";
export const MYTH_REDEEM_SHAPE =
  "mainnet:myth-finance:dualstake-v1:redeem:lst";
export const ALGO_DECIMALS = 6;
export const USDC_DECIMALS = 6;
export const ORA_DECIMALS = 6;
/** Protocol verify ignores research freshness; some venues lag for days. */
export const PROTOCOL_VERIFY_MAX_SOURCE_AGE_HOURS = 24 * 365;

export const PROTOCOL_VERIFY_CASE_IDS = [
  "folks-usdc-deposit",
  "folks-algo-stake",
  "tinyman-lp",
  // tinyman-lp-farm — deferred until Canix exposes farm stake/unstake shapes
  "compx-lending",
  "dorkfi-usdc-lending",
  "pact-lp",
  "haystack-swap",
  "reti-pooling",
  "myth-dualstake",
] as const;

export type ProtocolVerifyCaseId = (typeof PROTOCOL_VERIFY_CASE_IDS)[number];

const shapeSummarySchema = z.object({
  shapeKey: z.string().min(1),
  action: z.string().min(1),
  variant: z.string().min(1),
  order: z.number().int().nonnegative(),
  requiredInputs: z.array(z.string()),
  requiredAssetIds: z.array(z.number().int().nonnegative()),
  inputHints: z.record(z.string(), z.unknown()).optional(),
});

export const pinnedCaseSchema = z.object({
  caseId: z.enum(PROTOCOL_VERIFY_CASE_IDS),
  opportunityId: z.string().min(1).nullable(),
  protocol: z.string().min(1).nullable(),
  opportunityType: z.string().min(1).nullable(),
  assetPair: z.string().min(1).nullable(),
  assetIds: z.array(z.number().int().nonnegative()).default([]),
  enterShapeKey: z.string().min(1).nullable(),
  exitShapeKey: z.string().min(1).nullable(),
  /** LST receipt ASA (xALGO / tALGO); set for stake cases that have no Canix position. */
  receiptAssetId: z.number().int().positive().nullable().optional(),
  fromAssetId: z.number().int().nonnegative().nullable().optional(),
  toAssetId: z.number().int().nonnegative().nullable().optional(),
  shapes: z.array(shapeSummarySchema).default([]),
  notes: z.string().optional(),
});

export type PinnedProtocolCase = z.infer<typeof pinnedCaseSchema>;

export const protocolVerifyFixtureSchema = z.object({
  fetchedAt: z.string().min(1),
  walletAddress: z.string().min(1),
  cases: z.record(z.enum(PROTOCOL_VERIFY_CASE_IDS), pinnedCaseSchema),
});

export type ProtocolVerifyFixture = z.infer<typeof protocolVerifyFixtureSchema>;

export const DEFAULT_PROTOCOL_VERIFY_FIXTURE_PATH = path.join(
  "tests",
  "fixtures",
  "protocol-verify-opportunities.json",
);

const PREREQUISITE_ACTIONS = new Set([
  "setup",
  "optin",
  "create",
  "create-escrow",
]);

const ENTER_ACTION_HINTS = [
  "deposit",
  "addliquidity",
  "add_liquidity",
  "stake",
  "mint",
  "supply",
  "lend",
];

const EXIT_ACTION_HINTS = [
  "withdraw",
  "removeliquidity",
  "remove_liquidity",
  "unstake",
  "redeem",
];

export function toBaseUnits(amount: number, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = BigInt(Math.floor(amount));
  const fraction = amount - Math.floor(amount);
  const fractionUnits = BigInt(Math.round(fraction * Number(scale)));
  return (whole * scale + fractionUnits).toString();
}

export function spendableRaw(
  snapshot: PortfolioSnapshot,
  assetId: number,
): bigint {
  const balance = snapshot.liquidBalances.find(
    (entry) => entry.assetId === assetId,
  );
  if (!balance) {
    return 0n;
  }
  return BigInt(balance.spendableAmountRaw ?? balance.amountRaw);
}

export function requireSpendable(
  snapshot: PortfolioSnapshot,
  assetId: number,
  neededRaw: string,
  label: string,
): void {
  const available = spendableRaw(snapshot, assetId);
  if (available < BigInt(neededRaw)) {
    throw new Error(
      `Underfunded for ${label}: need ${neededRaw} of asset ${assetId}, have ${available.toString()} spendable`,
    );
  }
}

export function isPrerequisiteShape(shape: OpportunityExecutionShape): boolean {
  return (
    PREREQUISITE_ACTIONS.has(shape.action.toLowerCase()) ||
    /setup|optin|create/i.test(shape.action) ||
    /setup|opt/i.test(shape.variant)
  );
}

export function isCapitalEnterShape(shape: OpportunityExecutionShape): boolean {
  if (isPrerequisiteShape(shape)) {
    return false;
  }
  const key = `${shape.action}:${shape.variant}`.toLowerCase();
  if (/unstake|redeem|remove|withdraw|burn/.test(key)) {
    return false;
  }
  return ENTER_ACTION_HINTS.some((hint) => key.includes(hint));
}

export function isExitShape(shape: OpportunityExecutionShape): boolean {
  if (isPrerequisiteShape(shape)) {
    return false;
  }
  const key = `${shape.action}:${shape.variant}`.toLowerCase();
  return EXIT_ACTION_HINTS.some((hint) => key.includes(hint));
}

export function pickCapitalEnterShape(
  opportunity: Opportunity,
): OpportunityExecutionShape | undefined {
  const shapes = [...opportunity.executionShapes].sort(
    (left, right) =>
      left.order - right.order || left.shapeKey.localeCompare(right.shapeKey),
  );
  return (
    shapes.find(isCapitalEnterShape) ??
    shapes.find((shape) => !isPrerequisiteShape(shape))
  );
}

export function pickExitShapeKey(
  opportunity: Opportunity,
  preferredKey?: string | null,
): string | null {
  if (preferredKey) {
    return preferredKey;
  }
  const exit = opportunity.executionShapes.find(isExitShape);
  return exit?.shapeKey ?? null;
}

export function isLstUnstakeShape(shape: OpportunityExecutionShape): boolean {
  if (isPrerequisiteShape(shape)) {
    return false;
  }
  const key = `${shape.action}:${shape.variant}:${shape.shapeKey}`.toLowerCase();
  return /unstake|redeem|burn|claim/.test(key);
}

export function pickLstUnstakeShape(
  opportunity: Opportunity,
): OpportunityExecutionShape | undefined {
  return opportunity.executionShapes.find(isLstUnstakeShape);
}

/**
 * LST receipt ASA for algo staking.
 * Folks/Tinyman: first non-ALGO, non-USDC asset.
 * Myth dualSTAKE: assetIds are [ALGO, paired ASA, LST] — use index 2.
 */
export function resolveLstReceiptAssetId(
  opportunity: Opportunity,
  preferred?: number | null,
): number | null {
  if (preferred && preferred > 0) {
    return preferred;
  }
  if (protocolIncludes(opportunity, "myth")) {
    const lst = opportunity.assetIds?.[2];
    if (lst !== undefined && lst > 0) {
      return lst;
    }
  }
  for (const assetId of opportunity.assetIds ?? []) {
    if (assetId > 0 && assetId !== USDC_ASSET_ID && assetId !== ORA_ASSET_ID) {
      return assetId;
    }
  }
  for (const assetId of opportunity.assetIds ?? []) {
    if (assetId > 0 && assetId !== USDC_ASSET_ID) {
      return assetId;
    }
  }
  return null;
}

function retiMinAmountMicroAlgos(opportunity: Opportunity): bigint | null {
  const raw = opportunity.entryRequirements?.minAmount?.amount;
  if (!raw || !/^[0-9]+$/.test(raw)) {
    return null;
  }
  return BigInt(raw);
}

function retiAcceptsStake(opportunity: Opportunity): boolean {
  return opportunity.capacity?.acceptingStake !== false;
}

function retiHasAsaGate(opportunity: Opportunity): boolean {
  return (
    opportunity.entryRequirements?.gates?.some((gate) => gate.kind === "asa") ===
    true
  );
}

function retiFitsAlgoBudget(
  opportunity: Opportunity,
  algoBudgetRaw: string,
): boolean {
  const min = retiMinAmountMicroAlgos(opportunity);
  if (min === null) {
    return true;
  }
  return min <= BigInt(algoBudgetRaw);
}

function summarizeRetiNotes(opportunity: Opportunity): string {
  const parts = [
    "Réti consensus staking (no LST); exit via Canix position unstake shape",
  ];
  const min = opportunity.entryRequirements?.minAmount?.amount;
  if (min) {
    parts.push(`minEntryStake=${min} µALGO`);
  }
  if (retiHasAsaGate(opportunity)) {
    const gates = opportunity.entryRequirements?.gates
      ?.filter((gate) => gate.kind === "asa")
      .map((gate) => {
        const assetId = (gate as { assetId?: unknown }).assetId;
        return typeof assetId === "number" ? String(assetId) : "?";
      })
      .join(",");
    parts.push(
      `ASA-gated (eligibilityFullyCheckable=${String(
        opportunity.entryRequirements?.eligibilityFullyCheckable ?? false,
      )}; gates=${gates ?? "?"})`,
    );
  } else {
    parts.push("ungated");
  }
  return parts.join("; ");
}

function hasAlgoUsdcPair(opportunity: Opportunity): boolean {
  const ids = new Set(opportunity.assetIds ?? []);
  if (ids.has(ALGO_ASSET_ID) && ids.has(USDC_ASSET_ID)) {
    return true;
  }
  return /algo.*usdc|usdc.*algo/i.test(opportunity.assetPair);
}

function hasUsdc(opportunity: Opportunity): boolean {
  if (opportunity.assetIds?.includes(USDC_ASSET_ID)) {
    return true;
  }
  return /usdc/i.test(opportunity.assetPair);
}

function hasAlgoOnly(opportunity: Opportunity): boolean {
  const ids = opportunity.assetIds ?? [];
  if (ids.includes(ALGO_ASSET_ID) && !ids.includes(USDC_ASSET_ID)) {
    return true;
  }
  return /^algo$/i.test(opportunity.assetPair.trim());
}

function protocolIncludes(opportunity: Opportunity, needle: string): boolean {
  return opportunity.protocol.toLowerCase().includes(needle.toLowerCase());
}

function isExecutionReady(opportunity: Opportunity): boolean {
  return opportunity.executionReady && opportunity.executionShapes.length > 0;
}

function summarizeShapes(
  opportunity: Opportunity,
): PinnedProtocolCase["shapes"] {
  return [...opportunity.executionShapes]
    .sort(
      (left, right) =>
        left.order - right.order || left.shapeKey.localeCompare(right.shapeKey),
    )
    .map((shape) => ({
      shapeKey: shape.shapeKey,
      action: shape.action,
      variant: shape.variant,
      order: shape.order,
      requiredInputs: shape.requiredInputs,
      requiredAssetIds: shape.requiredAssetIds,
      inputHints: shape.inputHints
        ? { ...(shape.inputHints as Record<string, unknown>) }
        : undefined,
    }));
}

function pinFromOpportunity(
  caseId: ProtocolVerifyCaseId,
  opportunity: Opportunity,
  extras: Partial<PinnedProtocolCase> = {},
): PinnedProtocolCase {
  const enter = pickCapitalEnterShape(opportunity);
  const exit = opportunity.executionShapes.find(isExitShape);
  return pinnedCaseSchema.parse({
    caseId,
    opportunityId: opportunity.opportunityId,
    protocol: opportunity.protocol,
    opportunityType: opportunity.opportunityType,
    assetPair: opportunity.assetPair,
    assetIds: opportunity.assetIds ?? [],
    enterShapeKey: enter?.shapeKey ?? null,
    exitShapeKey: exit?.shapeKey ?? null,
    shapes: summarizeShapes(opportunity),
    ...extras,
  });
}

export function matchProtocolVerifyCases(
  opportunities: Opportunity[],
  options: { algoBudgetRaw?: string } = {},
): Partial<Record<ProtocolVerifyCaseId, PinnedProtocolCase>> {
  const ready = opportunities.filter(isExecutionReady);
  const matched: Partial<Record<ProtocolVerifyCaseId, PinnedProtocolCase>> = {};
  const algoBudgetRaw =
    options.algoBudgetRaw ?? toBaseUnits(1, ALGO_DECIMALS);

  const folksUsdc = ready.find(
    (opportunity) =>
      protocolIncludes(opportunity, "folks") &&
      hasUsdc(opportunity) &&
      opportunity.executionShapes.some(
        (shape) => isCapitalEnterShape(shape) && /deposit/i.test(shape.action),
      ),
  );
  if (folksUsdc) {
    matched["folks-usdc-deposit"] = pinFromOpportunity(
      "folks-usdc-deposit",
      folksUsdc,
      {
        // Withdraw is a Canix registry exit shape (not on opportunity enter shapes).
        exitShapeKey: FOLKS_USDC_WITHDRAW_SHAPE,
        notes:
          "Folks lending enter is sequential escrow; exit quotes withdraw:escrow by key",
      },
    );
  }

  const folksStake = ready.find(
    (opportunity) =>
      protocolIncludes(opportunity, "folks") &&
      hasAlgoOnly(opportunity) &&
      opportunity.executionShapes.some(
        (shape) =>
          isCapitalEnterShape(shape) &&
          /^stake$/i.test(shape.action),
      ),
  );
  if (folksStake) {
    const receiptAssetId =
      resolveLstReceiptAssetId(folksStake) ?? FOLKS_XALGO_ASSET_ID;
    const unstakeOnSame = pickLstUnstakeShape(folksStake);
    const unstakeElsewhere = ready.find(
      (opportunity) =>
        opportunity.opportunityId !== folksStake.opportunityId &&
        protocolIncludes(opportunity, "folks") &&
        (opportunity.assetIds?.includes(receiptAssetId) ||
          /xalgo/i.test(opportunity.assetPair)) &&
        Boolean(pickLstUnstakeShape(opportunity)),
    );
    const unstakeShape =
      unstakeOnSame ??
      (unstakeElsewhere ? pickLstUnstakeShape(unstakeElsewhere) : undefined);
    // Canix attaches stake-only to folks-staking-xalgo; unstake is a registry
    // exit shape quoted by key (see canix402 opportunity-execution-shapes).
    const exitShapeKey =
      unstakeShape?.shapeKey ??
      (receiptAssetId === FOLKS_XALGO_ASSET_ID
        ? FOLKS_XALGO_UNSTAKE_SHAPE
        : null);
    const shapes = summarizeShapes(folksStake);
    if (
      exitShapeKey &&
      !shapes.some((shape) => shape.shapeKey === exitShapeKey)
    ) {
      const donorShape = unstakeShape;
      shapes.push({
        shapeKey: exitShapeKey,
        action: donorShape?.action ?? "unstake",
        variant: donorShape?.variant ?? "immediate",
        order: donorShape?.order ?? 1,
        requiredInputs: donorShape?.requiredInputs ?? ["userAddress", "amount"],
        requiredAssetIds: donorShape?.requiredAssetIds ?? [receiptAssetId],
        inputHints: donorShape?.inputHints
          ? { ...(donorShape.inputHints as Record<string, unknown>) }
          : { assetId: receiptAssetId },
      });
    }
    matched["folks-algo-stake"] = pinnedCaseSchema.parse({
      ...pinFromOpportunity("folks-algo-stake", folksStake, {
        exitShapeKey,
        receiptAssetId,
        notes:
          "LST stake: holding xALGO is the receipt; Canix opportunity attaches stake only — unstake is registry exit shape mainnet:folks-finance:xalgo-v1:unstake:immediate",
      }),
      shapes,
    });
  }

  const tinymanLp = ready.find(
    (opportunity) =>
      protocolIncludes(opportunity, "tinyman") &&
      hasAlgoUsdcPair(opportunity) &&
      opportunity.executionShapes.some(
        (shape) =>
          isCapitalEnterShape(shape) &&
          /addliquidity|add_liquidity|liquidity/i.test(
            `${shape.action}${shape.variant}`,
          ),
      ),
  );
  if (tinymanLp) {
    matched["tinyman-lp"] = pinFromOpportunity("tinyman-lp", tinymanLp);
  }

  const compx = ready.find(
    (opportunity) =>
      protocolIncludes(opportunity, "compx") &&
      hasUsdc(opportunity) &&
      opportunity.executionShapes.some(
        (shape) =>
          isCapitalEnterShape(shape) &&
          /deposit|supply|lend/i.test(shape.action),
      ),
  );
  if (compx) {
    matched["compx-lending"] = pinFromOpportunity("compx-lending", compx);
  }

  const dorkfi = ready.find(
    (opportunity) =>
      protocolIncludes(opportunity, "dorkfi") &&
      hasUsdc(opportunity) &&
      opportunity.executionShapes.some(
        (shape) =>
          isCapitalEnterShape(shape) &&
          /deposit|supply|lend/i.test(shape.action),
      ),
  );
  if (dorkfi) {
    matched["dorkfi-usdc-lending"] = pinFromOpportunity(
      "dorkfi-usdc-lending",
      dorkfi,
    );
  }

  const pact = ready.find(
    (opportunity) =>
      protocolIncludes(opportunity, "pact") &&
      hasAlgoUsdcPair(opportunity) &&
      opportunity.executionShapes.some(
        (shape) =>
          isCapitalEnterShape(shape) &&
          /addliquidity|add_liquidity|liquidity/i.test(
            `${shape.action}${shape.variant}`,
          ),
      ),
  );
  if (pact) {
    matched["pact-lp"] = pinFromOpportunity("pact-lp", pact);
  }

  matched["haystack-swap"] = pinnedCaseSchema.parse({
    caseId: "haystack-swap",
    opportunityId: null,
    protocol: "haystack",
    opportunityType: "swap",
    assetPair: "ALGO/USDC",
    assetIds: [ALGO_ASSET_ID, USDC_ASSET_ID],
    enterShapeKey: null,
    exitShapeKey: null,
    fromAssetId: ALGO_ASSET_ID,
    toAssetId: USDC_ASSET_ID,
    shapes: [],
    notes: "Haystack swap path via canix_get_quote / canix_swap",
  });

  const retiCandidates = ready.filter(
    (opportunity) =>
      protocolIncludes(opportunity, "reti") &&
      retiAcceptsStake(opportunity) &&
      retiFitsAlgoBudget(opportunity, algoBudgetRaw) &&
      opportunity.executionShapes.some(
        (shape) =>
          isCapitalEnterShape(shape) &&
          (/stake/i.test(shape.action) ||
            shape.shapeKey === RETI_STAKE_SHAPE),
      ),
  );
  // Prefer explicit verify pin (ungated validator 220); else any ungated fit.
  const reti =
    retiCandidates.find(
      (opportunity) => opportunity.opportunityId === RETI_VERIFY_OPPORTUNITY_ID,
    ) ??
    retiCandidates.find((opportunity) => !retiHasAsaGate(opportunity)) ??
    retiCandidates[0];
  if (reti) {
    matched["reti-pooling"] = pinFromOpportunity("reti-pooling", reti, {
      exitShapeKey: RETI_UNSTAKE_SHAPE,
      notes: summarizeRetiNotes(reti),
    });
  }

  const mythCandidates = ready.filter(
    (opportunity) =>
      protocolIncludes(opportunity, "myth") &&
      (opportunity.assetIds?.includes(ORA_ASSET_ID) ?? false) &&
      opportunity.executionShapes.some(
        (shape) =>
          isCapitalEnterShape(shape) &&
          (/mint/i.test(shape.action) || shape.shapeKey === MYTH_MINT_SHAPE),
      ),
  );
  const myth =
    mythCandidates.find((opportunity) =>
      opportunity.opportunityId.startsWith("myth-staking-"),
    ) ?? mythCandidates[0];
  if (myth) {
    const receiptAssetId = resolveLstReceiptAssetId(myth);
    matched["myth-dualstake"] = pinFromOpportunity("myth-dualstake", myth, {
      exitShapeKey: MYTH_REDEEM_SHAPE,
      receiptAssetId,
      notes:
        "Myth dualSTAKE mint deposits ALGO+ORA; LST receipt is assetIds[2]; redeem is registry exit shape",
    });
  }

  return matched;
}

export function assertAllCasesPinned(
  matched: Partial<Record<ProtocolVerifyCaseId, PinnedProtocolCase>>,
): Record<ProtocolVerifyCaseId, PinnedProtocolCase> {
  const missing = PROTOCOL_VERIFY_CASE_IDS.filter((caseId) => !matched[caseId]);
  if (missing.length > 0) {
    throw new Error(
      `Protocol verify discovery missing case(s): ${missing.join(", ")}`,
    );
  }
  return matched as Record<ProtocolVerifyCaseId, PinnedProtocolCase>;
}

export async function loadProtocolVerifyFixture(
  fixturePath = DEFAULT_PROTOCOL_VERIFY_FIXTURE_PATH,
): Promise<ProtocolVerifyFixture> {
  const raw = await readFile(fixturePath, "utf8");
  return protocolVerifyFixtureSchema.parse(JSON.parse(raw));
}

export async function writeProtocolVerifyFixture(
  fixture: ProtocolVerifyFixture,
  fixturePath = DEFAULT_PROTOCOL_VERIFY_FIXTURE_PATH,
): Promise<void> {
  await mkdir(path.dirname(fixturePath), { recursive: true });
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
}

export function mergeOpportunities(
  target: Opportunity[],
  incoming: Opportunity[],
): void {
  for (const item of incoming) {
    if (
      !target.some(
        (candidate) =>
          candidate.opportunityId === item.opportunityId &&
          candidate.protocol === item.protocol,
      )
    ) {
      target.push(item);
    }
  }
}

export async function fetchProtocolOpportunities(
  canix: Canix402Client,
  protocol: string,
  walletAddress: string,
  limit = 50,
  offset = 0,
): Promise<Opportunity[]> {
  const result = await canix.callManagedTool(
    "canix_get_protocol_opportunities",
    {
      protocol,
      limit: Math.min(Math.max(1, limit), 200),
      offset: Math.max(0, offset),
      includeInactive: false,
    },
    walletAddress,
  );
  const payload = result.data as { data?: Opportunity[] };
  return Array.isArray(payload.data) ? payload.data : [];
}

/**
 * Live verify: find the pinned opportunity, paging protocol catalogs when needed
 * (Réti has many validators; top-N alone can miss a stable pin).
 */
export async function refreshPinnedOpportunity(
  canix: Canix402Client,
  walletAddress: string,
  pinned: PinnedProtocolCase,
): Promise<Opportunity> {
  if (!pinned.opportunityId) {
    throw new Error(`Case ${pinned.caseId} has no opportunityId to refresh`);
  }
  if (!pinned.protocol) {
    throw new Error(
      `Case ${pinned.caseId} has no protocol for scoped opportunity refresh`,
    );
  }
  const pageSize = 100;
  let offset = 0;
  for (let page = 0; page < 10; page += 1) {
    const catalog = await fetchProtocolOpportunities(
      canix,
      pinned.protocol,
      walletAddress,
      pageSize,
      offset,
    );
    const found = catalog.find(
      (opportunity) => opportunity.opportunityId === pinned.opportunityId,
    );
    if (found) {
      return found;
    }
    if (catalog.length < pageSize) {
      break;
    }
    offset += catalog.length;
  }
  throw new Error(
    `Pinned opportunity ${pinned.opportunityId} for case ${pinned.caseId} was not found in ${pinned.protocol} opportunities`,
  );
}

/** Full catalog scan — discovery CLI only, not per-case verify refresh. */
export async function collectDiscoveryOpportunities(
  canix: Canix402Client,
  walletAddress: string,
  limit = 50,
): Promise<Opportunity[]> {
  const opportunities: Opportunity[] = [];
  const personalized = await canix.getPersonalizedOpportunities(
    walletAddress,
    Math.min(limit, 25),
  );
  mergeOpportunities(opportunities, personalized.opportunities);

  const listed = await canix.getOpportunities(Math.min(limit, 25));
  mergeOpportunities(opportunities, listed.opportunities);

  for (const protocol of [
    "folks-finance",
    "folks",
    "tinyman",
    "compx",
    "dorkfi",
    "pact",
    "reti",
    "myth-finance",
  ]) {
    try {
      // Réti has many validators — pull a deep page so preferred pins are present.
      const protocolLimit = protocol === "reti" ? 200 : limit;
      mergeOpportunities(
        opportunities,
        await fetchProtocolOpportunities(
          canix,
          protocol,
          walletAddress,
          protocolLimit,
        ),
      );
    } catch {
      // Protocol endpoint may be unavailable; list/personalized may still cover it.
    }
  }

  return opportunities;
}

function liquidAllocation(
  snapshot: PortfolioSnapshot,
): PortfolioPlan["currentAllocations"][number] {
  return {
    key: "liquid:treasury",
    protocol: null,
    opportunityId: null,
    assetIds: snapshot.liquidBalances.map((balance) => balance.assetId),
    weightPct: 100,
    expectedApyPct: 0,
  };
}

function basePlan(actions: PortfolioAction[]): PortfolioPlan {
  return {
    currentAllocations: [],
    targetAllocations: [],
    actions,
    holdDecisions: [],
    currentAnnualizedReturnPct: 0,
    targetAnnualizedReturnPct: 1,
    estimatedOneTimeCostsUsd: 0.05,
    projectedNetBenefitUsd: 0,
    holdingHorizonDays: 1,
    evidence: ["protocol-verify deterministic plan"],
    assumptions: ["Tiny fixed sizes for protocol path verification"],
    risks: ["Mainnet execution with real funds"],
    confidence: 1,
    summary: "Deterministic protocol verification plan",
  };
}

function authorizedSpendsFromAmounts(
  amountsByAsset: Map<number, string>,
): PortfolioAction["authorizedSpends"] {
  return [...amountsByAsset.entries()]
    .filter(([, amount]) => BigInt(amount) > 0n)
    .map(([assetId, amountRaw]) => ({ assetId, amountRaw }));
}

/**
 * Agent-minimal open: shape key + spends only.
 * Host `normalizePortfolioPlan` completes executionInput from Canix shapes.
 */
export function buildEnterAction(options: {
  id: string;
  opportunity: Opportunity;
  enterShapeKey: string;
  amountsByAsset: Map<number, string>;
  rationale?: string;
}): PortfolioAction {
  if (
    !options.opportunity.executionShapes.some(
      (candidate) => candidate.shapeKey === options.enterShapeKey,
    )
  ) {
    throw new Error(
      `Enter shape ${options.enterShapeKey} missing on ${options.opportunity.opportunityId}`,
    );
  }
  const spends = authorizedSpendsFromAmounts(options.amountsByAsset);
  const primary = spends[0];
  return {
    id: options.id,
    type: "open",
    protocol: options.opportunity.protocol,
    opportunityId: options.opportunity.opportunityId,
    positionId: null,
    amountRaw: primary?.amountRaw ?? null,
    fromAssetId: primary?.assetId ?? null,
    toAssetId: null,
    targetWeightPct: 10,
    executionShapeKey: options.enterShapeKey,
    executionInput: null,
    authorizedSpends: spends,
    rationale: options.rationale ?? `Protocol verify enter ${options.id}`,
    dependencies: [],
  };
}

/**
 * Agent-minimal close: position + exit shape key + amount.
 * Host `normalizePortfolioPlan` completes executionInput from Canix shapes.
 */
export function buildExitAction(options: {
  id: string;
  position: Position;
  opportunity: Opportunity;
  exitShapeKey: string;
  /** When set (e.g. Folks verify), withdraw this underlying amount instead of position.amountRaw. */
  withdrawAmountRaw?: string;
  rationale?: string;
}): PortfolioAction {
  const amountRaw = options.withdrawAmountRaw ?? options.position.amountRaw;
  return {
    id: options.id,
    type: "close",
    protocol: options.position.protocol,
    opportunityId:
      options.position.opportunityId ?? options.opportunity.opportunityId,
    positionId: options.position.positionId,
    amountRaw,
    fromAssetId: options.position.assetId,
    toAssetId: null,
    targetWeightPct: null,
    executionShapeKey: options.exitShapeKey,
    executionInput: null,
    authorizedSpends: [],
    rationale: options.rationale ?? `Protocol verify exit ${options.id}`,
    dependencies: [],
  };
}

/**
 * Unstake / redeem an LST receipt (xALGO, tALGO, …). Modeled as an open against
 * the unstake shape because Canix does not expose these as portfolio positions.
 * Agent-minimal: host completes executionInput.
 */
export function buildLstUnstakeAction(options: {
  id: string;
  opportunity: Opportunity;
  unstakeShapeKey: string;
  receiptAssetId: number;
  amountRaw: string;
  rationale?: string;
}): PortfolioAction {
  if (
    !options.opportunity.executionShapes.some(
      (candidate) => candidate.shapeKey === options.unstakeShapeKey,
    )
  ) {
    throw new Error(
      `Unstake shape ${options.unstakeShapeKey} missing on ${options.opportunity.opportunityId}`,
    );
  }
  return {
    id: options.id,
    type: "open",
    protocol: options.opportunity.protocol,
    opportunityId: options.opportunity.opportunityId,
    positionId: null,
    amountRaw: options.amountRaw,
    fromAssetId: options.receiptAssetId,
    toAssetId: null,
    targetWeightPct: 10,
    executionShapeKey: options.unstakeShapeKey,
    executionInput: null,
    authorizedSpends: [
      { assetId: options.receiptAssetId, amountRaw: options.amountRaw },
    ],
    rationale:
      options.rationale ??
      `Protocol verify LST unstake ${options.id} (receipt ASA ${options.receiptAssetId})`,
    dependencies: [],
  };
}

export function buildSwapAction(options: {
  id: string;
  fromAssetId: number;
  toAssetId: number;
  amountRaw: string;
  rationale?: string;
}): PortfolioAction {
  return {
    id: options.id,
    type: "swap",
    protocol: "haystack",
    opportunityId: null,
    positionId: null,
    amountRaw: options.amountRaw,
    fromAssetId: options.fromAssetId,
    toAssetId: options.toAssetId,
    targetWeightPct: null,
    executionShapeKey: null,
    executionInput: null,
    authorizedSpends: [
      { assetId: options.fromAssetId, amountRaw: options.amountRaw },
    ],
    rationale: options.rationale ?? `Protocol verify swap ${options.id}`,
    dependencies: [],
  };
}

export function verifyPolicyConfig(): ConstructorParameters<
  typeof PortfolioPolicy
>[0] {
  return {
    maxPositionPct: 100,
    maxProtocolPct: 100,
    minLiquidReservePct: 0,
    minTvlUsd: 0,
    // Prove execution shapes, not research freshness (some venues lag for days).
    maxSourceAgeHours: PROTOCOL_VERIFY_MAX_SOURCE_AGE_HOURS,
    minProjectedNetImprovementUsd: 0,
    signingEnabled: true,
    // Canix may mark protocols partial for unpriced farm rewards; still execute.
    blockIncompleteSnapshot: false,
  };
}

export function validateAndNormalizePlan(
  snapshot: PortfolioSnapshot,
  plan: PortfolioPlan,
  opportunities: Opportunity[],
): PortfolioPlan {
  const normalized = normalizePortfolioPlan(plan, opportunities, snapshot);
  const liquid = liquidAllocation(snapshot);
  const opportunityAction = normalized.actions.find(
    (action) =>
      action.opportunityId && ["open", "increase"].includes(action.type),
  );
  const targetAllocations =
    normalized.targetAllocations.length > 0
      ? normalized.targetAllocations
      : opportunityAction
        ? [
            { ...liquid, weightPct: 90 },
            {
              key: `opportunity:${opportunityAction.opportunityId}`,
              protocol: opportunityAction.protocol,
              opportunityId: opportunityAction.opportunityId,
              assetIds:
                opportunityAction.fromAssetId !== null
                  ? [opportunityAction.fromAssetId]
                  : [],
              weightPct: 10,
              expectedApyPct: 1,
            },
          ]
        : [{ ...liquid, weightPct: 100 }];
  const withAllocations: PortfolioPlan = {
    ...normalized,
    currentAllocations:
      normalized.currentAllocations.length > 0
        ? normalized.currentAllocations
        : [liquid],
    targetAllocations,
  };
  const policy = new PortfolioPolicy(verifyPolicyConfig());
  const result = policy.validate(snapshot, withAllocations, opportunities);
  if (!result.approved) {
    throw new Error(
      `Protocol verify policy rejected plan: ${result.violations.join("; ")}`,
    );
  }
  return withAllocations;
}

export function findPositionForOpportunity(
  snapshot: PortfolioSnapshot,
  opportunityId: string,
  protocol?: string | null,
): Position | undefined {
  return snapshot.positions.find((position) => {
    if (protocol && position.protocol !== protocol) {
      return false;
    }
    return position.opportunityId === opportunityId;
  });
}

export function resolveExitShapeKey(
  position: Position,
  preferred?: string | null,
): string {
  const allowed = [
    ...position.compatibleExitShapeKeys,
    ...position.compatibleManageShapeKeys,
  ];
  if (preferred && allowed.includes(preferred)) {
    return preferred;
  }
  const ranked = allowed.find((key) =>
    EXIT_ACTION_HINTS.some((hint) => key.toLowerCase().includes(hint)),
  );
  const chosen = ranked ?? allowed[0];
  if (!chosen) {
    throw new Error(
      `Position ${position.positionId} has no compatible exit/manage shape keys`,
    );
  }
  return chosen;
}

export function resolveVerifyExitShapeKey(
  pinned: PinnedProtocolCase,
  position: Position,
): string {
  if (pinned.exitShapeKey) {
    return pinned.exitShapeKey;
  }
  try {
    return resolveExitShapeKey(position, null);
  } catch {
    if (pinned.caseId === "folks-usdc-deposit") {
      return FOLKS_USDC_WITHDRAW_SHAPE;
    }
    throw new Error(
      `No exit shape for ${pinned.caseId} / position ${position.positionId}`,
    );
  }
}

export interface ProtocolVerifyContext {
  config: ProtocolVerifyConfig;
  canix: Canix402Client;
  walletAddress: string;
  portfolioReader: AlgorandPortfolioReader;
  executor: AlgorandExecutionService;
  close: () => Promise<void>;
}

export function createProtocolVerifyContext(
  config: ProtocolVerifyConfig,
): ProtocolVerifyContext {
  const wallet = walletFromMnemonic(config.TEST_MNEMONIC);
  const caller = new McpSdkToolCaller(new URL(config.CANIX402_MCP_URL));
  const paymentBuilder = new AlgorandPaymentBuilder(wallet, {
    algodUrl: config.X402_ALGOD_URL,
    maxDailyBaseUnits: BigInt(config.MAX_DAILY_X402_BASE_UNITS),
  });
  const canix = new Canix402Client(caller, paymentBuilder);
  const portfolioReader = new AlgorandPortfolioReader(
    canix,
    config.TEST_WALLET,
    config.X402_ALGOD_URL,
    PROTOCOL_VERIFY_MAX_SOURCE_AGE_HOURS,
  );
  const escrowStore = new LocalFolksEscrowStore(config.FOLKS_ESCROW_DATA_DIR);
  const executor = new AlgorandExecutionService(
    canix,
    wallet,
    config.TEST_WALLET,
    config.X402_ALGOD_URL,
    {
      signingEnabled: true,
      maxSlippageBps: config.MAX_SLIPPAGE_BPS,
      maxPriceImpactPct: config.MAX_PRICE_IMPACT_PCT,
    },
    escrowStore,
  );
  return {
    config,
    canix,
    walletAddress: config.TEST_WALLET,
    portfolioReader,
    executor,
    close: async () => {
      await canix.close();
    },
  };
}

export function amountsForCase(
  config: ProtocolVerifyConfig,
  caseId: ProtocolVerifyCaseId,
): Map<number, string> {
  const algoRaw = toBaseUnits(
    config.PROTOCOL_VERIFY_AMOUNT_ALGO,
    ALGO_DECIMALS,
  );
  const usdcRaw = toBaseUnits(
    config.PROTOCOL_VERIFY_AMOUNT_USDC,
    USDC_DECIMALS,
  );
  const amounts = new Map<number, string>();
  switch (caseId) {
    case "folks-algo-stake":
    case "haystack-swap":
      amounts.set(ALGO_ASSET_ID, algoRaw);
      break;
    case "reti-pooling": {
      // First stake into a Réti pool funds pool MBR from the payment; staking
      // exactly minEntryStake (often 1 ALGO) then fails simulate (assert).
      const retiAlgo = Math.max(config.PROTOCOL_VERIFY_AMOUNT_ALGO, 2);
      amounts.set(ALGO_ASSET_ID, toBaseUnits(retiAlgo, ALGO_DECIMALS));
      break;
    }
    case "myth-dualstake":
      // Mint amount is ALGO; paired ORA size is derived at quote time.
      amounts.set(ALGO_ASSET_ID, algoRaw);
      break;
    case "folks-usdc-deposit":
    case "compx-lending":
    case "dorkfi-usdc-lending":
      amounts.set(USDC_ASSET_ID, usdcRaw);
      break;
    case "tinyman-lp":
    case "pact-lp":
      amounts.set(ALGO_ASSET_ID, algoRaw);
      amounts.set(USDC_ASSET_ID, usdcRaw);
      break;
    default:
      amounts.set(USDC_ASSET_ID, usdcRaw);
  }
  return amounts;
}

async function executeConfirmed(
  context: ProtocolVerifyContext,
  action: PortfolioAction,
  opportunities: Opportunity[],
): Promise<void> {
  const { outcome } = await context.executor.executeAction(action, {
    opportunities,
  });
  if (outcome.status !== "confirmed") {
    throw new Error(
      `Action ${action.id} expected confirmed, got ${outcome.status}${
        outcome.error ? `: ${outcome.error}` : ""
      }`,
    );
  }
}

async function readSnapshot(
  context: ProtocolVerifyContext,
): Promise<PortfolioSnapshot> {
  const { snapshot } = await context.portfolioReader.read();
  return snapshot;
}

export async function runEnterExitCase(
  context: ProtocolVerifyContext,
  pinned: PinnedProtocolCase,
): Promise<void> {
  const opportunity = await refreshPinnedOpportunity(
    context.canix,
    context.walletAddress,
    pinned,
  );
  const enterShapeKey =
    pinned.enterShapeKey ?? pickCapitalEnterShape(opportunity)?.shapeKey;
  if (!enterShapeKey) {
    throw new Error(`No enter shape for case ${pinned.caseId}`);
  }

  const amounts = amountsForCase(context.config, pinned.caseId);
  let snapshot = await readSnapshot(context);
  for (const [assetId, amountRaw] of amounts) {
    requireSpendable(snapshot, assetId, amountRaw, pinned.caseId);
  }

  const enter = buildEnterAction({
    id: `${pinned.caseId}-enter`,
    opportunity,
    enterShapeKey,
    amountsByAsset: amounts,
  });
  const enterPlan = validateAndNormalizePlan(
    snapshot,
    basePlan([enter]),
    [opportunity],
  );
  await executeConfirmed(context, enterPlan.actions[0]!, [opportunity]);

  snapshot = await readSnapshot(context);
  const position = findPositionForOpportunity(
    snapshot,
    opportunity.opportunityId,
    opportunity.protocol,
  );
  if (!position) {
    throw new Error(
      `After enter, no position found for ${opportunity.opportunityId}`,
    );
  }

  const exitShapeKey = resolveVerifyExitShapeKey(
    pinned,
    position,
  );
  // Folks: withdraw the same underlying we just deposited (Canix live tests use
  // amountDenomination=asset). Position amountRaw can be fAsset and overshoot.
  const withdrawAmountRaw =
    pinned.caseId === "folks-usdc-deposit"
      ? [...amounts.values()][0]
      : undefined;
  const exit = buildExitAction({
    id: `${pinned.caseId}-exit`,
    position,
    opportunity,
    exitShapeKey,
    ...(withdrawAmountRaw !== undefined ? { withdrawAmountRaw } : {}),
  });
  const exitPlan = validateAndNormalizePlan(
    snapshot,
    basePlan([exit]),
    [opportunity],
  );
  await executeConfirmed(context, exitPlan.actions[0]!, [opportunity]);
}

/**
 * Folks / Tinyman ALGO staking: success is holding the LST receipt ASA
 * (xALGO / tALGO), not a Canix position row. Exit burns/redeems that ASA.
 */
export async function runLstStakeCase(
  context: ProtocolVerifyContext,
  pinned: PinnedProtocolCase,
): Promise<void> {
  let opportunity = await refreshPinnedOpportunity(
    context.canix,
    context.walletAddress,
    pinned,
  );
  const enterShapeKey =
    pinned.enterShapeKey ?? pickCapitalEnterShape(opportunity)?.shapeKey;
  if (!enterShapeKey) {
    throw new Error(`No enter shape for LST stake case ${pinned.caseId}`);
  }

  const receiptAssetId = resolveLstReceiptAssetId(
    opportunity,
    pinned.receiptAssetId,
  );
  if (!receiptAssetId) {
    throw new Error(
      `LST stake case ${pinned.caseId} has no receipt ASA (expected xALGO/tALGO on opportunity.assetIds)`,
    );
  }

  // Resolve unstake key up front, but do not attach the exit shape to the
  // opportunity until after stake — enter must never quote unstake.
  const unstakeShapeKey =
    pinned.exitShapeKey ??
    pickLstUnstakeShape(opportunity)?.shapeKey ??
    (receiptAssetId === FOLKS_XALGO_ASSET_ID
      ? FOLKS_XALGO_UNSTAKE_SHAPE
      : null);
  if (!unstakeShapeKey) {
    throw new Error(
      `LST stake case ${pinned.caseId} has no unstake/redeem shape for receipt ${receiptAssetId}`,
    );
  }

  const amounts = amountsForCase(context.config, pinned.caseId);
  let snapshot = await readSnapshot(context);
  for (const [assetId, amountRaw] of amounts) {
    requireSpendable(snapshot, assetId, amountRaw, pinned.caseId);
  }
  if (pinned.caseId === "myth-dualstake") {
    const oraRaw = toBaseUnits(
      context.config.PROTOCOL_VERIFY_AMOUNT_ORA,
      ORA_DECIMALS,
    );
    requireSpendable(snapshot, ORA_ASSET_ID, oraRaw, pinned.caseId);
  }
  const receiptBefore = spendableRaw(snapshot, receiptAssetId);

  // Stake-only opportunity for enter (strip any exit shapes from the pin).
  const enterOpportunity: Opportunity = {
    ...opportunity,
    executionShapes: opportunity.executionShapes.filter(
      (shape) => !isLstUnstakeShape(shape) && !isExitShape(shape),
    ),
  };
  if (
    !enterOpportunity.executionShapes.some(
      (shape) => shape.shapeKey === enterShapeKey,
    )
  ) {
    throw new Error(
      `Enter shape ${enterShapeKey} missing after stripping exit shapes for ${pinned.caseId}`,
    );
  }

  const enter = buildEnterAction({
    id: `${pinned.caseId}-enter`,
    opportunity: enterOpportunity,
    enterShapeKey,
    amountsByAsset: amounts,
  });
  await executeConfirmed(
    context,
    validateAndNormalizePlan(
      snapshot,
      basePlan([enter]),
      [enterOpportunity],
    ).actions[0]!,
    [enterOpportunity],
  );

  snapshot = await readSnapshot(context);
  const receiptAfterEnter = spendableRaw(snapshot, receiptAssetId);
  if (receiptAfterEnter <= receiptBefore) {
    throw new Error(
      `After LST stake, expected receipt ASA ${receiptAssetId} balance to increase (before=${receiptBefore}, after=${receiptAfterEnter})`,
    );
  }

  // Unstake only what this stake minted (leave any prior residual xALGO/tALGO).
  const minted = receiptAfterEnter - receiptBefore;
  if (minted <= 0n) {
    throw new Error(
      `LST stake minted non-positive receipt amount for ${pinned.caseId}`,
    );
  }

  opportunity = await ensureUnstakeShapeOnOpportunity(
    context,
    opportunity,
    unstakeShapeKey,
    receiptAssetId,
  );
  const exit = buildLstUnstakeAction({
    id: `${pinned.caseId}-exit`,
    opportunity,
    unstakeShapeKey,
    receiptAssetId,
    amountRaw: minted.toString(),
  });
  await executeConfirmed(
    context,
    validateAndNormalizePlan(
      snapshot,
      basePlan([exit]),
      [opportunity],
    ).actions[0]!,
    [opportunity],
  );

  snapshot = await readSnapshot(context);
  const receiptAfterExit = spendableRaw(snapshot, receiptAssetId);
  if (receiptAfterExit >= receiptAfterEnter) {
    throw new Error(
      `After LST unstake, expected receipt ASA ${receiptAssetId} balance to decrease (before=${receiptAfterEnter}, after=${receiptAfterExit})`,
    );
  }
}

async function ensureUnstakeShapeOnOpportunity(
  context: ProtocolVerifyContext,
  opportunity: Opportunity,
  preferredExitShapeKey: string | null | undefined,
  receiptAssetId: number,
): Promise<Opportunity> {
  const knownExit =
    preferredExitShapeKey ??
    (receiptAssetId === FOLKS_XALGO_ASSET_ID
      ? FOLKS_XALGO_UNSTAKE_SHAPE
      : null);

  if (
    (knownExit &&
      opportunity.executionShapes.some(
        (shape) => shape.shapeKey === knownExit,
      )) ||
    pickLstUnstakeShape(opportunity)
  ) {
    return opportunity;
  }

  // Folks xALGO unstake is a Canix registry exit shape, not attached to the
  // staking opportunity's executionShapes (stake-only enter path).
  if (knownExit === FOLKS_XALGO_UNSTAKE_SHAPE) {
    return {
      ...opportunity,
      executionShapes: [
        ...opportunity.executionShapes,
        {
          shapeKey: FOLKS_XALGO_UNSTAKE_SHAPE,
          protocol: "folks-finance",
          protocolVersion: "xalgo-v1",
          action: "unstake",
          variant: "immediate",
          title: "Folks Finance xALGO immediate unstake",
          summary: "Burn xALGO to redeem ALGO from Folks Finance liquid staking",
          order: 1,
          requiredInputs: ["userAddress", "amount"],
          requiredAssetIds: [FOLKS_XALGO_ASSET_ID],
          inputHints: { assetId: FOLKS_XALGO_ASSET_ID },
        },
      ],
    };
  }

  // Myth redeem lives on compatibleExitShapes (not in brownie opportunity schema).
  if (knownExit === MYTH_REDEEM_SHAPE) {
    const appId =
      typeof opportunity.executionShapes[0]?.inputHints?.poolAppId === "number"
        ? opportunity.executionShapes[0].inputHints.poolAppId
        : typeof opportunity.executionShapes[0]?.inputHints?.appId === "number"
          ? opportunity.executionShapes[0].inputHints.appId
          : undefined;
    return {
      ...opportunity,
      executionShapes: [
        ...opportunity.executionShapes,
        {
          shapeKey: MYTH_REDEEM_SHAPE,
          protocol: "myth-finance",
          protocolVersion: "dualstake-v1",
          action: "redeem",
          variant: "lst",
          title: "Myth Finance dualSTAKE redeem LST",
          summary:
            "Burn dualSTAKE LST to redeem ALGO and paired ASA from Myth Finance",
          order: 1,
          requiredInputs: ["userAddress", "amount", "appId"],
          requiredAssetIds: [receiptAssetId],
          inputHints: {
            assetId: receiptAssetId,
            ...(appId !== undefined ? { poolAppId: appId, appId } : {}),
          },
        },
      ],
    };
  }

  const catalog = await fetchProtocolOpportunities(
    context.canix,
    opportunity.protocol,
    context.walletAddress,
    50,
  );
  const donor = catalog.find((candidate) => {
    const sameFamily =
      protocolIncludes(candidate, "folks") ||
      protocolIncludes(candidate, opportunity.protocol);
    if (!sameFamily) {
      return false;
    }
    if (preferredExitShapeKey) {
      return candidate.executionShapes.some(
        (shape) => shape.shapeKey === preferredExitShapeKey,
      );
    }
    return (
      Boolean(pickLstUnstakeShape(candidate)) &&
      (candidate.assetIds?.includes(receiptAssetId) ||
        /xalgo|talgo/i.test(candidate.assetPair))
    );
  });

  const unstake =
    (preferredExitShapeKey
      ? donor?.executionShapes.find(
          (shape) => shape.shapeKey === preferredExitShapeKey,
        )
      : undefined) ?? (donor ? pickLstUnstakeShape(donor) : undefined);

  if (!unstake) {
    return opportunity;
  }

  return {
    ...opportunity,
    executionShapes: [...opportunity.executionShapes, unstake],
  };
}

export async function runHaystackSwapCase(
  context: ProtocolVerifyContext,
): Promise<void> {
  const algoRaw = toBaseUnits(
    context.config.PROTOCOL_VERIFY_AMOUNT_ALGO,
    ALGO_DECIMALS,
  );
  let snapshot = await readSnapshot(context);
  requireSpendable(snapshot, ALGO_ASSET_ID, algoRaw, "haystack-swap forward");

  const forward = buildSwapAction({
    id: "haystack-algo-to-usdc",
    fromAssetId: ALGO_ASSET_ID,
    toAssetId: USDC_ASSET_ID,
    amountRaw: algoRaw,
  });
  await executeConfirmed(
    context,
    validateAndNormalizePlan(
      snapshot,
      basePlan([forward]),
      [],
    ).actions[0]!,
    [],
  );

  snapshot = await readSnapshot(context);
  // Fixed size — never round-trip the entire USDC balance (fees/rounding underflow).
  const backAmount = toBaseUnits(
    context.config.PROTOCOL_VERIFY_AMOUNT_USDC,
    USDC_DECIMALS,
  );
  requireSpendable(snapshot, USDC_ASSET_ID, backAmount, "haystack-swap back");

  const back = buildSwapAction({
    id: "haystack-usdc-to-algo",
    fromAssetId: USDC_ASSET_ID,
    toAssetId: ALGO_ASSET_ID,
    amountRaw: backAmount,
  });
  await executeConfirmed(
    context,
    validateAndNormalizePlan(
      snapshot,
      basePlan([back]),
      [],
    ).actions[0]!,
    [],
  );
}

export async function runProtocolVerifyCase(
  context: ProtocolVerifyContext,
  pinned: PinnedProtocolCase,
): Promise<void> {
  switch (pinned.caseId) {
    case "haystack-swap":
      await runHaystackSwapCase(context);
      return;
    case "folks-algo-stake":
    case "myth-dualstake":
      await runLstStakeCase(context, pinned);
      return;
    default:
      await runEnterExitCase(context, pinned);
  }
}
