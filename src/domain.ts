import { z } from "zod";

export const opportunityExecutionInputHintsSchema = z
  .object({
    assetId: z.number().int().nonnegative().optional(),
    assetAId: z.number().int().nonnegative().optional(),
    assetBId: z.number().int().nonnegative().optional(),
    depositAssetId: z.number().int().nonnegative().optional(),
    poolAppId: z.number().int().positive().optional(),
    marketAppId: z.number().int().positive().optional(),
    farmAppId: z.number().int().positive().optional(),
    appId: z.number().int().positive().optional(),
    validatorId: z.number().int().positive().optional(),
    poolId: z.string().min(1).optional(),
    programId: z.number().int().positive().optional(),
    liquidityAssetId: z.number().int().nonnegative().optional(),
    escrowAddress: z.string().min(58).max(58).optional(),
    valueToVerify: z.union([z.number().int().nonnegative(), z.string()]).optional(),
  })
  .passthrough();

export const opportunityExecutionShapeSchema = z.object({
  shapeKey: z.string().min(1),
  protocol: z.string().min(1),
  protocolVersion: z.string().min(1),
  action: z.string().min(1),
  variant: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  order: z.number().int().nonnegative(),
  prerequisiteShapeKeys: z.array(z.string().min(1)).optional(),
  requiredInputs: z.array(z.string().min(1)),
  requiredAssetIds: z.array(z.number().int().nonnegative()),
  inputHints: opportunityExecutionInputHintsSchema.optional(),
});

export type OpportunityExecutionShape = z.infer<
  typeof opportunityExecutionShapeSchema
>;

const opportunityAmountRequirementSchema = z
  .object({
    assetId: z.number().int().nonnegative(),
    amount: z.string().regex(/^[0-9]+$/),
  })
  .passthrough();

const opportunityEntryGateSchema = z
  .object({
    kind: z.enum([
      "asa",
      "asa-creator",
      "nfd-linked-creators",
      "nfd-root-segment",
    ]),
  })
  .passthrough();

export const opportunityEntryRequirementsSchema = z
  .object({
    minAmount: opportunityAmountRequirementSchema.optional(),
    gates: z.array(opportunityEntryGateSchema).optional(),
    gateMatch: z.enum(["any", "all"]).optional(),
    eligibilityFullyCheckable: z.boolean().optional(),
  })
  .passthrough();

export const opportunityCapacitySchema = z
  .object({
    stakerSlotsRemaining: z.number().int().nonnegative().nullable().optional(),
    algoRoomMicroAlgos: z
      .string()
      .regex(/^[0-9]+$/)
      .nullable()
      .optional(),
    acceptingStake: z.boolean().optional(),
  })
  .passthrough();

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
  entryRequirements: opportunityEntryRequirementsSchema.optional(),
  capacity: opportunityCapacitySchema.optional(),
  executionReady: z.boolean(),
  executionShapes: z.array(opportunityExecutionShapeSchema),
});

export type Opportunity = z.infer<typeof opportunitySchema>;
export type OpportunityEntryRequirements = z.infer<
  typeof opportunityEntryRequirementsSchema
>;
export type OpportunityCapacity = z.infer<typeof opportunityCapacitySchema>;

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
  inputHints: opportunityExecutionInputHintsSchema.optional(),
  compatibleExitShapeKeys: z.array(z.string().min(1)).default([]),
  compatibleManageShapeKeys: z.array(z.string().min(1)).default([]),
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
  /** Account minimum balance in microAlgos. */
  minimumBalanceRaw: string;
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
  /** Advisory issues (concentration guidance, dry-run notes). Do not block approval. */
  warnings: string[];
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
  /** ZeroSignal / zs-proxy inference spend for this run (from response headers). */
  inferenceCost?: {
    totalUsdc: string;
    requestCount: number;
    charges: Array<{
      amountUsdc: string;
      headers: Record<string, string>;
    }>;
  };
  opportunities: Opportunity[];
  error?: string;
  notificationError?: string;
}

export interface OpportunityResult {
  opportunities: Opportunity[];
  payment?: PaymentReceipt;
}

/** Canonical decimal string used for accounting money values. */
export const moneyStringSchema = z.string().regex(/^-?[0-9]+(?:\.[0-9]+)?$/);

export const assetPriceSchema = z.object({
  assetId: z.number().int().nonnegative(),
  symbol: z.string().min(1).optional(),
  priceUsd: moneyStringSchema.nullable(),
  source: z.string().min(1),
  fetchedAt: z.iso.datetime(),
  stale: z.boolean().default(false),
});

export type AssetPrice = z.infer<typeof assetPriceSchema>;

export const accountingCashflowSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().min(1),
  walletAddress: z.string().min(1),
  type: z.enum([
    "external_deposit",
    "external_withdrawal",
    "profit_share_withdrawal",
  ]),
  amountUsd: moneyStringSchema,
  occurredAt: z.iso.datetime(),
  recordedAt: z.iso.datetime(),
  transactionId: z.string().min(1).optional(),
  reference: z.string().min(1).optional(),
  notes: z.string().optional(),
  checksum: z.string().min(1),
});

export type AccountingCashflow = z.infer<typeof accountingCashflowSchema>;

export const protocolValueSchema = z.object({
  protocol: z.string().min(1),
  valueUsd: moneyStringSchema.nullable(),
  positionCount: z.number().int().nonnegative(),
});

export type ProtocolValue = z.infer<typeof protocolValueSchema>;

export const accountingSnapshotSchema = z.object({
  schemaVersion: z.literal(2),
  id: z.string().min(1),
  walletAddress: z.string().min(1),
  asOf: z.iso.datetime(),
  fetchedAt: z.iso.datetime(),
  defiByProtocol: z.array(protocolValueSchema),
  defiValueUsd: moneyStringSchema.nullable(),
  walletAsaValueUsd: moneyStringSchema.nullable(),
  unpricedAssetIds: z.array(z.number().int().nonnegative()),
  algoBalance: z.string().regex(/^[0-9]+(?:\.[0-9]+)?$/),
  algoBalanceRaw: z.string().regex(/^[0-9]+$/),
  minimumBalance: z.string().regex(/^[0-9]+(?:\.[0-9]+)?$/),
  minimumBalanceRaw: z.string().regex(/^[0-9]+$/),
  totalValueUsd: moneyStringSchema.nullable(),
  notes: z.array(z.string()),
  prices: z.array(assetPriceSchema),
  checksum: z.string().min(1),
});

export type AccountingSnapshot = z.infer<typeof accountingSnapshotSchema>;

export const accountingSummarySchema = z.object({
  schemaVersion: z.literal(2),
  walletAddress: z.string().min(1),
  asOf: z.iso.datetime(),
  latestSnapshotId: z.string().min(1),
  latestSnapshotKey: z.string().min(1),
  latestTotalValueUsd: moneyStringSchema.nullable(),
  previousTotalValueUsd: moneyStringSchema.nullable(),
  pnlUsd: moneyStringSchema.nullable(),
  pnlAvailable: z.boolean(),
  defiByProtocol: z.array(protocolValueSchema),
  defiValueUsd: moneyStringSchema.nullable(),
  walletAsaValueUsd: moneyStringSchema.nullable(),
  unpricedAssetIds: z.array(z.number().int().nonnegative()),
  algoBalance: z.string().regex(/^[0-9]+(?:\.[0-9]+)?$/),
  minimumBalance: z.string().regex(/^[0-9]+(?:\.[0-9]+)?$/),
  notes: z.array(z.string()),
  checksum: z.string().min(1),
});

export type AccountingSummary = z.infer<typeof accountingSummarySchema>;

export interface AccountingRun {
  id: string;
  startedAt: string;
  completedAt: string;
  status: "completed" | "failed" | "busy";
  snapshot?: AccountingSnapshot;
  summary?: AccountingSummary;
  snapshotKey?: string;
  error?: string;
  notificationError?: string;
}
