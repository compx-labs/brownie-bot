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
import {
  FOLKS_ALGO_POOL_APP_ID,
  FOLKS_GENERAL_LOAN_APP_ID,
  FOLKS_USDC_POOL_APP_ID,
} from "../integrations/algorand/folks-execution.js";
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
/** CompX governance / market base ASA. */
export const COMPX_ASSET_ID = 1_732_165_149;
/** DorkFi governance / market base ASA (Algorand). */
export const UNIT_ASSET_ID = 3_121_954_282;
/** Myth Finance dualSTAKE paired ASA used by the verify suite. */
export const ORA_ASSET_ID = 1_284_444_444;
/** DorkFi Algorand pool A (USDC + UNIT markets). */
export const DORKFI_POOL_APP_ID = 3_333_688_282;
export const DORKFI_USDC_MARKET_APP_ID = 3_210_682_240;
export const DORKFI_UNIT_MARKET_APP_ID = 3_220_125_024;
export const FOLKS_XALGO_STAKE_SHAPE =
  "mainnet:folks-finance:xalgo-v1:stake:immediate";
/** Exists in Canix registry with opportunityRole=exit; not attached to opportunity enter shapes. */
export const FOLKS_XALGO_UNSTAKE_SHAPE =
  "mainnet:folks-finance:xalgo-v1:unstake:immediate";
export const FOLKS_USDC_WITHDRAW_SHAPE =
  "mainnet:folks-finance:v2:withdraw:escrow";
export const FOLKS_LOAN_SETUP_SHAPE =
  "mainnet:folks-finance:v2:setup:loanEscrow";
export const FOLKS_ADD_COLLATERAL_SHAPE =
  "mainnet:folks-finance:v2:setup:addCollateral";
export const FOLKS_COLLATERAL_SYNC_SHAPE =
  "mainnet:folks-finance:v2:collateral:sync";
export const FOLKS_BORROW_VARIABLE_SHAPE =
  "mainnet:folks-finance:v2:borrow:variable";
export const FOLKS_REPAY_SHAPE = "mainnet:folks-finance:v2:repay:withTxn";
export const FOLKS_COLLATERAL_REDUCE_SHAPE =
  "mainnet:folks-finance:v2:collateral:reduce";
export const FOLKS_DEPOSIT_SHAPE = "mainnet:folks-finance:v2:deposit:escrow";
export const COMPX_DEPOSIT_SHAPE = "mainnet:compx:v1:deposit:asa";
export const COMPX_WITHDRAW_SHAPE = "mainnet:compx:v1:withdraw:asa";
export const COMPX_BORROW_SHAPE = "mainnet:compx:v1:borrow:asa";
export const COMPX_REPAY_SHAPE = "mainnet:compx:v1:repay:asa";
export const DORKFI_DEPOSIT_SHAPE = "mainnet:dorkfi:v1:deposit:asa";
export const DORKFI_WITHDRAW_SHAPE = "mainnet:dorkfi:v1:withdraw:asa";
export const DORKFI_BORROW_SHAPE = "mainnet:dorkfi:v1:borrow:asa";
export const DORKFI_REPAY_SHAPE = "mainnet:dorkfi:v1:repay:asa";
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
export const COMPX_DECIMALS = 6;
export const UNIT_DECIMALS = 8;
export const ORA_DECIMALS = 6;
/** Protocol verify ignores research freshness; some venues lag for days. */
export const PROTOCOL_VERIFY_MAX_SOURCE_AGE_HOURS = 24 * 365;

export const PROTOCOL_VERIFY_CASE_IDS = [
  "folks-usdc-deposit",
  "folks-credit",
  "folks-algo-stake",
  "tinyman-lp",
  // tinyman-lp-farm stake/unstake verify — deferred; claimRewards is live on
  // Tinyman reward positions (compatibleManageShapeKeys).
  "compx-lending",
  "compx-credit",
  "dorkfi-usdc-lending",
  "dorkfi-credit",
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
  /** LST receipt ASA (xALGO / tALGO / cUSDC); set for stake/credit cases. */
  receiptAssetId: z.number().int().positive().nullable().optional(),
  /** Credit cases: market opportunity used for borrow/repay (COMPX / UNIT / ALGO). */
  borrowOpportunityId: z.string().min(1).nullable().optional(),
  borrowShapeKey: z.string().min(1).nullable().optional(),
  repayShapeKey: z.string().min(1).nullable().optional(),
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

function hasCompxBase(opportunity: Opportunity): boolean {
  if (opportunity.assetIds?.includes(COMPX_ASSET_ID)) {
    return true;
  }
  return /^compx$/i.test(opportunity.assetPair.trim());
}

function pickCompXBorrowShape(
  opportunity: Opportunity,
): OpportunityExecutionShape | undefined {
  return opportunity.executionShapes.find(
    (shape) =>
      /borrow/i.test(shape.action) ||
      shape.shapeKey === COMPX_BORROW_SHAPE ||
      /borrow:asa/i.test(shape.shapeKey),
  );
}

function pickCompXRepayShape(
  opportunity: Opportunity,
): OpportunityExecutionShape | undefined {
  return opportunity.executionShapes.find(
    (shape) =>
      /repay/i.test(shape.action) ||
      shape.shapeKey === COMPX_REPAY_SHAPE ||
      /repay:asa/i.test(shape.shapeKey),
  );
}

function resolveCompXReceiptAssetId(
  opportunity: Opportunity,
  pinned?: number | null,
): number | null {
  if (typeof pinned === "number" && pinned > 0) {
    return pinned;
  }
  const ids = opportunity.assetIds ?? [];
  const receipt = ids.find(
    (assetId) => assetId !== USDC_ASSET_ID && assetId !== ALGO_ASSET_ID,
  );
  return receipt ?? null;
}

function resolveCompXMarketAppId(
  opportunity: Opportunity,
  shapeKey: string,
  opportunityId: string,
): number | null {
  const hinted = opportunity.executionShapes.find(
    (shape) => shape.shapeKey === shapeKey,
  );
  const fromShape = hinted?.inputHints?.marketAppId;
  if (typeof fromShape === "number" && fromShape > 0) {
    return fromShape;
  }
  for (const shape of opportunity.executionShapes) {
    const marketAppId = shape.inputHints?.marketAppId;
    if (typeof marketAppId === "number" && marketAppId > 0) {
      return marketAppId;
    }
  }
  const match = opportunityId.match(/(\d+)$/);
  if (match) {
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

function hasUnitBase(opportunity: Opportunity): boolean {
  if (opportunity.assetIds?.includes(UNIT_ASSET_ID)) {
    return true;
  }
  if (/^unit$/i.test(opportunity.assetPair.trim())) {
    return true;
  }
  return opportunity.opportunityId.includes(`:${UNIT_ASSET_ID}:`);
}

function pickDorkFiBorrowShape(
  opportunity: Opportunity,
): OpportunityExecutionShape | undefined {
  return opportunity.executionShapes.find(
    (shape) =>
      /borrow/i.test(shape.action) ||
      shape.shapeKey === DORKFI_BORROW_SHAPE ||
      /borrow:asa/i.test(shape.shapeKey),
  );
}

function pickDorkFiRepayShape(
  opportunity: Opportunity,
): OpportunityExecutionShape | undefined {
  return opportunity.executionShapes.find(
    (shape) =>
      /repay/i.test(shape.action) ||
      shape.shapeKey === DORKFI_REPAY_SHAPE ||
      /repay:asa/i.test(shape.shapeKey),
  );
}

function resolveDorkFiHintId(
  opportunity: Opportunity,
  key: "poolAppId" | "marketAppId" | "assetId",
  shapeKey?: string,
): number | null {
  if (shapeKey) {
    const hinted = opportunity.executionShapes.find(
      (shape) => shape.shapeKey === shapeKey,
    );
    const fromShape = hinted?.inputHints?.[key];
    if (typeof fromShape === "number" && fromShape > 0) {
      return fromShape;
    }
  }
  for (const shape of opportunity.executionShapes) {
    const value = shape.inputHints?.[key];
    if (typeof value === "number" && value > 0) {
      return value;
    }
  }
  return null;
}

function resolveDorkFiPoolAppId(opportunity: Opportunity): number {
  return (
    resolveDorkFiHintId(opportunity, "poolAppId") ??
    (() => {
      const match = /^dorkfi:algorand:(\d+):/i.exec(opportunity.opportunityId);
      if (match?.[1]) {
        const parsed = Number(match[1]);
        if (Number.isFinite(parsed) && parsed > 0) {
          return parsed;
        }
      }
      return DORKFI_POOL_APP_ID;
    })()
  );
}

function resolveDorkFiMarketAppId(
  opportunity: Opportunity,
  shapeKey: string,
  fallback: number,
): number {
  return (
    resolveDorkFiHintId(opportunity, "marketAppId", shapeKey) ?? fallback
  );
}

function resolveFolksPoolAppId(opportunity: Opportunity): number | null {
  for (const shape of opportunity.executionShapes) {
    const hint = shape.inputHints?.poolAppId;
    if (typeof hint === "number" && hint > 0) {
      return hint;
    }
  }
  const match = /folks-lending-(\d{6,})/i.exec(opportunity.opportunityId);
  if (match?.[1]) {
    return Number(match[1]);
  }
  const trailing = opportunity.opportunityId.match(/(\d+)$/);
  if (trailing) {
    const parsed = Number(trailing[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
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

  const folksAlgoLend = ready.find(
    (opportunity) =>
      protocolIncludes(opportunity, "folks") &&
      opportunity.opportunityType === "lending" &&
      (opportunity.assetIds?.includes(ALGO_ASSET_ID) ?? false) &&
      !(opportunity.assetIds?.includes(USDC_ASSET_ID) ?? false) &&
      !opportunity.executionShapes.some((shape) => /stake/i.test(shape.action)),
  );
  if (folksUsdc && folksAlgoLend) {
    const usdcPoolAppId =
      resolveFolksPoolAppId(folksUsdc) ?? FOLKS_USDC_POOL_APP_ID;
    const algoPoolAppId =
      resolveFolksPoolAppId(folksAlgoLend) ?? FOLKS_ALGO_POOL_APP_ID;
    const shapes = [
      ...summarizeShapes(folksUsdc),
      ...summarizeShapes(folksAlgoLend).filter(
        (shape) =>
          !summarizeShapes(folksUsdc).some(
            (existing) => existing.shapeKey === shape.shapeKey,
          ),
      ),
    ];
    for (const registry of [
      {
        shapeKey: FOLKS_LOAN_SETUP_SHAPE,
        action: "setup",
        variant: "loanEscrow",
        order: 10,
        requiredInputs: ["userAddress", "loanAppId"],
        requiredAssetIds: [] as number[],
        inputHints: { loanAppId: FOLKS_GENERAL_LOAN_APP_ID },
      },
      {
        shapeKey: FOLKS_ADD_COLLATERAL_SHAPE,
        action: "setup",
        variant: "addCollateral",
        order: 11,
        requiredInputs: ["userAddress", "escrowAddress", "loanAppId", "poolAppId"],
        requiredAssetIds: [] as number[],
        inputHints: {
          loanAppId: FOLKS_GENERAL_LOAN_APP_ID,
          poolAppId: usdcPoolAppId,
        },
      },
      {
        shapeKey: FOLKS_COLLATERAL_SYNC_SHAPE,
        action: "collateral",
        variant: "sync",
        order: 12,
        requiredInputs: ["userAddress", "escrowAddress", "loanAppId", "poolAppId"],
        requiredAssetIds: [] as number[],
        inputHints: {
          loanAppId: FOLKS_GENERAL_LOAN_APP_ID,
          poolAppId: usdcPoolAppId,
        },
      },
      {
        shapeKey: FOLKS_BORROW_VARIABLE_SHAPE,
        action: "borrow",
        variant: "variable",
        order: 13,
        requiredInputs: [
          "userAddress",
          "escrowAddress",
          "borrowAmount",
          "loanAppId",
          "poolAppId",
        ],
        requiredAssetIds: [] as number[],
        inputHints: {
          loanAppId: FOLKS_GENERAL_LOAN_APP_ID,
          poolAppId: algoPoolAppId,
        },
      },
      {
        shapeKey: FOLKS_REPAY_SHAPE,
        action: "repay",
        variant: "withTxn",
        order: 14,
        requiredInputs: [
          "userAddress",
          "escrowAddress",
          "repayAmount",
          "loanAppId",
          "poolAppId",
        ],
        requiredAssetIds: [] as number[],
        inputHints: {
          loanAppId: FOLKS_GENERAL_LOAN_APP_ID,
          poolAppId: algoPoolAppId,
        },
      },
      {
        shapeKey: FOLKS_COLLATERAL_REDUCE_SHAPE,
        action: "collateral",
        variant: "reduce",
        order: 15,
        requiredInputs: [
          "userAddress",
          "escrowAddress",
          "amount",
          "amountDenomination",
          "loanAppId",
          "poolAppId",
        ],
        requiredAssetIds: [] as number[],
        inputHints: {
          loanAppId: FOLKS_GENERAL_LOAN_APP_ID,
          poolAppId: usdcPoolAppId,
        },
      },
      {
        shapeKey: FOLKS_USDC_WITHDRAW_SHAPE,
        action: "withdraw",
        variant: "escrow",
        order: 16,
        requiredInputs: [
          "userAddress",
          "amount",
          "amountDenomination",
          "poolAppId",
        ],
        requiredAssetIds: [USDC_ASSET_ID],
        inputHints: { poolAppId: usdcPoolAppId, assetId: USDC_ASSET_ID },
      },
    ]) {
      if (!shapes.some((shape) => shape.shapeKey === registry.shapeKey)) {
        shapes.push(registry);
      }
    }
    matched["folks-credit"] = pinnedCaseSchema.parse({
      ...pinFromOpportunity("folks-credit", folksUsdc, {
        enterShapeKey:
          pickCapitalEnterShape(folksUsdc)?.shapeKey ?? FOLKS_DEPOSIT_SHAPE,
        exitShapeKey: FOLKS_USDC_WITHDRAW_SHAPE,
        borrowOpportunityId: folksAlgoLend.opportunityId,
        borrowShapeKey: FOLKS_BORROW_VARIABLE_SHAPE,
        repayShapeKey: FOLKS_REPAY_SHAPE,
        notes:
          "Folks credit: loanEscrow → addCollateral → deposit USDC to loan → sync → borrow ALGO → repay → reduce → withdraw",
      }),
      shapes,
    });
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

  const compxBorrowMarket = ready.find(
    (opportunity) =>
      protocolIncludes(opportunity, "compx") &&
      hasCompxBase(opportunity) &&
      Boolean(pickCompXBorrowShape(opportunity)),
  );
  if (compx && compxBorrowMarket) {
    const receiptAssetId = resolveCompXReceiptAssetId(compx);
    const borrowShape = pickCompXBorrowShape(compxBorrowMarket);
    const repayShape = pickCompXRepayShape(compxBorrowMarket);
    const withdrawOnDeposit = compx.executionShapes.find(isExitShape);
    const depositShapes = summarizeShapes(compx);
    const borrowShapes = summarizeShapes(compxBorrowMarket);
    const shapes = [
      ...depositShapes,
      ...borrowShapes.filter(
        (shape) =>
          !depositShapes.some(
            (existing) => existing.shapeKey === shape.shapeKey,
          ),
      ),
    ];
    for (const registry of [
      {
        shapeKey: COMPX_BORROW_SHAPE,
        action: "borrow",
        variant: "asa",
        order: 1,
        requiredInputs: [
          "userAddress",
          "marketAppId",
          "borrowAmount",
          "collateralAmount",
        ],
        requiredAssetIds: [] as number[],
      },
      {
        shapeKey: COMPX_REPAY_SHAPE,
        action: "repay",
        variant: "asa",
        order: 2,
        requiredInputs: ["userAddress", "marketAppId", "amount"],
        requiredAssetIds: [] as number[],
      },
      {
        shapeKey: COMPX_WITHDRAW_SHAPE,
        action: "withdraw",
        variant: "asa",
        order: 3,
        requiredInputs: ["userAddress", "marketAppId", "amount"],
        requiredAssetIds: [] as number[],
      },
    ]) {
      if (!shapes.some((shape) => shape.shapeKey === registry.shapeKey)) {
        shapes.push(registry);
      }
    }
    matched["compx-credit"] = pinnedCaseSchema.parse({
      ...pinFromOpportunity("compx-credit", compx, {
        enterShapeKey:
          pickCapitalEnterShape(compx)?.shapeKey ?? COMPX_DEPOSIT_SHAPE,
        exitShapeKey: withdrawOnDeposit?.shapeKey ?? COMPX_WITHDRAW_SHAPE,
        receiptAssetId,
        borrowOpportunityId: compxBorrowMarket.opportunityId,
        borrowShapeKey: borrowShape?.shapeKey ?? COMPX_BORROW_SHAPE,
        repayShapeKey: repayShape?.shapeKey ?? COMPX_REPAY_SHAPE,
        notes:
          "CompX credit: deposit USDC → borrow COMPX against cUSDC → repay → withdraw",
      }),
      shapes,
    });
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

  const dorkfiUnitMarket = ready.find(
    (opportunity) =>
      protocolIncludes(opportunity, "dorkfi") &&
      hasUnitBase(opportunity) &&
      (Boolean(pickDorkFiBorrowShape(opportunity)) ||
        opportunity.opportunityId.includes(`:${UNIT_ASSET_ID}:`)),
  );
  if (dorkfi && dorkfiUnitMarket) {
    const borrowShape = pickDorkFiBorrowShape(dorkfiUnitMarket);
    const repayShape = pickDorkFiRepayShape(dorkfiUnitMarket);
    const withdrawOnDeposit = dorkfi.executionShapes.find(isExitShape);
    const depositShapes = summarizeShapes(dorkfi);
    const borrowShapes = summarizeShapes(dorkfiUnitMarket);
    const shapes = [
      ...depositShapes,
      ...borrowShapes.filter(
        (shape) =>
          !depositShapes.some(
            (existing) => existing.shapeKey === shape.shapeKey,
          ),
      ),
    ];
    const poolAppId = resolveDorkFiPoolAppId(dorkfi);
    const usdcMarketAppId = resolveDorkFiMarketAppId(
      dorkfi,
      DORKFI_DEPOSIT_SHAPE,
      DORKFI_USDC_MARKET_APP_ID,
    );
    const unitMarketAppId = resolveDorkFiMarketAppId(
      dorkfiUnitMarket,
      DORKFI_BORROW_SHAPE,
      DORKFI_UNIT_MARKET_APP_ID,
    );
    for (const registry of [
      {
        shapeKey: DORKFI_DEPOSIT_SHAPE,
        action: "deposit",
        variant: "asa",
        order: 0,
        requiredInputs: [
          "userAddress",
          "poolAppId",
          "marketAppId",
          "assetId",
          "amount",
        ],
        requiredAssetIds: [USDC_ASSET_ID],
        inputHints: {
          assetId: USDC_ASSET_ID,
          poolAppId,
          marketAppId: usdcMarketAppId,
        },
      },
      {
        shapeKey: DORKFI_BORROW_SHAPE,
        action: "borrow",
        variant: "asa",
        order: 1,
        requiredInputs: [
          "userAddress",
          "poolAppId",
          "marketAppId",
          "assetId",
          "amount",
        ],
        requiredAssetIds: [UNIT_ASSET_ID],
        inputHints: {
          assetId: UNIT_ASSET_ID,
          poolAppId,
          marketAppId: unitMarketAppId,
        },
      },
      {
        shapeKey: DORKFI_REPAY_SHAPE,
        action: "repay",
        variant: "asa",
        order: 2,
        requiredInputs: [
          "userAddress",
          "poolAppId",
          "marketAppId",
          "assetId",
          "amount",
        ],
        requiredAssetIds: [UNIT_ASSET_ID],
        inputHints: {
          assetId: UNIT_ASSET_ID,
          poolAppId,
          marketAppId: unitMarketAppId,
        },
      },
      {
        shapeKey: DORKFI_WITHDRAW_SHAPE,
        action: "withdraw",
        variant: "asa",
        order: 3,
        requiredInputs: [
          "userAddress",
          "poolAppId",
          "marketAppId",
          "assetId",
          "amount",
        ],
        requiredAssetIds: [USDC_ASSET_ID],
        inputHints: {
          assetId: USDC_ASSET_ID,
          poolAppId,
          marketAppId: usdcMarketAppId,
        },
      },
    ]) {
      if (!shapes.some((shape) => shape.shapeKey === registry.shapeKey)) {
        shapes.push(registry);
      }
    }
    matched["dorkfi-credit"] = pinnedCaseSchema.parse({
      ...pinFromOpportunity("dorkfi-credit", dorkfi, {
        enterShapeKey:
          pickCapitalEnterShape(dorkfi)?.shapeKey ?? DORKFI_DEPOSIT_SHAPE,
        exitShapeKey: withdrawOnDeposit?.shapeKey ?? DORKFI_WITHDRAW_SHAPE,
        borrowOpportunityId: dorkfiUnitMarket.opportunityId,
        borrowShapeKey: borrowShape?.shapeKey ?? DORKFI_BORROW_SHAPE,
        repayShapeKey: repayShape?.shapeKey ?? DORKFI_REPAY_SHAPE,
        notes:
          "DorkFi credit: deposit USDC → borrow UNIT → repay → withdraw",
      }),
      shapes,
    });
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

export async function refreshOpportunityById(
  canix: Canix402Client,
  walletAddress: string,
  protocol: string,
  opportunityId: string,
): Promise<Opportunity> {
  return refreshPinnedOpportunity(canix, walletAddress, {
    caseId: "compx-credit",
    opportunityId,
    protocol,
    opportunityType: null,
    assetPair: null,
    assetIds: [],
    enterShapeKey: null,
    exitShapeKey: null,
    shapes: [],
  });
}

function ensureShapeOnOpportunity(
  opportunity: Opportunity,
  shape: OpportunityExecutionShape,
): Opportunity {
  if (
    opportunity.executionShapes.some(
      (candidate) => candidate.shapeKey === shape.shapeKey,
    )
  ) {
    return opportunity;
  }
  return {
    ...opportunity,
    executionReady: true,
    executionShapes: [...opportunity.executionShapes, shape],
  };
}

/** Replace or attach a shape so verify can override live catalog quirks. */
function upsertShapeOnOpportunity(
  opportunity: Opportunity,
  shape: OpportunityExecutionShape,
): Opportunity {
  const without = opportunity.executionShapes.filter(
    (candidate) => candidate.shapeKey !== shape.shapeKey,
  );
  return {
    ...opportunity,
    executionReady: true,
    executionShapes: [...without, shape],
  };
}

function registryCompXShape(
  shapeKey: string,
  action: string,
  requiredInputs: string[],
  inputHints?: Record<string, unknown>,
): OpportunityExecutionShape {
  return {
    shapeKey,
    protocol: "compx",
    protocolVersion: "v1",
    action,
    variant: "asa",
    title: `CompX ${action}`,
    summary: `CompX ${action} ASA`,
    order: action === "deposit" ? 0 : action === "borrow" ? 1 : 2,
    requiredInputs,
    requiredAssetIds: [],
    inputHints: inputHints as OpportunityExecutionShape["inputHints"],
  };
}

function registryDorkFiShape(
  shapeKey: string,
  action: string,
  requiredInputs: string[],
  requiredAssetIds: number[],
  inputHints?: Record<string, unknown>,
): OpportunityExecutionShape {
  return {
    shapeKey,
    protocol: "dorkfi",
    protocolVersion: "v1",
    action,
    variant: "asa",
    title: `DorkFi ${action}`,
    summary: `DorkFi ${action} ASA`,
    order:
      action === "deposit"
        ? 0
        : action === "borrow"
          ? 1
          : action === "repay"
            ? 2
            : 3,
    requiredInputs,
    requiredAssetIds,
    inputHints: inputHints as OpportunityExecutionShape["inputHints"],
  };
}

/** Canix often omits DorkFi debt rows; synthesize from wallet UNIT for repay. */
function synthesizeDorkFiUnitDebt(options: {
  amountRaw: string;
  borrowOpportunityId: string;
  repayShapeKey: string;
  poolAppId: number;
  marketAppId: number;
}): Position {
  return {
    protocol: "dorkfi",
    positionType: "debt",
    positionId: `dorkfi-credit:unit:${options.marketAppId}`,
    opportunityId: options.borrowOpportunityId,
    assetId: UNIT_ASSET_ID,
    assetSymbol: "UNIT",
    amountRaw: options.amountRaw,
    amount: options.amountRaw,
    usdValue: null,
    compatibleExitShapeKeys: [options.repayShapeKey],
    compatibleManageShapeKeys: [],
    inputHints: {
      poolAppId: options.poolAppId,
      marketAppId: options.marketAppId,
      assetId: UNIT_ASSET_ID,
    },
  };
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
      // Prefer-hold impact waiver is app/runtime only; verify keeps the hard cap.
      priceImpactExemptToAssetIds: [],
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
    case "folks-credit": {
      amounts.set(USDC_ASSET_ID, usdcRaw);
      amounts.set(ALGO_ASSET_ID, algoRaw);
      break;
    }
    case "compx-credit": {
      amounts.set(USDC_ASSET_ID, usdcRaw);
      amounts.set(
        COMPX_ASSET_ID,
        toBaseUnits(config.PROTOCOL_VERIFY_AMOUNT_COMPX, COMPX_DECIMALS),
      );
      break;
    }
    case "dorkfi-credit": {
      amounts.set(USDC_ASSET_ID, usdcRaw);
      amounts.set(
        UNIT_ASSET_ID,
        toBaseUnits(config.PROTOCOL_VERIFY_AMOUNT_UNIT, UNIT_DECIMALS),
      );
      break;
    }
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

/** Free algod balance probe (no Canix x402). ALGO uses amount − min-balance. */
async function readAlgodAssetSpendable(
  algodUrl: string,
  address: string,
  assetId: number,
): Promise<bigint> {
  const base = algodUrl.replace(/\/$/, "");
  if (assetId === ALGO_ASSET_ID) {
    const response = await fetch(`${base}/v2/accounts/${address}`);
    if (!response.ok) {
      throw new Error(`Algod account lookup failed: ${response.status}`);
    }
    const body = (await response.json()) as {
      amount?: number | string;
      "min-balance"?: number | string;
    };
    const amount = BigInt(body.amount ?? 0);
    const minimum = BigInt(body["min-balance"] ?? 0);
    return amount > minimum ? amount - minimum : 0n;
  }
  const response = await fetch(
    `${base}/v2/accounts/${address}/assets/${assetId}`,
  );
  if (response.status === 404) {
    return 0n;
  }
  if (!response.ok) {
    throw new Error(`Algod asset lookup failed: ${response.status}`);
  }
  const body = (await response.json()) as {
    "asset-holding"?: { amount?: number | string };
  };
  return BigInt(body["asset-holding"]?.amount ?? 0);
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
    case "compx-credit":
      await runCompXCreditCase(context, pinned);
      return;
    case "dorkfi-credit":
      await runDorkFiCreditCase(context, pinned);
      return;
    case "folks-credit":
      await runFolksCreditCase(context, pinned);
      return;
    default:
      await runEnterExitCase(context, pinned);
  }
}

/**
 * CompX credit round-trip: deposit USDC → borrow COMPX against cUSDC → repay → withdraw.
 */
export async function runCompXCreditCase(
  context: ProtocolVerifyContext,
  pinned: PinnedProtocolCase,
): Promise<void> {
  if (!pinned.borrowOpportunityId) {
    throw new Error(
      `Case ${pinned.caseId} missing borrowOpportunityId (re-run canix:discover-verify)`,
    );
  }
  const borrowShapeKey = pinned.borrowShapeKey ?? COMPX_BORROW_SHAPE;
  const repayShapeKey = pinned.repayShapeKey ?? COMPX_REPAY_SHAPE;
  const withdrawShapeKey = pinned.exitShapeKey ?? COMPX_WITHDRAW_SHAPE;
  const depositShapeKey = pinned.enterShapeKey ?? COMPX_DEPOSIT_SHAPE;

  const amounts = amountsForCase(context.config, pinned.caseId);
  const usdcRaw = amounts.get(USDC_ASSET_ID);
  const borrowRaw = amounts.get(COMPX_ASSET_ID);
  if (!usdcRaw || !borrowRaw) {
    throw new Error("compx-credit amounts missing USDC or COMPX");
  }

  const x402FeeBufferRaw = 500_000n;
  const minUsdcForRun = BigInt(usdcRaw) + x402FeeBufferRaw;

  let liquidUsdc = await readAlgodAssetSpendable(
    context.config.X402_ALGOD_URL,
    context.walletAddress,
    USDC_ASSET_ID,
  );
  if (liquidUsdc < minUsdcForRun) {
    const algoTopUp = toBaseUnits(
      Math.max(context.config.PROTOCOL_VERIFY_AMOUNT_ALGO, 3),
      ALGO_DECIMALS,
    );
    const liquidAlgo = await readAlgodAssetSpendable(
      context.config.X402_ALGOD_URL,
      context.walletAddress,
      ALGO_ASSET_ID,
    );
    if (liquidAlgo < BigInt(algoTopUp)) {
      throw new Error(
        `Underfunded for ${pinned.caseId} ALGO→USDC top-up: need ${algoTopUp} ALGO, have ${liquidAlgo.toString()}`,
      );
    }
    console.error(
      `[protocol-verify] ${pinned.caseId}: topping up USDC via Haystack (have ${liquidUsdc.toString()}, need ≥ ${minUsdcForRun.toString()})`,
    );
    const topUpSnapshot: PortfolioSnapshot = {
      address: context.walletAddress,
      fetchedAt: new Date().toISOString(),
      positions: [],
      protocols: [],
      totals: {
        suppliedUsd: null,
        borrowedUsd: null,
        rewardsUsd: null,
        netUsd: null,
      },
      liquidBalances: [
        {
          assetId: ALGO_ASSET_ID,
          amountRaw: liquidAlgo.toString(),
          spendableAmountRaw: liquidAlgo.toString(),
          symbol: "ALGO",
        },
        {
          assetId: USDC_ASSET_ID,
          amountRaw: liquidUsdc.toString(),
          spendableAmountRaw: liquidUsdc.toString(),
          symbol: "USDC",
        },
      ],
      minimumBalanceRaw: "0",
      complete: true,
      caveats: ["algod-only snapshot for CompX credit USDC top-up"],
    };
    const topUp = buildSwapAction({
      id: `${pinned.caseId}-usdc-topup`,
      fromAssetId: ALGO_ASSET_ID,
      toAssetId: USDC_ASSET_ID,
      amountRaw: algoTopUp,
      rationale: "Protocol verify CompX credit USDC top-up",
    });
    await executeConfirmed(
      context,
      validateAndNormalizePlan(topUpSnapshot, basePlan([topUp]), []).actions[0]!,
      [],
    );
  }

  let snapshot = await readSnapshot(context);

  let depositOpportunity = await refreshPinnedOpportunity(
    context.canix,
    context.walletAddress,
    pinned,
  );
  depositOpportunity = ensureShapeOnOpportunity(
    depositOpportunity,
    registryCompXShape(COMPX_DEPOSIT_SHAPE, "deposit", [
      "userAddress",
      "marketAppId",
      "amount",
    ]),
  );
  depositOpportunity = ensureShapeOnOpportunity(
    depositOpportunity,
    registryCompXShape(COMPX_WITHDRAW_SHAPE, "withdraw", [
      "userAddress",
      "marketAppId",
      "amount",
    ]),
  );

  const receiptAssetId =
    resolveCompXReceiptAssetId(depositOpportunity, pinned.receiptAssetId) ??
    pinned.receiptAssetId ??
    null;
  if (!receiptAssetId) {
    throw new Error(
      `CompX credit case missing cUSDC receipt ASA on ${depositOpportunity.opportunityId}`,
    );
  }

  let borrowOpportunity = await refreshOpportunityById(
    context.canix,
    context.walletAddress,
    pinned.protocol ?? "compx",
    pinned.borrowOpportunityId,
  );
  const borrowMarketAppId = resolveCompXMarketAppId(
    borrowOpportunity,
    borrowShapeKey,
    pinned.borrowOpportunityId,
  );
  if (borrowMarketAppId === null) {
    throw new Error(
      `Could not resolve CompX borrow marketAppId from ${pinned.borrowOpportunityId}`,
    );
  }

  borrowOpportunity = upsertShapeOnOpportunity(
    borrowOpportunity,
    registryCompXShape(
      borrowShapeKey,
      "borrow",
      [
        "userAddress",
        "marketAppId",
        "borrowAmount",
        "collateralAmount",
        "collateralTokenId",
      ],
      { marketAppId: borrowMarketAppId },
    ),
  );
  const borrowOnlyOpportunity: Opportunity = {
    ...borrowOpportunity,
    executionShapes: [
      {
        ...(borrowOpportunity.executionShapes.find(
          (shape) => shape.shapeKey === borrowShapeKey,
        ) ??
          registryCompXShape(
            borrowShapeKey,
            "borrow",
            [
              "userAddress",
              "marketAppId",
              "borrowAmount",
              "collateralAmount",
              "collateralTokenId",
            ],
            { marketAppId: borrowMarketAppId },
          )),
        requiredInputs: [
          "userAddress",
          "marketAppId",
          "borrowAmount",
          "collateralAmount",
          "collateralTokenId",
        ],
        requiredAssetIds: [],
        inputHints: { marketAppId: borrowMarketAppId },
      },
    ],
  };
  const repayReadyOpportunity = upsertShapeOnOpportunity(
    borrowOpportunity,
    registryCompXShape(
      repayShapeKey,
      "repay",
      ["userAddress", "marketAppId", "amount"],
      { marketAppId: borrowMarketAppId, assetId: COMPX_ASSET_ID },
    ),
  );

  let debt = snapshot.positions.find(
    (position) =>
      position.protocol === "compx" &&
      position.positionType === "debt" &&
      BigInt(position.amountRaw) > 0n &&
      (position.opportunityId === pinned.borrowOpportunityId ||
        position.assetId === COMPX_ASSET_ID),
  );

  if (!debt) {
    // Withdraw stranded CompX supply from earlier failed runs before depositing.
    const stranded = findPositionForOpportunity(
      snapshot,
      depositOpportunity.opportunityId,
      depositOpportunity.protocol,
    );
    if (stranded && BigInt(stranded.amountRaw) > 0n) {
      console.error(
        `[protocol-verify] ${pinned.caseId}: bootstrap withdraw of stranded CompX supply ${stranded.amountRaw}`,
      );
      const withdrawKeys = [
        ...stranded.compatibleExitShapeKeys,
        ...stranded.compatibleManageShapeKeys,
      ];
      const bootstrapWithdrawKey = withdrawKeys.includes(withdrawShapeKey)
        ? withdrawShapeKey
        : withdrawKeys.find((key) => /withdraw/i.test(key)) ??
          withdrawShapeKey;
      if (
        !stranded.compatibleExitShapeKeys.includes(bootstrapWithdrawKey) &&
        !stranded.compatibleManageShapeKeys.includes(bootstrapWithdrawKey)
      ) {
        stranded.compatibleExitShapeKeys = [
          ...stranded.compatibleExitShapeKeys,
          bootstrapWithdrawKey,
        ];
      }
      const bootstrap = buildExitAction({
        id: `${pinned.caseId}-bootstrap-withdraw`,
        position: stranded,
        opportunity: depositOpportunity,
        exitShapeKey: bootstrapWithdrawKey,
        rationale: "Protocol verify CompX bootstrap withdraw before credit",
      });
      await executeConfirmed(
        context,
        validateAndNormalizePlan(
          snapshot,
          basePlan([bootstrap]),
          [depositOpportunity],
        ).actions[0]!,
        [depositOpportunity],
      );
      snapshot = await readSnapshot(context);
    }

    requireSpendable(snapshot, USDC_ASSET_ID, usdcRaw, pinned.caseId);
    const receiptBefore = spendableRaw(snapshot, receiptAssetId);
    const deposit = buildEnterAction({
      id: `${pinned.caseId}-deposit`,
      opportunity: depositOpportunity,
      enterShapeKey: depositShapeKey,
      amountsByAsset: new Map([[USDC_ASSET_ID, usdcRaw]]),
      rationale: "Protocol verify CompX USDC deposit",
    });
    await executeConfirmed(
      context,
      validateAndNormalizePlan(
        snapshot,
        basePlan([deposit]),
        [depositOpportunity],
      ).actions[0]!,
      [depositOpportunity],
    );

    snapshot = await readSnapshot(context);
    let collateralRaw = spendableRaw(snapshot, receiptAssetId) - receiptBefore;
    if (collateralRaw <= 0n) {
      const supplied = findPositionForOpportunity(
        snapshot,
        depositOpportunity.opportunityId,
        depositOpportunity.protocol,
      );
      if (supplied && BigInt(supplied.amountRaw) > 0n) {
        const suppliedRaw = BigInt(supplied.amountRaw);
        collateralRaw =
          suppliedRaw < BigInt(usdcRaw) ? suppliedRaw : BigInt(usdcRaw);
      }
    }
    if (collateralRaw <= 0n) {
      throw new Error(
        `CompX credit case has no cUSDC collateral (asset ${receiptAssetId})`,
      );
    }
    const collateralAmount = collateralRaw.toString();

    const borrowAction: PortfolioAction = {
      id: `${pinned.caseId}-borrow`,
      type: "open",
      protocol: borrowOnlyOpportunity.protocol,
      opportunityId: borrowOnlyOpportunity.opportunityId,
      positionId: null,
      amountRaw: borrowRaw,
      fromAssetId: receiptAssetId,
      toAssetId: COMPX_ASSET_ID,
      targetWeightPct: 10,
      executionShapeKey: borrowShapeKey,
      executionInput: {
        marketAppId: borrowMarketAppId,
        borrowAmount: borrowRaw,
        collateralAmount,
        collateralTokenId: receiptAssetId,
      },
      authorizedSpends: [
        { assetId: receiptAssetId, amountRaw: collateralAmount },
      ],
      rationale: "Protocol verify CompX borrow against cUSDC",
      dependencies: [],
    };
    await executeConfirmed(
      context,
      validateAndNormalizePlan(
        snapshot,
        basePlan([borrowAction]),
        [borrowOnlyOpportunity],
      ).actions[0]!,
      [borrowOnlyOpportunity],
    );

    snapshot = await readSnapshot(context);
    debt = snapshot.positions.find(
      (position) =>
        position.protocol === borrowOnlyOpportunity.protocol &&
        position.positionType === "debt" &&
        BigInt(position.amountRaw) > 0n &&
        (position.assetId === COMPX_ASSET_ID ||
          position.opportunityId === borrowOnlyOpportunity.opportunityId),
    );
    if (!debt) {
      throw new Error(
        `After CompX borrow, no debt position for ${borrowOnlyOpportunity.opportunityId}`,
      );
    }
  } else {
    console.error(
      `[protocol-verify] ${pinned.caseId}: resuming from open CompX debt ${debt.positionId}`,
    );
  }

  const repayExitKeys = [
    ...debt.compatibleExitShapeKeys,
    ...debt.compatibleManageShapeKeys,
  ];
  const repayKey = repayExitKeys.includes(repayShapeKey)
    ? repayShapeKey
    : repayExitKeys.find((key) => /repay/i.test(key)) ?? repayShapeKey;
  if (
    !debt.compatibleExitShapeKeys.includes(repayKey) &&
    !debt.compatibleManageShapeKeys.includes(repayKey)
  ) {
    debt.compatibleExitShapeKeys = [...debt.compatibleExitShapeKeys, repayKey];
  }

  // Canix may under-report CompX debt (seen as amountRaw "9" after borrowing
  // 10 COMPX). Prefer borrowed size / wallet COMPX so repay clears the loan.
  const walletCompx = spendableRaw(snapshot, COMPX_ASSET_ID);
  let repayAmountRaw = BigInt(debt.amountRaw);
  if (repayAmountRaw < BigInt(borrowRaw)) {
    repayAmountRaw = BigInt(borrowRaw);
  }
  if (walletCompx > 0n && repayAmountRaw > walletCompx) {
    repayAmountRaw = walletCompx;
  }
  if (repayAmountRaw <= 0n) {
    throw new Error(
      `CompX repay has no COMPX to repay (debt=${debt.amountRaw}, borrowed=${borrowRaw}, wallet=${walletCompx.toString()})`,
    );
  }

  const repay = buildExitAction({
    id: `${pinned.caseId}-repay`,
    position: debt,
    opportunity: repayReadyOpportunity,
    exitShapeKey: repayKey,
    withdrawAmountRaw: repayAmountRaw.toString(),
    rationale: "Protocol verify CompX repay",
  });
  repay.executionInput = {
    marketAppId: borrowMarketAppId,
    amount: repayAmountRaw.toString(),
  };
  await executeConfirmed(
    context,
    validateAndNormalizePlan(
      snapshot,
      basePlan([repay]),
      [repayReadyOpportunity],
    ).actions[0]!,
    [repayReadyOpportunity],
  );

  snapshot = await readSnapshot(context);
  const debtAfter = snapshot.positions.find(
    (position) => position.positionId === debt!.positionId,
  );
  if (debtAfter && BigInt(debtAfter.amountRaw) > 0n) {
    // Allow residual dust from Canix under-reporting; require wallet COMPX gone.
    const remainingCompx = spendableRaw(snapshot, COMPX_ASSET_ID);
    if (remainingCompx > 1_000n) {
      throw new Error(
        `After CompX repay, still hold ${remainingCompx.toString()} COMPX and debt ${debtAfter.amountRaw}`,
      );
    }
  }

  const supplied = findPositionForOpportunity(
    snapshot,
    depositOpportunity.opportunityId,
    depositOpportunity.protocol,
  );
  const unlockedCusdc = spendableRaw(snapshot, receiptAssetId);

  if (supplied && BigInt(supplied.amountRaw) > 0n) {
    const withdrawKeys = [
      ...supplied.compatibleExitShapeKeys,
      ...supplied.compatibleManageShapeKeys,
    ];
    const withdrawKey = withdrawKeys.includes(withdrawShapeKey)
      ? withdrawShapeKey
      : withdrawKeys.find((key) => /withdraw/i.test(key)) ?? withdrawShapeKey;
    if (
      !supplied.compatibleExitShapeKeys.includes(withdrawKey) &&
      !supplied.compatibleManageShapeKeys.includes(withdrawKey)
    ) {
      supplied.compatibleExitShapeKeys = [
        ...supplied.compatibleExitShapeKeys,
        withdrawKey,
      ];
    }
    const withdraw = buildExitAction({
      id: `${pinned.caseId}-withdraw`,
      position: supplied,
      opportunity: depositOpportunity,
      exitShapeKey: withdrawKey,
      rationale: "Protocol verify CompX USDC withdraw",
    });
    await executeConfirmed(
      context,
      validateAndNormalizePlan(
        snapshot,
        basePlan([withdraw]),
        [depositOpportunity],
      ).actions[0]!,
      [depositOpportunity],
    );
    return;
  }

  if (unlockedCusdc <= 0n) {
    console.error(
      `[protocol-verify] ${pinned.caseId}: no CompX supply/cUSDC left to withdraw (already clean)`,
    );
    return;
  }

  const syntheticSupply: Position = {
    protocol: depositOpportunity.protocol,
    positionType: "supplied",
    positionId: `compx-credit:cusdc:${receiptAssetId}`,
    opportunityId: depositOpportunity.opportunityId,
    assetId: receiptAssetId,
    assetSymbol: "cUSDC",
    amountRaw: unlockedCusdc.toString(),
    amount: unlockedCusdc.toString(),
    usdValue: null,
    compatibleExitShapeKeys: [withdrawShapeKey],
    compatibleManageShapeKeys: [],
    inputHints: {
      marketAppId:
        typeof depositOpportunity.executionShapes[0]?.inputHints
          ?.marketAppId === "number"
          ? depositOpportunity.executionShapes[0].inputHints.marketAppId
          : undefined,
      assetId: receiptAssetId,
    },
  };
  snapshot = {
    ...snapshot,
    positions: [...snapshot.positions, syntheticSupply],
  };
  const withdraw = buildExitAction({
    id: `${pinned.caseId}-withdraw`,
    position: syntheticSupply,
    opportunity: depositOpportunity,
    exitShapeKey: withdrawShapeKey,
    withdrawAmountRaw: unlockedCusdc.toString(),
    rationale: "Protocol verify CompX withdraw after unlock",
  });
  await executeConfirmed(
    context,
    validateAndNormalizePlan(
      snapshot,
      basePlan([withdraw]),
      [depositOpportunity],
    ).actions[0]!,
    [depositOpportunity],
  );
}

/**
 * DorkFi credit round-trip: deposit USDC → borrow UNIT → repay → withdraw.
 * Same pool cross-market collateral (no receipt ASA handoff like CompX).
 */
export async function runDorkFiCreditCase(
  context: ProtocolVerifyContext,
  pinned: PinnedProtocolCase,
): Promise<void> {
  if (!pinned.borrowOpportunityId) {
    throw new Error(
      `Case ${pinned.caseId} missing borrowOpportunityId (re-run canix:discover-verify)`,
    );
  }
  const borrowShapeKey = pinned.borrowShapeKey ?? DORKFI_BORROW_SHAPE;
  const repayShapeKey = pinned.repayShapeKey ?? DORKFI_REPAY_SHAPE;
  const withdrawShapeKey = pinned.exitShapeKey ?? DORKFI_WITHDRAW_SHAPE;
  const depositShapeKey = pinned.enterShapeKey ?? DORKFI_DEPOSIT_SHAPE;

  const amounts = amountsForCase(context.config, pinned.caseId);
  const usdcRaw = amounts.get(USDC_ASSET_ID);
  const borrowRaw = amounts.get(UNIT_ASSET_ID);
  if (!usdcRaw || !borrowRaw) {
    throw new Error("dorkfi-credit amounts missing USDC or UNIT");
  }

  const x402FeeBufferRaw = 500_000n;
  const minUsdcForRun = BigInt(usdcRaw) + x402FeeBufferRaw;

  let liquidUsdc = await readAlgodAssetSpendable(
    context.config.X402_ALGOD_URL,
    context.walletAddress,
    USDC_ASSET_ID,
  );
  if (liquidUsdc < minUsdcForRun) {
    const algoTopUp = toBaseUnits(
      Math.max(context.config.PROTOCOL_VERIFY_AMOUNT_ALGO, 3),
      ALGO_DECIMALS,
    );
    const liquidAlgo = await readAlgodAssetSpendable(
      context.config.X402_ALGOD_URL,
      context.walletAddress,
      ALGO_ASSET_ID,
    );
    if (liquidAlgo < BigInt(algoTopUp)) {
      throw new Error(
        `Underfunded for ${pinned.caseId} ALGO→USDC top-up: need ${algoTopUp} ALGO, have ${liquidAlgo.toString()}`,
      );
    }
    console.error(
      `[protocol-verify] ${pinned.caseId}: topping up USDC via Haystack (have ${liquidUsdc.toString()}, need ≥ ${minUsdcForRun.toString()})`,
    );
    const topUpSnapshot: PortfolioSnapshot = {
      address: context.walletAddress,
      fetchedAt: new Date().toISOString(),
      positions: [],
      protocols: [],
      totals: {
        suppliedUsd: null,
        borrowedUsd: null,
        rewardsUsd: null,
        netUsd: null,
      },
      liquidBalances: [
        {
          assetId: ALGO_ASSET_ID,
          amountRaw: liquidAlgo.toString(),
          spendableAmountRaw: liquidAlgo.toString(),
          symbol: "ALGO",
        },
        {
          assetId: USDC_ASSET_ID,
          amountRaw: liquidUsdc.toString(),
          spendableAmountRaw: liquidUsdc.toString(),
          symbol: "USDC",
        },
      ],
      minimumBalanceRaw: "0",
      complete: true,
      caveats: ["algod-only snapshot for DorkFi credit USDC top-up"],
    };
    const topUp = buildSwapAction({
      id: `${pinned.caseId}-usdc-topup`,
      fromAssetId: ALGO_ASSET_ID,
      toAssetId: USDC_ASSET_ID,
      amountRaw: algoTopUp,
      rationale: "Protocol verify DorkFi credit USDC top-up",
    });
    await executeConfirmed(
      context,
      validateAndNormalizePlan(topUpSnapshot, basePlan([topUp]), []).actions[0]!,
      [],
    );
  }

  let snapshot = await readSnapshot(context);

  let depositOpportunity = await refreshPinnedOpportunity(
    context.canix,
    context.walletAddress,
    pinned,
  );
  const poolAppId = resolveDorkFiPoolAppId(depositOpportunity);
  const usdcMarketAppId = resolveDorkFiMarketAppId(
    depositOpportunity,
    depositShapeKey,
    DORKFI_USDC_MARKET_APP_ID,
  );
  const dorkFiInputs = [
    "userAddress",
    "poolAppId",
    "marketAppId",
    "assetId",
    "amount",
  ];
  depositOpportunity = ensureShapeOnOpportunity(
    depositOpportunity,
    registryDorkFiShape(
      DORKFI_DEPOSIT_SHAPE,
      "deposit",
      dorkFiInputs,
      [USDC_ASSET_ID],
      {
        poolAppId,
        marketAppId: usdcMarketAppId,
        assetId: USDC_ASSET_ID,
      },
    ),
  );
  depositOpportunity = ensureShapeOnOpportunity(
    depositOpportunity,
    registryDorkFiShape(
      DORKFI_WITHDRAW_SHAPE,
      "withdraw",
      dorkFiInputs,
      [USDC_ASSET_ID],
      {
        poolAppId,
        marketAppId: usdcMarketAppId,
        assetId: USDC_ASSET_ID,
      },
    ),
  );

  let borrowOpportunity = await refreshOpportunityById(
    context.canix,
    context.walletAddress,
    pinned.protocol ?? "dorkfi",
    pinned.borrowOpportunityId,
  );
  const unitMarketAppId = resolveDorkFiMarketAppId(
    borrowOpportunity,
    borrowShapeKey,
    DORKFI_UNIT_MARKET_APP_ID,
  );
  const unitPoolAppId = resolveDorkFiPoolAppId(borrowOpportunity);

  borrowOpportunity = upsertShapeOnOpportunity(
    borrowOpportunity,
    registryDorkFiShape(
      borrowShapeKey,
      "borrow",
      dorkFiInputs,
      [UNIT_ASSET_ID],
      {
        poolAppId: unitPoolAppId,
        marketAppId: unitMarketAppId,
        assetId: UNIT_ASSET_ID,
      },
    ),
  );
  const borrowOnlyOpportunity: Opportunity = {
    ...borrowOpportunity,
    executionShapes: [
      {
        ...(borrowOpportunity.executionShapes.find(
          (shape) => shape.shapeKey === borrowShapeKey,
        ) ??
          registryDorkFiShape(
            borrowShapeKey,
            "borrow",
            dorkFiInputs,
            [],
            {
              poolAppId: unitPoolAppId,
              marketAppId: unitMarketAppId,
              assetId: UNIT_ASSET_ID,
            },
          )),
        requiredInputs: dorkFiInputs,
        // Borrow receives UNIT; do not require holding it beforehand (CompX pattern).
        requiredAssetIds: [],
        inputHints: {
          poolAppId: unitPoolAppId,
          marketAppId: unitMarketAppId,
          assetId: UNIT_ASSET_ID,
        },
      },
    ],
  };
  const repayReadyOpportunity = upsertShapeOnOpportunity(
    borrowOpportunity,
    registryDorkFiShape(
      repayShapeKey,
      "repay",
      dorkFiInputs,
      [UNIT_ASSET_ID],
      {
        poolAppId: unitPoolAppId,
        marketAppId: unitMarketAppId,
        assetId: UNIT_ASSET_ID,
      },
    ),
  );

  let debt = snapshot.positions.find(
    (position) =>
      /dorkfi/i.test(position.protocol) &&
      position.positionType === "debt" &&
      BigInt(position.amountRaw) > 0n &&
      (position.opportunityId === pinned.borrowOpportunityId ||
        position.assetId === UNIT_ASSET_ID),
  );

  // Canix may omit DorkFi debt; resume when wallet holds UNIT against USDC supply.
  if (!debt) {
    const walletUnitBefore = spendableRaw(snapshot, UNIT_ASSET_ID);
    const openSupply = findPositionForOpportunity(
      snapshot,
      depositOpportunity.opportunityId,
      depositOpportunity.protocol,
    );
    if (
      walletUnitBefore > 0n &&
      openSupply &&
      BigInt(openSupply.amountRaw) > 0n
    ) {
      debt = synthesizeDorkFiUnitDebt({
        amountRaw: walletUnitBefore.toString(),
        borrowOpportunityId: pinned.borrowOpportunityId,
        repayShapeKey,
        poolAppId: unitPoolAppId,
        marketAppId: unitMarketAppId,
      });
      snapshot = {
        ...snapshot,
        positions: [...snapshot.positions, debt],
      };
      console.error(
        `[protocol-verify] ${pinned.caseId}: resuming from wallet UNIT ${walletUnitBefore.toString()} (Canix debt omitted)`,
      );
    }
  }

  if (!debt) {
    const stranded = findPositionForOpportunity(
      snapshot,
      depositOpportunity.opportunityId,
      depositOpportunity.protocol,
    );
    if (stranded && BigInt(stranded.amountRaw) > 0n) {
      console.error(
        `[protocol-verify] ${pinned.caseId}: bootstrap withdraw of stranded DorkFi supply ${stranded.amountRaw}`,
      );
      const withdrawKeys = [
        ...stranded.compatibleExitShapeKeys,
        ...stranded.compatibleManageShapeKeys,
      ];
      const bootstrapWithdrawKey = withdrawKeys.includes(withdrawShapeKey)
        ? withdrawShapeKey
        : withdrawKeys.find((key) => /withdraw/i.test(key)) ??
          withdrawShapeKey;
      if (
        !stranded.compatibleExitShapeKeys.includes(bootstrapWithdrawKey) &&
        !stranded.compatibleManageShapeKeys.includes(bootstrapWithdrawKey)
      ) {
        stranded.compatibleExitShapeKeys = [
          ...stranded.compatibleExitShapeKeys,
          bootstrapWithdrawKey,
        ];
      }
      const bootstrap = buildExitAction({
        id: `${pinned.caseId}-bootstrap-withdraw`,
        position: stranded,
        opportunity: depositOpportunity,
        exitShapeKey: bootstrapWithdrawKey,
        rationale: "Protocol verify DorkFi bootstrap withdraw before credit",
      });
      await executeConfirmed(
        context,
        validateAndNormalizePlan(
          snapshot,
          basePlan([bootstrap]),
          [depositOpportunity],
        ).actions[0]!,
        [depositOpportunity],
      );
      snapshot = await readSnapshot(context);
    }

    requireSpendable(snapshot, USDC_ASSET_ID, usdcRaw, pinned.caseId);
    const unitBeforeBorrow = spendableRaw(snapshot, UNIT_ASSET_ID);
    const deposit = buildEnterAction({
      id: `${pinned.caseId}-deposit`,
      opportunity: depositOpportunity,
      enterShapeKey: depositShapeKey,
      amountsByAsset: new Map([[USDC_ASSET_ID, usdcRaw]]),
      rationale: "Protocol verify DorkFi USDC deposit",
    });
    await executeConfirmed(
      context,
      validateAndNormalizePlan(
        snapshot,
        basePlan([deposit]),
        [depositOpportunity],
      ).actions[0]!,
      [depositOpportunity],
    );

    snapshot = await readSnapshot(context);
    const suppliedAfterDeposit = findPositionForOpportunity(
      snapshot,
      depositOpportunity.opportunityId,
      depositOpportunity.protocol,
    );
    if (!suppliedAfterDeposit || BigInt(suppliedAfterDeposit.amountRaw) <= 0n) {
      throw new Error(
        `DorkFi credit case has no USDC supply after deposit on ${depositOpportunity.opportunityId}`,
      );
    }

    const borrowAction: PortfolioAction = {
      id: `${pinned.caseId}-borrow`,
      type: "open",
      protocol: borrowOnlyOpportunity.protocol,
      opportunityId: borrowOnlyOpportunity.opportunityId,
      positionId: null,
      amountRaw: borrowRaw,
      fromAssetId: USDC_ASSET_ID,
      toAssetId: UNIT_ASSET_ID,
      targetWeightPct: 10,
      executionShapeKey: borrowShapeKey,
      executionInput: {
        poolAppId: unitPoolAppId,
        marketAppId: unitMarketAppId,
        assetId: UNIT_ASSET_ID,
        amount: borrowRaw,
      },
      authorizedSpends: [],
      rationale: "Protocol verify DorkFi borrow UNIT against USDC",
      dependencies: [],
    };
    await executeConfirmed(
      context,
      validateAndNormalizePlan(
        snapshot,
        basePlan([borrowAction]),
        [borrowOnlyOpportunity],
      ).actions[0]!,
      [borrowOnlyOpportunity],
    );

    snapshot = await readSnapshot(context);
    debt = snapshot.positions.find(
      (position) =>
        /dorkfi/i.test(position.protocol) &&
        position.positionType === "debt" &&
        BigInt(position.amountRaw) > 0n &&
        (position.assetId === UNIT_ASSET_ID ||
          position.opportunityId === borrowOnlyOpportunity.opportunityId),
    );
    const unitAfterBorrow = spendableRaw(snapshot, UNIT_ASSET_ID);
    const borrowedUnit = unitAfterBorrow - unitBeforeBorrow;
    if (!debt) {
      if (borrowedUnit <= 0n && unitAfterBorrow < BigInt(borrowRaw)) {
        throw new Error(
          `After DorkFi borrow, no debt position and UNIT balance did not increase (before=${unitBeforeBorrow.toString()}, after=${unitAfterBorrow.toString()}, expected≈${borrowRaw})`,
        );
      }
      const debtAmount =
        borrowedUnit > 0n
          ? borrowedUnit.toString()
          : unitAfterBorrow > 0n
            ? unitAfterBorrow.toString()
            : borrowRaw;
      debt = synthesizeDorkFiUnitDebt({
        amountRaw: debtAmount,
        borrowOpportunityId: borrowOnlyOpportunity.opportunityId,
        repayShapeKey,
        poolAppId: unitPoolAppId,
        marketAppId: unitMarketAppId,
      });
      snapshot = {
        ...snapshot,
        positions: [...snapshot.positions, debt],
      };
      console.error(
        `[protocol-verify] ${pinned.caseId}: Canix omitted debt; using wallet UNIT ${debtAmount} for repay`,
      );
    }
  } else {
    console.error(
      `[protocol-verify] ${pinned.caseId}: resuming from open DorkFi debt ${debt.positionId}`,
    );
  }

  // Ensure synthetic debt is present in the snapshot for policy position lookup.
  if (!snapshot.positions.some((position) => position.positionId === debt!.positionId)) {
    snapshot = {
      ...snapshot,
      positions: [...snapshot.positions, debt],
    };
  }

  const repayExitKeys = [
    ...debt.compatibleExitShapeKeys,
    ...debt.compatibleManageShapeKeys,
  ];
  const repayKey = repayExitKeys.includes(repayShapeKey)
    ? repayShapeKey
    : repayExitKeys.find((key) => /repay/i.test(key)) ?? repayShapeKey;
  if (
    !debt.compatibleExitShapeKeys.includes(repayKey) &&
    !debt.compatibleManageShapeKeys.includes(repayKey)
  ) {
    debt.compatibleExitShapeKeys = [...debt.compatibleExitShapeKeys, repayKey];
  }

  const walletUnit = spendableRaw(snapshot, UNIT_ASSET_ID);
  let repayAmountRaw = BigInt(debt.amountRaw);
  if (repayAmountRaw < BigInt(borrowRaw)) {
    repayAmountRaw = BigInt(borrowRaw);
  }
  if (walletUnit > 0n && repayAmountRaw > walletUnit) {
    repayAmountRaw = walletUnit;
  }
  if (repayAmountRaw <= 0n) {
    throw new Error(
      `DorkFi repay has no UNIT to repay (debt=${debt.amountRaw}, borrowed=${borrowRaw}, wallet=${walletUnit.toString()})`,
    );
  }

  const repay = buildExitAction({
    id: `${pinned.caseId}-repay`,
    position: debt,
    opportunity: repayReadyOpportunity,
    exitShapeKey: repayKey,
    withdrawAmountRaw: repayAmountRaw.toString(),
    rationale: "Protocol verify DorkFi repay",
  });
  repay.executionInput = {
    poolAppId: unitPoolAppId,
    marketAppId: unitMarketAppId,
    assetId: UNIT_ASSET_ID,
    amount: repayAmountRaw.toString(),
  };
  await executeConfirmed(
    context,
    validateAndNormalizePlan(
      snapshot,
      basePlan([repay]),
      [repayReadyOpportunity],
    ).actions[0]!,
    [repayReadyOpportunity],
  );

  snapshot = await readSnapshot(context);
  const remainingUnit = spendableRaw(snapshot, UNIT_ASSET_ID);
  // UNIT has 8 decimals; allow tiny residual dust after repay.
  if (remainingUnit > 10_000n) {
    throw new Error(
      `After DorkFi repay, still hold ${remainingUnit.toString()} UNIT (expected ~0)`,
    );
  }

  const supplied = findPositionForOpportunity(
    snapshot,
    depositOpportunity.opportunityId,
    depositOpportunity.protocol,
  );
  if (!supplied || BigInt(supplied.amountRaw) <= 0n) {
    console.error(
      `[protocol-verify] ${pinned.caseId}: no DorkFi USDC supply left to withdraw (already clean)`,
    );
    return;
  }

  const withdrawKeys = [
    ...supplied.compatibleExitShapeKeys,
    ...supplied.compatibleManageShapeKeys,
  ];
  const withdrawKey = withdrawKeys.includes(withdrawShapeKey)
    ? withdrawShapeKey
    : withdrawKeys.find((key) => /withdraw/i.test(key)) ?? withdrawShapeKey;
  if (
    !supplied.compatibleExitShapeKeys.includes(withdrawKey) &&
    !supplied.compatibleManageShapeKeys.includes(withdrawKey)
  ) {
    supplied.compatibleExitShapeKeys = [
      ...supplied.compatibleExitShapeKeys,
      withdrawKey,
    ];
  }
  const withdraw = buildExitAction({
    id: `${pinned.caseId}-withdraw`,
    position: supplied,
    opportunity: depositOpportunity,
    exitShapeKey: withdrawKey,
    rationale: "Protocol verify DorkFi USDC withdraw",
  });
  withdraw.executionInput = {
    poolAppId,
    marketAppId: usdcMarketAppId,
    assetId: USDC_ASSET_ID,
    amount: supplied.amountRaw,
  };
  await executeConfirmed(
    context,
    validateAndNormalizePlan(
      snapshot,
      basePlan([withdraw]),
      [depositOpportunity],
    ).actions[0]!,
    [depositOpportunity],
  );
}

function registryFolksShape(
  shapeKey: string,
  action: string,
  variant: string,
  requiredInputs: string[],
  inputHints?: Record<string, unknown>,
): OpportunityExecutionShape {
  return {
    shapeKey,
    protocol: "folks-finance",
    protocolVersion: "v2",
    action,
    variant,
    title: `Folks ${action}:${variant}`,
    summary: `Folks ${action} ${variant}`,
    order: 0,
    requiredInputs,
    requiredAssetIds: [],
    inputHints: inputHints ? { ...inputHints } : undefined,
  };
}

function singleShapeOpportunity(
  base: Opportunity,
  shape: OpportunityExecutionShape,
): Opportunity {
  return {
    ...base,
    executionReady: true,
    executionShapes: [shape],
  };
}

/**
 * Folks credit round-trip: loan escrow → USDC collateral on loan → borrow ALGO → repay → unwind.
 *
 * Deposit uses the loan escrow as fAsset receiver (SDK deposit receiverAddr), then
 * collateral:sync registers it. Reduce returns collateral; withdraw clears any
 * deposit-escrow residual.
 */
export async function runFolksCreditCase(
  context: ProtocolVerifyContext,
  pinned: PinnedProtocolCase,
): Promise<void> {
  if (!pinned.borrowOpportunityId) {
    throw new Error(
      `Case ${pinned.caseId} missing borrowOpportunityId (re-run canix:discover-verify)`,
    );
  }
  const borrowShapeKey = pinned.borrowShapeKey ?? FOLKS_BORROW_VARIABLE_SHAPE;
  const repayShapeKey = pinned.repayShapeKey ?? FOLKS_REPAY_SHAPE;
  const withdrawShapeKey = pinned.exitShapeKey ?? FOLKS_USDC_WITHDRAW_SHAPE;

  const amounts = amountsForCase(context.config, pinned.caseId);
  const usdcRaw = amounts.get(USDC_ASSET_ID);
  const borrowRaw = amounts.get(ALGO_ASSET_ID);
  if (!usdcRaw || !borrowRaw) {
    throw new Error("folks-credit amounts missing USDC or ALGO");
  }

  const x402FeeBufferRaw = 500_000n;
  const minUsdcForRun = BigInt(usdcRaw) + x402FeeBufferRaw;
  let liquidUsdc = await readAlgodAssetSpendable(
    context.config.X402_ALGOD_URL,
    context.walletAddress,
    USDC_ASSET_ID,
  );
  if (liquidUsdc < minUsdcForRun) {
    const algoTopUp = toBaseUnits(
      Math.max(context.config.PROTOCOL_VERIFY_AMOUNT_ALGO, 3),
      ALGO_DECIMALS,
    );
    const liquidAlgo = await readAlgodAssetSpendable(
      context.config.X402_ALGOD_URL,
      context.walletAddress,
      ALGO_ASSET_ID,
    );
    if (liquidAlgo < BigInt(algoTopUp)) {
      throw new Error(
        `Underfunded for ${pinned.caseId} ALGO→USDC top-up: need ${algoTopUp} ALGO, have ${liquidAlgo.toString()}`,
      );
    }
    console.error(
      `[protocol-verify] ${pinned.caseId}: topping up USDC via Haystack (have ${liquidUsdc.toString()}, need ≥ ${minUsdcForRun.toString()})`,
    );
    const topUpSnapshot: PortfolioSnapshot = {
      address: context.walletAddress,
      fetchedAt: new Date().toISOString(),
      positions: [],
      protocols: [],
      totals: {
        suppliedUsd: null,
        borrowedUsd: null,
        rewardsUsd: null,
        netUsd: null,
      },
      liquidBalances: [
        {
          assetId: ALGO_ASSET_ID,
          amountRaw: liquidAlgo.toString(),
          spendableAmountRaw: liquidAlgo.toString(),
          symbol: "ALGO",
        },
        {
          assetId: USDC_ASSET_ID,
          amountRaw: liquidUsdc.toString(),
          spendableAmountRaw: liquidUsdc.toString(),
          symbol: "USDC",
        },
      ],
      minimumBalanceRaw: "0",
      complete: true,
      caveats: ["algod-only snapshot for Folks credit USDC top-up"],
    };
    const topUp = buildSwapAction({
      id: `${pinned.caseId}-usdc-topup`,
      fromAssetId: ALGO_ASSET_ID,
      toAssetId: USDC_ASSET_ID,
      amountRaw: algoTopUp,
      rationale: "Protocol verify Folks credit USDC top-up",
    });
    await executeConfirmed(
      context,
      validateAndNormalizePlan(topUpSnapshot, basePlan([topUp]), []).actions[0]!,
      [],
    );
  }

  const usdcOpportunity = await refreshPinnedOpportunity(
    context.canix,
    context.walletAddress,
    pinned,
  );
  const usdcPoolAppId =
    resolveFolksPoolAppId(usdcOpportunity) ?? FOLKS_USDC_POOL_APP_ID;
  const algoOpportunity = await refreshOpportunityById(
    context.canix,
    context.walletAddress,
    pinned.protocol ?? "folks-finance",
    pinned.borrowOpportunityId,
  );
  const algoPoolAppId =
    resolveFolksPoolAppId(algoOpportunity) ?? FOLKS_ALGO_POOL_APP_ID;

  const escrowStore = new LocalFolksEscrowStore(
    context.config.FOLKS_ESCROW_DATA_DIR,
  );

  const executeFolksStep = async (options: {
    id: string;
    type: "open" | "close";
    shape: OpportunityExecutionShape;
    baseOpportunity: Opportunity;
    executionInput: Record<string, unknown>;
    amountRaw?: string;
    fromAssetId?: number | null;
    toAssetId?: number | null;
    authorizedSpends?: PortfolioAction["authorizedSpends"];
    position?: Position;
    rationale: string;
  }): Promise<void> => {
    const opportunity = singleShapeOpportunity(
      options.baseOpportunity,
      options.shape,
    );
    const action: PortfolioAction = {
      id: options.id,
      type: options.type,
      protocol: opportunity.protocol,
      opportunityId: opportunity.opportunityId,
      positionId: options.position?.positionId ?? null,
      amountRaw: options.amountRaw ?? null,
      fromAssetId: options.fromAssetId ?? null,
      toAssetId: options.toAssetId ?? null,
      targetWeightPct: options.type === "open" ? 10 : null,
      executionShapeKey: options.shape.shapeKey,
      executionInput: options.executionInput,
      authorizedSpends: options.authorizedSpends ?? [],
      rationale: options.rationale,
      dependencies: [],
    };
    const snapshot = await readSnapshot(context);
    await executeConfirmed(
      context,
      validateAndNormalizePlan(
        snapshot,
        basePlan([action]),
        [opportunity],
      ).actions[0]!,
      [opportunity],
    );
  };

  let snapshot = await readSnapshot(context);
  let debt = snapshot.positions.find(
    (position) =>
      /folks/i.test(position.protocol) &&
      position.positionType === "debt" &&
      BigInt(position.amountRaw) > 0n,
  );

  let loanEscrow = await escrowStore.get(
    context.walletAddress,
    FOLKS_GENERAL_LOAN_APP_ID,
  );

  if (!debt) {
    if (!loanEscrow) {
      console.error(
        `[protocol-verify] ${pinned.caseId}: creating Folks loan escrow`,
      );
      await executeFolksStep({
        id: `${pinned.caseId}-loan-escrow`,
        type: "open",
        shape: registryFolksShape(
          FOLKS_LOAN_SETUP_SHAPE,
          "setup",
          "loanEscrow",
          ["userAddress", "loanAppId"],
          { loanAppId: FOLKS_GENERAL_LOAN_APP_ID },
        ),
        baseOpportunity: usdcOpportunity,
        executionInput: { loanAppId: FOLKS_GENERAL_LOAN_APP_ID },
        rationale: "Protocol verify Folks loan escrow setup",
      });
      loanEscrow = await escrowStore.get(
        context.walletAddress,
        FOLKS_GENERAL_LOAN_APP_ID,
      );
    }
    if (!loanEscrow) {
      throw new Error(
        `Folks credit missing loan escrow after setup (app ${FOLKS_GENERAL_LOAN_APP_ID})`,
      );
    }

    console.error(
      `[protocol-verify] ${pinned.caseId}: addCollateral USDC pool ${usdcPoolAppId}`,
    );
    try {
      await executeFolksStep({
        id: `${pinned.caseId}-add-collateral`,
        type: "open",
        shape: registryFolksShape(
          FOLKS_ADD_COLLATERAL_SHAPE,
          "setup",
          "addCollateral",
          ["userAddress", "escrowAddress", "loanAppId", "poolAppId"],
          {
            loanAppId: FOLKS_GENERAL_LOAN_APP_ID,
            poolAppId: usdcPoolAppId,
          },
        ),
        baseOpportunity: usdcOpportunity,
        executionInput: {
          loanAppId: FOLKS_GENERAL_LOAN_APP_ID,
          poolAppId: usdcPoolAppId,
          escrowAddress: loanEscrow.escrowAddress,
        },
        rationale: "Protocol verify Folks add USDC collateral slot",
      });
    } catch (error) {
      console.error(
        `[protocol-verify] ${pinned.caseId}: addCollateral skipped/failed (may already be opted): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const folksFUsdcAssetId = 971_384_592;
    const loanFUsdc = await readAlgodAssetSpendable(
      context.config.X402_ALGOD_URL,
      loanEscrow.escrowAddress,
      folksFUsdcAssetId,
    );
    if (loanFUsdc <= 0n) {
      snapshot = await readSnapshot(context);
      requireSpendable(snapshot, USDC_ASSET_ID, usdcRaw, pinned.caseId);
      console.error(
        `[protocol-verify] ${pinned.caseId}: deposit ${usdcRaw} USDC to loan escrow`,
      );
      await executeFolksStep({
        id: `${pinned.caseId}-deposit`,
        type: "open",
        shape: registryFolksShape(
          FOLKS_DEPOSIT_SHAPE,
          "deposit",
          "escrow",
          ["userAddress", "assetAmount", "escrowAddress", "poolAppId"],
          { poolAppId: usdcPoolAppId },
        ),
        baseOpportunity: usdcOpportunity,
        executionInput: {
          poolAppId: usdcPoolAppId,
          assetAmount: usdcRaw,
          escrowAddress: loanEscrow.escrowAddress,
          loanAppId: FOLKS_GENERAL_LOAN_APP_ID,
        },
        amountRaw: usdcRaw,
        fromAssetId: USDC_ASSET_ID,
        authorizedSpends: [{ assetId: USDC_ASSET_ID, amountRaw: usdcRaw }],
        rationale: "Protocol verify Folks USDC deposit onto loan escrow",
      });
    } else {
      console.error(
        `[protocol-verify] ${pinned.caseId}: loan escrow already holds fUSDC ${loanFUsdc.toString()}; skipping deposit`,
      );
    }

    console.error(
      `[protocol-verify] ${pinned.caseId}: collateral:sync USDC`,
    );
    await executeFolksStep({
      id: `${pinned.caseId}-sync`,
      type: "open",
      shape: registryFolksShape(
        FOLKS_COLLATERAL_SYNC_SHAPE,
        "collateral",
        "sync",
        ["userAddress", "escrowAddress", "loanAppId", "poolAppId"],
        {
          loanAppId: FOLKS_GENERAL_LOAN_APP_ID,
          poolAppId: usdcPoolAppId,
        },
      ),
      baseOpportunity: usdcOpportunity,
      executionInput: {
        loanAppId: FOLKS_GENERAL_LOAN_APP_ID,
        poolAppId: usdcPoolAppId,
        escrowAddress: loanEscrow.escrowAddress,
      },
      rationale: "Protocol verify Folks sync USDC collateral",
    });

    console.error(
      `[protocol-verify] ${pinned.caseId}: borrow ${borrowRaw} ALGO`,
    );
    await executeFolksStep({
      id: `${pinned.caseId}-borrow`,
      type: "open",
      shape: registryFolksShape(
        borrowShapeKey,
        "borrow",
        "variable",
        [
          "userAddress",
          "escrowAddress",
          "borrowAmount",
          "loanAppId",
          "poolAppId",
        ],
        {
          loanAppId: FOLKS_GENERAL_LOAN_APP_ID,
          poolAppId: algoPoolAppId,
        },
      ),
      baseOpportunity: algoOpportunity,
      executionInput: {
        loanAppId: FOLKS_GENERAL_LOAN_APP_ID,
        poolAppId: algoPoolAppId,
        escrowAddress: loanEscrow.escrowAddress,
        borrowAmount: borrowRaw,
        includeOpUp: true,
        // Host-only: Canix borrow quotes refresh only the borrow asset; Folks
        // still needs collateral asset prices in the same oracle group.
        oracleAssetIds: [USDC_ASSET_ID, ALGO_ASSET_ID],
      },
      // Borrow receives ALGO; do not declare a treasury spend.
      toAssetId: ALGO_ASSET_ID,
      rationale: "Protocol verify Folks borrow ALGO",
    });

    snapshot = await readSnapshot(context);
    debt = snapshot.positions.find(
      (position) =>
        /folks/i.test(position.protocol) &&
        position.positionType === "debt" &&
        BigInt(position.amountRaw) > 0n,
    );
    if (!debt) {
      // Canix may lag; proceed with synthetic debt using borrowed size.
      console.error(
        `[protocol-verify] ${pinned.caseId}: no Folks debt row yet; synthesizing repay from borrow amount`,
      );
      debt = {
        protocol: "folks-finance",
        positionType: "debt",
        positionId: `folks-credit:debt:algo:${algoPoolAppId}`,
        opportunityId: pinned.borrowOpportunityId,
        assetId: ALGO_ASSET_ID,
        assetSymbol: "ALGO",
        amountRaw: borrowRaw,
        amount: borrowRaw,
        usdValue: null,
        compatibleExitShapeKeys: [repayShapeKey],
        compatibleManageShapeKeys: [],
        inputHints: {
          loanAppId: FOLKS_GENERAL_LOAN_APP_ID,
          poolAppId: algoPoolAppId,
          escrowAddress: loanEscrow.escrowAddress,
        },
      };
    }
  } else {
    console.error(
      `[protocol-verify] ${pinned.caseId}: resuming from open Folks debt ${debt.positionId}`,
    );
    if (!loanEscrow) {
      throw new Error(
        `Folks credit resume needs loan escrow secret in ${context.config.FOLKS_ESCROW_DATA_DIR} (app ${FOLKS_GENERAL_LOAN_APP_ID})`,
      );
    }
  }

  if (!loanEscrow?.escrowAddress) {
    throw new Error("Folks credit missing loan escrowAddress for repay");
  }

  snapshot = await readSnapshot(context);
  const walletAlgo = spendableRaw(snapshot, ALGO_ASSET_ID);
  let repayAmountRaw = BigInt(debt.amountRaw);
  if (repayAmountRaw < BigInt(borrowRaw)) {
    repayAmountRaw = BigInt(borrowRaw);
  }
  // Leave ALGO for fees; repay at most wallet balance minus a small fee buffer.
  const feeBuffer = 200_000n;
  const maxRepay =
    walletAlgo > feeBuffer ? walletAlgo - feeBuffer : walletAlgo;
  if (maxRepay > 0n && repayAmountRaw > maxRepay) {
    repayAmountRaw = maxRepay;
  }
  if (repayAmountRaw <= 0n) {
    throw new Error(
      `Folks repay has no ALGO (debt=${debt.amountRaw}, borrowed=${borrowRaw}, wallet=${walletAlgo.toString()})`,
    );
  }

  const repayKeys = [
    ...debt.compatibleExitShapeKeys,
    ...debt.compatibleManageShapeKeys,
  ];
  if (
    !repayKeys.includes(repayShapeKey) &&
    !debt.compatibleExitShapeKeys.includes(repayShapeKey)
  ) {
    debt.compatibleExitShapeKeys = [
      ...debt.compatibleExitShapeKeys,
      repayShapeKey,
    ];
  }

  console.error(
    `[protocol-verify] ${pinned.caseId}: repay ${repayAmountRaw.toString()} ALGO`,
  );
  await executeFolksStep({
    id: `${pinned.caseId}-repay`,
    type: "close",
    shape: registryFolksShape(
      repayShapeKey,
      "repay",
      "withTxn",
      ["userAddress", "escrowAddress", "repayAmount", "loanAppId", "poolAppId"],
      {
        loanAppId: FOLKS_GENERAL_LOAN_APP_ID,
        poolAppId: algoPoolAppId,
      },
    ),
    baseOpportunity: algoOpportunity,
    executionInput: {
      loanAppId: FOLKS_GENERAL_LOAN_APP_ID,
      poolAppId: algoPoolAppId,
      escrowAddress: loanEscrow.escrowAddress,
      repayAmount: repayAmountRaw.toString(),
      includeOpUp: true,
      oracleAssetIds: [USDC_ASSET_ID, ALGO_ASSET_ID],
    },
    amountRaw: repayAmountRaw.toString(),
    fromAssetId: ALGO_ASSET_ID,
    authorizedSpends: [
      { assetId: ALGO_ASSET_ID, amountRaw: repayAmountRaw.toString() },
    ],
    position: debt,
    rationale: "Protocol verify Folks repay ALGO",
  });

  console.error(
    `[protocol-verify] ${pinned.caseId}: collateral:reduce ${usdcRaw} USDC`,
  );
  await executeFolksStep({
    id: `${pinned.caseId}-reduce`,
    type: "open",
    shape: registryFolksShape(
      FOLKS_COLLATERAL_REDUCE_SHAPE,
      "collateral",
      "reduce",
      [
        "userAddress",
        "escrowAddress",
        "amount",
        "amountDenomination",
        "loanAppId",
        "poolAppId",
      ],
      {
        loanAppId: FOLKS_GENERAL_LOAN_APP_ID,
        poolAppId: usdcPoolAppId,
      },
    ),
    baseOpportunity: usdcOpportunity,
    executionInput: {
      loanAppId: FOLKS_GENERAL_LOAN_APP_ID,
      poolAppId: usdcPoolAppId,
      escrowAddress: loanEscrow.escrowAddress,
      amount: usdcRaw,
      amountDenomination: "asset",
      includeOpUp: true,
      oracleAssetIds: [USDC_ASSET_ID, ALGO_ASSET_ID],
    },
    rationale: "Protocol verify Folks reduce USDC collateral",
  });

  snapshot = await readSnapshot(context);
  const supplied = findPositionForOpportunity(
    snapshot,
    usdcOpportunity.opportunityId,
    usdcOpportunity.protocol,
  );
  if (supplied && BigInt(supplied.amountRaw) > 0n) {
    const withdrawKeys = [
      ...supplied.compatibleExitShapeKeys,
      ...supplied.compatibleManageShapeKeys,
    ];
    const withdrawKey = withdrawKeys.includes(withdrawShapeKey)
      ? withdrawShapeKey
      : withdrawKeys.find((key) => /withdraw/i.test(key)) ?? withdrawShapeKey;
    if (
      !supplied.compatibleExitShapeKeys.includes(withdrawKey) &&
      !supplied.compatibleManageShapeKeys.includes(withdrawKey)
    ) {
      supplied.compatibleExitShapeKeys = [
        ...supplied.compatibleExitShapeKeys,
        withdrawKey,
      ];
    }
    const withdrawAmount =
      BigInt(supplied.amountRaw) < BigInt(usdcRaw)
        ? supplied.amountRaw
        : usdcRaw;
    console.error(
      `[protocol-verify] ${pinned.caseId}: withdraw ${withdrawAmount} USDC from deposit escrow`,
    );
    const withdraw = buildExitAction({
      id: `${pinned.caseId}-withdraw`,
      position: supplied,
      opportunity: usdcOpportunity,
      exitShapeKey: withdrawKey,
      withdrawAmountRaw: withdrawAmount,
      rationale: "Protocol verify Folks USDC withdraw after credit",
    });
    await executeConfirmed(
      context,
      validateAndNormalizePlan(
        snapshot,
        basePlan([withdraw]),
        [usdcOpportunity],
      ).actions[0]!,
      [usdcOpportunity],
    );
    return;
  }

  console.error(
    `[protocol-verify] ${pinned.caseId}: no Folks deposit position after reduce (collateral returned to wallet)`,
  );
}
