import type {
  ExecutionOutcome,
  Opportunity,
  OpportunityExecutionShape,
  PaymentReceipt,
  PortfolioAction,
  PortfolioPlan,
  PortfolioSnapshot,
  Position,
} from "../domain.js";
import type { Canix402Client } from "../integrations/canix402/client.js";
import type { AlgorandExecutionService } from "../integrations/algorand/execution.js";
import type { PortfolioReader } from "../integrations/algorand/portfolio.js";
import { PortfolioPolicy, normalizePortfolioPlan } from "./portfolio-policy.js";
import {
  ALGO_ASSET_ID,
  FOLKS_XALGO_ASSET_ID,
  FOLKS_XALGO_UNSTAKE_SHAPE,
  MYTH_REDEEM_SHAPE,
  USDC_ASSET_ID,
  buildExitAction,
  buildLstUnstakeAction,
  resolveExitShapeKey,
  resolveLstReceiptAssetId,
  spendableRaw,
} from "./protocol-verify.js";
import {
  RunCoordinatorBusyError,
  type CoordinatorMode,
  type RunCoordinator,
} from "./run-coordinator.js";

export const UNWIND_MAX_WAVES = 8;
export const UNWIND_PENDING_TTL_MS = 10 * 60 * 1000;

export type UnwindStepKind = "claim" | "uncommit" | "close" | "lst";

export interface UnwindSkip {
  positionId?: string;
  assetId?: number;
  reason: string;
}

export interface UnwindWavePlan {
  actions: PortfolioAction[];
  skipped: UnwindSkip[];
  /** Stable fingerprint of planned actions (order-independent). */
  fingerprint: string;
  summary: string;
}

export interface UnwindWaveResult {
  wave: number;
  plan: UnwindWavePlan;
  policyApproved: boolean;
  policyViolations: string[];
  executions: ExecutionOutcome[];
}

export interface UnwindRunResult {
  id: string;
  startedAt: string;
  completedAt: string;
  status: "completed" | "stuck" | "max-waves" | "failed" | "no-op";
  waves: UnwindWaveResult[];
  error?: string;
  payments: PaymentReceipt[];
}

export interface UnwindPendingPreview {
  fingerprint: string;
  summary: string;
  actionCount: number;
  skipCount: number;
  createdAt: number;
  expiresAt: number;
}

export class UnwindPendingStore {
  private readonly pending = new Map<string, UnwindPendingPreview>();

  constructor(private readonly ttlMs = UNWIND_PENDING_TTL_MS) {}

  set(
    key: string,
    plan: UnwindWavePlan,
    now = Date.now(),
  ): UnwindPendingPreview {
    const entry: UnwindPendingPreview = {
      fingerprint: plan.fingerprint,
      summary: plan.summary,
      actionCount: plan.actions.length,
      skipCount: plan.skipped.length,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.pending.set(key, entry);
    return entry;
  }

  get(key: string, now = Date.now()): UnwindPendingPreview | null {
    const entry = this.pending.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= now) {
      this.pending.delete(key);
      return null;
    }
    return entry;
  }

  take(key: string, now = Date.now()): UnwindPendingPreview | null {
    const entry = this.get(key, now);
    if (entry) {
      this.pending.delete(key);
    }
    return entry;
  }

  clear(key: string): boolean {
    return this.pending.delete(key);
  }
}

function isClaimShapeKey(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.includes("claimrewards") || lower.includes("claim");
}

function isUncommitShapeKey(key: string): boolean {
  return key.toLowerCase().includes("uncommit");
}

function stubOpportunityForPosition(position: Position): Opportunity {
  const now = new Date().toISOString();
  return {
    protocol: position.protocol,
    opportunityType: position.positionType,
    opportunityId: position.opportunityId ?? position.positionId,
    assetPair: position.assetSymbol ?? "unknown",
    assetIds: position.assetId !== null ? [position.assetId] : [],
    apy: 0,
    yieldBasis: "apy",
    tvlUsd: 1_000_000,
    sourceTimestamp: now,
    fetchedAt: now,
    executionShapes: [],
    executionReady: true,
  };
}

function findOpportunity(
  opportunities: Opportunity[],
  opportunityId: string | null,
): Opportunity | undefined {
  if (!opportunityId) {
    return undefined;
  }
  return opportunities.find(
    (candidate) => candidate.opportunityId === opportunityId,
  );
}

/**
 * Pick the single next unwind step for a position this wave:
 * claim → uncommit → exit/close.
 */
export function pickNextPositionStep(
  position: Position,
): { kind: Exclude<UnwindStepKind, "lst">; shapeKey: string } | null {
  const manage = position.compatibleManageShapeKeys;
  const exit = position.compatibleExitShapeKeys;
  const claimKey = manage.find(isClaimShapeKey);
  if (claimKey) {
    return { kind: "claim", shapeKey: claimKey };
  }
  const uncommitKey = [...manage, ...exit].find(isUncommitShapeKey);
  if (uncommitKey) {
    return { kind: "uncommit", shapeKey: uncommitKey };
  }
  const remainingExit = exit.filter((key) => !isUncommitShapeKey(key));
  const remainingManage = manage.filter(
    (key) => !isClaimShapeKey(key) && !isUncommitShapeKey(key),
  );
  if (remainingExit.length === 0 && remainingManage.length === 0) {
    return null;
  }
  try {
    const shapeKey = resolveExitShapeKey(
      {
        ...position,
        compatibleExitShapeKeys: remainingExit,
        compatibleManageShapeKeys: remainingManage,
      },
      null,
    );
    return { kind: "close", shapeKey };
  } catch {
    const fallback = remainingExit[0] ?? remainingManage[0];
    return fallback ? { kind: "close", shapeKey: fallback } : null;
  }
}

function stepPriority(kind: UnwindStepKind): number {
  switch (kind) {
    case "claim":
      return 0;
    case "uncommit":
      return 1;
    case "close":
      return 2;
    case "lst":
      return 3;
  }
}

function actionFingerprint(action: PortfolioAction): string {
  return [
    action.type,
    action.positionId ?? "",
    action.fromAssetId ?? "",
    action.executionShapeKey ?? "",
    action.amountRaw ?? "",
  ].join("|");
}

export function fingerprintActions(actions: PortfolioAction[]): string {
  return actions.map(actionFingerprint).sort().join("\n");
}

function folksXalgoUnstakeShape(): OpportunityExecutionShape {
  return {
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
  };
}

function mythRedeemShape(
  receiptAssetId: number,
  hints?: OpportunityExecutionShape["inputHints"],
): OpportunityExecutionShape {
  const appId =
    typeof hints?.poolAppId === "number"
      ? hints.poolAppId
      : typeof hints?.appId === "number"
        ? hints.appId
        : undefined;
  return {
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
  };
}

/**
 * Ensure opportunities carry resolvable LST unstake/redeem shapes for known receipts.
 */
export function enrichOpportunitiesForLstUnstake(
  opportunities: Opportunity[],
  receiptAssetIds: number[],
): Opportunity[] {
  let next = [...opportunities];
  for (const receiptAssetId of receiptAssetIds) {
    if (receiptAssetId === FOLKS_XALGO_ASSET_ID) {
      const existing = next.find((opportunity) =>
        opportunity.executionShapes.some(
          (shape) => shape.shapeKey === FOLKS_XALGO_UNSTAKE_SHAPE,
        ),
      );
      if (existing) {
        continue;
      }
      const donor =
        next.find((opportunity) => /folks/i.test(opportunity.protocol)) ??
        ({
          protocol: "folks-finance",
          opportunityType: "staking",
          opportunityId: "folks-finance:xalgo-v1:stake",
          assetPair: "ALGO/xALGO",
          assetIds: [ALGO_ASSET_ID, FOLKS_XALGO_ASSET_ID],
          apy: 0,
          yieldBasis: "apy" as const,
          tvlUsd: 1_000_000,
          sourceTimestamp: new Date().toISOString(),
          fetchedAt: new Date().toISOString(),
          executionShapes: [] as OpportunityExecutionShape[],
          executionReady: true,
        } satisfies Opportunity);
      const enriched: Opportunity = {
        ...donor,
        executionShapes: [...donor.executionShapes, folksXalgoUnstakeShape()],
      };
      next = next.filter(
        (candidate) => candidate.opportunityId !== donor.opportunityId,
      );
      next.push(enriched);
      continue;
    }

    const myth = next.find((opportunity) => {
      if (!/myth/i.test(opportunity.protocol)) {
        return false;
      }
      const receipt = resolveLstReceiptAssetId(opportunity, null);
      return receipt === receiptAssetId;
    });
    if (!myth) {
      continue;
    }
    if (
      myth.executionShapes.some((shape) => shape.shapeKey === MYTH_REDEEM_SHAPE)
    ) {
      continue;
    }
    const enriched: Opportunity = {
      ...myth,
      executionShapes: [
        ...myth.executionShapes,
        mythRedeemShape(receiptAssetId, myth.executionShapes[0]?.inputHints),
      ],
    };
    next = next.map((candidate) =>
      candidate.opportunityId === myth.opportunityId ? enriched : candidate,
    );
  }
  return next;
}

function resolveLstUnstake(
  opportunities: Opportunity[],
  receiptAssetId: number,
): { opportunity: Opportunity; unstakeShapeKey: string } | null {
  const preferredKey =
    receiptAssetId === FOLKS_XALGO_ASSET_ID
      ? FOLKS_XALGO_UNSTAKE_SHAPE
      : undefined;
  for (const opportunity of opportunities) {
    if (preferredKey) {
      const match = opportunity.executionShapes.find(
        (shape) => shape.shapeKey === preferredKey,
      );
      if (match) {
        return { opportunity, unstakeShapeKey: match.shapeKey };
      }
    }
    const receipt = resolveLstReceiptAssetId(opportunity, receiptAssetId);
    if (receipt !== receiptAssetId) {
      continue;
    }
    const unstake = opportunity.executionShapes.find((shape) => {
      const key =
        `${shape.action}:${shape.variant}:${shape.shapeKey}`.toLowerCase();
      return /unstake|redeem|burn/.test(key);
    });
    if (unstake) {
      return { opportunity, unstakeShapeKey: unstake.shapeKey };
    }
  }
  return null;
}

function knownLstReceiptAssetIds(
  snapshot: PortfolioSnapshot,
  opportunities: Opportunity[],
): number[] {
  const ids = new Set<number>();
  if (spendableRaw(snapshot, FOLKS_XALGO_ASSET_ID) > 0n) {
    ids.add(FOLKS_XALGO_ASSET_ID);
  }
  for (const opportunity of opportunities) {
    if (!/folks|myth|tinyman/i.test(opportunity.protocol)) {
      continue;
    }
    const hasUnstake = opportunity.executionShapes.some((shape) => {
      const key =
        `${shape.action}:${shape.variant}:${shape.shapeKey}`.toLowerCase();
      return /unstake|redeem|burn/.test(key);
    });
    if (!hasUnstake && !/folks|myth/i.test(opportunity.protocol)) {
      continue;
    }
    const receipt = resolveLstReceiptAssetId(opportunity, null);
    if (
      receipt &&
      receipt !== ALGO_ASSET_ID &&
      receipt !== USDC_ASSET_ID &&
      spendableRaw(snapshot, receipt) > 0n
    ) {
      ids.add(receipt);
    }
  }
  return [...ids];
}

export function buildClaimAction(options: {
  id: string;
  position: Position;
  claimShapeKey: string;
  rationale?: string;
}): PortfolioAction {
  return {
    id: options.id,
    type: "claim",
    protocol: options.position.protocol,
    opportunityId: options.position.opportunityId,
    positionId: options.position.positionId,
    amountRaw: null,
    fromAssetId: options.position.assetId,
    toAssetId: null,
    targetWeightPct: null,
    executionShapeKey: options.claimShapeKey,
    executionInput: null,
    authorizedSpends: [],
    rationale:
      options.rationale ?? `Unwind claim ${options.position.positionId}`,
    dependencies: [],
  };
}

/**
 * Host-built close-all wave: one next step per position (claim → uncommit → exit)
 * plus LST receipt unstakes. No LLM. Empty dependencies for foundation-wave exec.
 */
export function planUnwindWave(
  snapshot: PortfolioSnapshot,
  opportunities: Opportunity[],
  options: { idPrefix?: string } = {},
): UnwindWavePlan {
  const idPrefix = options.idPrefix ?? "unwind";
  const skipped: UnwindSkip[] = [];
  const drafted: Array<{
    kind: UnwindStepKind;
    action: PortfolioAction;
  }> = [];

  for (const position of snapshot.positions) {
    if (position.positionType === "debt") {
      skipped.push({
        positionId: position.positionId,
        reason: "debt positions are not auto-unwound",
      });
      continue;
    }
    if (BigInt(position.amountRaw) <= 0n) {
      skipped.push({
        positionId: position.positionId,
        reason: "zero amount",
      });
      continue;
    }
    const step = pickNextPositionStep(position);
    if (!step) {
      skipped.push({
        positionId: position.positionId,
        reason: "no compatible exit/manage shape keys",
      });
      continue;
    }
    const opportunity =
      findOpportunity(opportunities, position.opportunityId) ??
      stubOpportunityForPosition(position);
    const id = `${idPrefix}-${step.kind}-${sanitizeId(position.positionId)}`;
    if (step.kind === "claim") {
      drafted.push({
        kind: "claim",
        action: buildClaimAction({
          id,
          position,
          claimShapeKey: step.shapeKey,
        }),
      });
    } else {
      drafted.push({
        kind: step.kind,
        action: buildExitAction({
          id,
          position,
          opportunity,
          exitShapeKey: step.shapeKey,
          rationale: `Unwind ${step.kind} ${position.positionId}`,
        }),
      });
    }
  }

  const receiptIds = knownLstReceiptAssetIds(snapshot, opportunities);
  const enriched = enrichOpportunitiesForLstUnstake(opportunities, receiptIds);
  for (const receiptAssetId of receiptIds) {
    const amount = spendableRaw(snapshot, receiptAssetId);
    if (amount <= 0n) {
      continue;
    }
    const resolved = resolveLstUnstake(enriched, receiptAssetId);
    if (!resolved) {
      skipped.push({
        assetId: receiptAssetId,
        reason: "no resolvable LST unstake/redeem shape",
      });
      continue;
    }
    try {
      drafted.push({
        kind: "lst",
        action: buildLstUnstakeAction({
          id: `${idPrefix}-lst-${receiptAssetId}`,
          opportunity: resolved.opportunity,
          unstakeShapeKey: resolved.unstakeShapeKey,
          receiptAssetId,
          amountRaw: amount.toString(),
          rationale: `Unwind LST receipt ASA ${receiptAssetId}`,
        }),
      });
    } catch (error) {
      skipped.push({
        assetId: receiptAssetId,
        reason:
          error instanceof Error
            ? error.message
            : "failed to build LST unstake action",
      });
    }
  }

  drafted.sort(
    (left, right) =>
      stepPriority(left.kind) - stepPriority(right.kind) ||
      left.action.id.localeCompare(right.action.id),
  );
  const actions = drafted.map((entry) => entry.action);
  const fingerprint = fingerprintActions(actions);
  const summary =
    actions.length === 0
      ? skipped.length === 0
        ? "Nothing to unwind."
        : `Nothing actionable (${skipped.length} skipped).`
      : `Wave plan: ${actions.length} action(s)` +
        (skipped.length > 0 ? `, ${skipped.length} skipped` : "");

  return { actions, skipped, fingerprint, summary };
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9:_-]+/g, "_").slice(0, 80);
}

export function unwindPolicyConfig(
  signingEnabled: boolean,
): ConstructorParameters<typeof PortfolioPolicy>[0] {
  return {
    maxPositionPct: 100,
    maxProtocolPct: 100,
    minLiquidReservePct: 0,
    minTvlUsd: 0,
    maxSourceAgeHours: 24 * 365,
    minProjectedNetImprovementUsd: 0,
    signingEnabled,
    blockIncompleteSnapshot: false,
  };
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

export function buildUnwindPlan(
  snapshot: PortfolioSnapshot,
  actions: PortfolioAction[],
): PortfolioPlan {
  const liquid = liquidAllocation(snapshot);
  return {
    currentAllocations: [liquid],
    targetAllocations: [{ ...liquid, weightPct: 100 }],
    actions,
    holdDecisions:
      actions.length === 0 ? ["Already flat / nothing to unwind"] : [],
    currentAnnualizedReturnPct: 0,
    targetAnnualizedReturnPct: 0,
    estimatedOneTimeCostsUsd: 0,
    projectedNetBenefitUsd: 0,
    holdingHorizonDays: 1,
    evidence: ["deterministic host unwind"],
    assumptions: ["Close-all without LLM; multi-wave foundation execution"],
    risks: ["Mainnet execution with real funds"],
    confidence: 1,
    summary: "Deterministic DeFi unwind",
  };
}

export function formatUnwindPreview(plan: UnwindWavePlan): string {
  const lines = ["Unwind preview (host-built, no LLM):"];
  if (plan.actions.length === 0) {
    lines.push("(no actions)");
  } else {
    for (const action of plan.actions.slice(0, 20)) {
      const target =
        action.positionId ??
        (action.fromAssetId !== null ? `asa:${action.fromAssetId}` : "?");
      lines.push(
        `• ${action.type} ${action.protocol ?? "?"} ${target} · ${action.executionShapeKey ?? "no-shape"}`,
      );
    }
    if (plan.actions.length > 20) {
      lines.push(`… +${plan.actions.length - 20} more`);
    }
  }
  if (plan.skipped.length > 0) {
    lines.push("Skipped:");
    for (const skip of plan.skipped.slice(0, 10)) {
      lines.push(
        `• ${skip.positionId ?? (skip.assetId !== undefined ? `asa:${skip.assetId}` : "?")}: ${skip.reason}`,
      );
    }
    if (plan.skipped.length > 10) {
      lines.push(`… +${plan.skipped.length - 10} more`);
    }
  }
  lines.push("");
  lines.push(
    "Reply /unwind confirm within 10m to execute (multi-wave until flat or stuck).",
  );
  lines.push("Cancel with /unwind cancel.");
  return lines.join("\n");
}

export function formatUnwindDigest(result: UnwindRunResult): string {
  const lines = [
    `Unwind ${result.id}: ${result.status} (${result.waves.length} wave(s))`,
  ];
  if (result.error) {
    lines.push(`Error: ${result.error}`);
  }
  for (const wave of result.waves) {
    const confirmed = wave.executions.filter(
      (outcome) => outcome.status === "confirmed",
    ).length;
    const failed = wave.executions.filter(
      (outcome) => outcome.status === "failed",
    ).length;
    lines.push(
      `Wave ${wave.wave}: ${wave.plan.actions.length} planned · ${confirmed} confirmed · ${failed} failed` +
        (wave.policyApproved ? "" : " · policy blocked"),
    );
    for (const outcome of wave.executions) {
      if (outcome.status === "confirmed" && outcome.transactionId) {
        lines.push(`  ✓ ${outcome.actionId} · ${outcome.transactionId}`);
      } else if (outcome.status === "failed") {
        lines.push(`  ✗ ${outcome.actionId}: ${outcome.error ?? "failed"}`);
      }
    }
  }
  return lines.join("\n");
}

export interface DeterministicUnwindDeps {
  portfolioReader: PortfolioReader;
  canix: Canix402Client;
  walletAddress: string;
  executor: AlgorandExecutionService;
  coordinator: RunCoordinator;
  signingEnabled: boolean;
  isPaused: () => boolean;
  maxWaves?: number;
}

export class DeterministicUnwindService {
  private readonly maxWaves: number;

  constructor(private readonly deps: DeterministicUnwindDeps) {
    this.maxWaves = deps.maxWaves ?? UNWIND_MAX_WAVES;
  }

  async loadOpportunities(): Promise<{
    opportunities: Opportunity[];
    payments: PaymentReceipt[];
  }> {
    const payments: PaymentReceipt[] = [];
    const opportunities: Opportunity[] = [];
    try {
      const personalized = await this.deps.canix.getPersonalizedOpportunities(
        this.deps.walletAddress,
        25,
      );
      opportunities.push(...personalized.opportunities);
      if (personalized.payment) {
        payments.push(personalized.payment);
      }
    } catch {
      // Personalized may fail; position exits still work via stubs.
    }
    try {
      const listed = await this.deps.canix.getOpportunities(25);
      for (const item of listed.opportunities) {
        if (
          !opportunities.some(
            (candidate) => candidate.opportunityId === item.opportunityId,
          )
        ) {
          opportunities.push(item);
        }
      }
      if (listed.payment) {
        payments.push(listed.payment);
      }
    } catch {
      // Optional catalog enrichment.
    }
    return { opportunities, payments };
  }

  async preview(): Promise<{
    snapshot: PortfolioSnapshot;
    plan: UnwindWavePlan;
    payments: PaymentReceipt[];
  }> {
    const [{ snapshot, payments: snapPayments }, loaded] = await Promise.all([
      this.deps.portfolioReader.read(),
      this.loadOpportunities(),
    ]);
    const receiptIds = knownLstReceiptAssetIds(snapshot, loaded.opportunities);
    const opportunities = enrichOpportunitiesForLstUnstake(
      loaded.opportunities,
      receiptIds,
    );
    const plan = planUnwindWave(snapshot, opportunities, {
      idPrefix: "unwind-preview",
    });
    return {
      snapshot,
      plan,
      payments: [...snapPayments, ...loaded.payments],
    };
  }

  async run(mode: CoordinatorMode = "fail"): Promise<UnwindRunResult> {
    if (this.deps.isPaused()) {
      throw new Error("Trading is paused. /resume before /unwind confirm.");
    }
    if (!this.deps.signingEnabled) {
      throw new Error(
        "Signing is disabled (ENABLE_TRANSACTION_SIGNING). Unwind refuses dry-run close-all.",
      );
    }
    if (this.deps.coordinator.isBusy) {
      throw new RunCoordinatorBusyError();
    }

    return this.deps.coordinator.runExclusive(async () => {
      const id = `unwind-${Date.now().toString(36)}`;
      const startedAt = new Date().toISOString();
      const waves: UnwindWaveResult[] = [];
      const payments: PaymentReceipt[] = [];
      let previousFingerprint: string | null = null;

      try {
        for (let wave = 1; wave <= this.maxWaves; wave += 1) {
          const { snapshot, payments: snapPayments } =
            await this.deps.portfolioReader.read();
          payments.push(...snapPayments);
          const loaded = await this.loadOpportunities();
          payments.push(...loaded.payments);
          const receiptIds = knownLstReceiptAssetIds(
            snapshot,
            loaded.opportunities,
          );
          const opportunities = enrichOpportunitiesForLstUnstake(
            loaded.opportunities,
            receiptIds,
          );
          const wavePlan = planUnwindWave(snapshot, opportunities, {
            idPrefix: `unwind-w${wave}`,
          });

          if (wavePlan.actions.length === 0) {
            return {
              id,
              startedAt,
              completedAt: new Date().toISOString(),
              status: waves.length === 0 ? "no-op" : "completed",
              waves,
              payments,
            };
          }

          if (
            previousFingerprint !== null &&
            wavePlan.fingerprint === previousFingerprint
          ) {
            waves.push({
              wave,
              plan: wavePlan,
              policyApproved: false,
              policyViolations: [
                "Stuck: same action fingerprint as prior wave",
              ],
              executions: [],
            });
            return {
              id,
              startedAt,
              completedAt: new Date().toISOString(),
              status: "stuck",
              waves,
              payments,
            };
          }
          previousFingerprint = wavePlan.fingerprint;

          const normalized = normalizePortfolioPlan(
            buildUnwindPlan(snapshot, wavePlan.actions),
            opportunities,
            snapshot,
          );
          const policy = new PortfolioPolicy(
            unwindPolicyConfig(this.deps.signingEnabled),
          ).validate(snapshot, normalized, opportunities);

          const executions: ExecutionOutcome[] = [];
          if (!policy.approved) {
            waves.push({
              wave,
              plan: wavePlan,
              policyApproved: false,
              policyViolations: policy.violations,
              executions,
            });
            return {
              id,
              startedAt,
              completedAt: new Date().toISOString(),
              status: "stuck",
              waves,
              error: policy.violations.join("; "),
              payments,
            };
          }

          let anyConfirmed = false;
          let anyFailed = false;
          for (const action of normalized.actions) {
            const execution = await this.deps.executor.executeAction(action, {
              opportunities,
            });
            executions.push(execution.outcome);
            payments.push(...execution.payments);
            if (execution.outcome.status === "confirmed") {
              anyConfirmed = true;
            }
            if (execution.outcome.status === "failed") {
              anyFailed = true;
            }
          }

          waves.push({
            wave,
            plan: wavePlan,
            policyApproved: true,
            policyViolations: [],
            executions,
          });

          if (!anyConfirmed && anyFailed) {
            return {
              id,
              startedAt,
              completedAt: new Date().toISOString(),
              status: "stuck",
              waves,
              error: "Wave produced failures and no confirms",
              payments,
            };
          }
        }

        return {
          id,
          startedAt,
          completedAt: new Date().toISOString(),
          status: "max-waves",
          waves,
          payments,
        };
      } catch (error) {
        return {
          id,
          startedAt,
          completedAt: new Date().toISOString(),
          status: "failed",
          waves,
          error: error instanceof Error ? error.message : String(error),
          payments,
        };
      }
    }, mode);
  }
}
