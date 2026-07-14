import { z } from "zod";

export const opportunitySchema = z.object({
  protocol: z.string().min(1),
  opportunityType: z.string().min(1),
  opportunityId: z.string().min(1),
  assetPair: z.string().min(1),
  assetIds: z.array(z.number().int().nonnegative()).optional(),
  apy: z.number().finite(),
  apr: z.number().finite().optional(),
  yieldBasis: z.enum(["apy", "apr"]),
  tvlUsd: z.number().finite().nonnegative(),
  sourceTimestamp: z.iso.datetime(),
  fetchedAt: z.iso.datetime(),
  notes: z.string().optional(),
});

export type Opportunity = z.infer<typeof opportunitySchema>;

export const positionSchema = z.object({
  protocol: z.string().min(1),
  positionType: z.enum(["supplied", "lp", "staked", "debt", "reward"]),
  positionId: z.string().min(1),
  opportunityId: z.string().nullable(),
  assetId: z.number().int().nonnegative().nullable(),
  assetSymbol: z.string().nullable(),
  amountRaw: z.string().regex(/^[0-9]+$/),
  amount: z.string().regex(/^[0-9]+(?:\.[0-9]+)?$/),
  usdValue: z.number().nonnegative().nullable(),
  healthFactor: z.number().nonnegative().nullable().optional(),
  sourceTimestamp: z.iso.datetime().optional(),
  caveats: z.array(z.string()).optional(),
  notes: z.string().optional(),
});

export type Position = z.infer<typeof positionSchema>;

export const protocolPositionResultSchema = z.object({
  protocol: z.string().min(1),
  status: z.enum(["ok", "partial", "unavailable"]),
  positionCount: z.number().int().nonnegative(),
  message: z.string().nullable(),
});

export const walletPositionsSchema = z.object({
  data: z.array(positionSchema),
  protocols: z.array(protocolPositionResultSchema),
  totals: z.object({
    suppliedUsd: z.number().nullable(),
    borrowedUsd: z.number().nullable(),
    rewardsUsd: z.number().nullable(),
    netUsd: z.number().nullable(),
  }),
  meta: z.object({
    address: z.string().min(1),
    fetchedAt: z.iso.datetime(),
  }),
});

export type WalletPositions = z.infer<typeof walletPositionsSchema>;

export const liquidBalanceSchema = z.object({
  assetId: z.number().int().nonnegative(),
  amountRaw: z.string().regex(/^[0-9]+$/),
  spendableAmountRaw: z
    .string()
    .regex(/^[0-9]+$/)
    .optional(),
  decimals: z.number().int().nonnegative().optional(),
  symbol: z.string().min(1).optional(),
  frozen: z.boolean().optional(),
});

export type LiquidBalance = z.infer<typeof liquidBalanceSchema>;

export interface PortfolioSnapshot {
  address: string;
  fetchedAt: string;
  positions: Position[];
  protocols: z.infer<typeof protocolPositionResultSchema>[];
  totals: WalletPositions["totals"];
  liquidBalances: LiquidBalance[];
  complete: boolean;
  caveats: string[];
}

export interface PaymentReceipt {
  amountBaseUnits: string;
  assetId: string;
  network: string;
  responseHeader?: string;
  resourcePath?: string;
}

export const allocationSchema = z.object({
  key: z.string().min(1),
  protocol: z.string().min(1).nullable(),
  opportunityId: z.string().min(1).nullable(),
  assetIds: z.array(z.number().int().nonnegative()),
  weightPct: z.number().min(0).max(100),
  expectedApyPct: z.number().nullable(),
});

export const portfolioActionSchema = z.object({
  id: z.string().min(1),
  type: z.enum([
    "hold",
    "open",
    "increase",
    "reduce",
    "close",
    "swap",
    "claim",
  ]),
  protocol: z.string().min(1).nullable(),
  opportunityId: z.string().min(1).nullable(),
  positionId: z.string().min(1).nullable(),
  amountRaw: z
    .string()
    .regex(/^[0-9]+$/)
    .nullable(),
  fromAssetId: z.number().int().nonnegative().nullable(),
  toAssetId: z.number().int().nonnegative().nullable(),
  targetWeightPct: z.number().min(0).max(100).nullable(),
  executionShapeKey: z.string().min(1).nullable(),
  executionInput: z.record(z.string(), z.unknown()).nullable(),
  authorizedSpends: z
    .array(
      z.object({
        assetId: z.number().int().nonnegative(),
        amountRaw: z.string().regex(/^[1-9][0-9]*$/),
      }),
    )
    .max(4),
  rationale: z.string().min(1),
  dependencies: z.array(z.string()),
});

export type PortfolioAction = z.infer<typeof portfolioActionSchema>;

export const portfolioPlanSchema = z.object({
  currentAllocations: z.array(allocationSchema),
  targetAllocations: z.array(allocationSchema),
  actions: z.array(portfolioActionSchema).max(30),
  holdDecisions: z.array(z.string()),
  currentAnnualizedReturnPct: z.number().nullable(),
  targetAnnualizedReturnPct: z.number().nullable(),
  estimatedOneTimeCostsUsd: z.number().nonnegative(),
  projectedNetBenefitUsd: z.number(),
  holdingHorizonDays: z.number().int().positive(),
  evidence: z.array(z.string()),
  assumptions: z.array(z.string()),
  risks: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1).max(4_000),
});

export type PortfolioPlan = z.infer<typeof portfolioPlanSchema>;

export interface PolicyResult {
  approved: boolean;
  violations: string[];
  metrics: {
    maxPositionPct: number;
    maxProtocolPct: number;
    liquidReservePct: number;
    turnoverPct: number;
  };
}

export interface ExecutionOutcome {
  actionId: string;
  status: "validated-dry-run" | "confirmed" | "failed" | "skipped";
  toolName?: string;
  transactionId?: string;
  confirmedRound?: string;
  error?: string;
}

export interface ReviewRun {
  id: string;
  startedAt: string;
  completedAt: string;
  status:
    | "planned"
    | "validated-dry-run"
    | "executing"
    | "partially-executed"
    | "confirmed"
    | "no-op"
    | "failed";
  mode: "autonomous";
  signingEnabled: boolean;
  walletAddress?: string;
  snapshot?: PortfolioSnapshot;
  reconciledSnapshot?: PortfolioSnapshot;
  reconciliationError?: string;
  plan?: PortfolioPlan;
  policy?: PolicyResult;
  executions?: ExecutionOutcome[];
  payments?: PaymentReceipt[];
  opportunities: Opportunity[];
  error?: string;
  notificationError?: string;
}

export interface OpportunityResult {
  opportunities: Opportunity[];
  payment?: PaymentReceipt;
}
