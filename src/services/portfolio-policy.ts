import type {
  Opportunity,
  OpportunityExecutionShape,
  PolicyResult,
  PortfolioAction,
  PortfolioPlan,
  PortfolioSnapshot,
} from "../domain.js";
import { completeActionExecutionInput } from "./shape-execution-input.js";

export interface PortfolioPolicyConfig {
  maxPositionPct: number;
  maxProtocolPct: number;
  minLiquidReservePct: number;
  minTvlUsd: number;
  maxSourceAgeHours: number;
  minProjectedNetImprovementUsd: number;
  /** When false, structural and data-quality issues become warnings so planning/dry-run can pass. */
  signingEnabled: boolean;
  /**
   * When false, incomplete snapshots warn instead of hard-blocking non-hold plans.
   * Defaults to `signingEnabled`. Protocol-verify disables this so unpriced farm
   * rewards / partial valuations do not stall enter→exit round-trips.
   */
  blockIncompleteSnapshot?: boolean;
  /**
   * ASAs from `PREFERRED_HOLD_ASSETS`. Open/increase into opportunities whose
   * `assetIds` intersect this set skip the `minTvlUsd` hard floor (liquidity
   * building for preferred / home-token markets).
   */
  preferredHoldAssetIds?: number[];
}

/** Host expands these at quote time; standalone plan actions are redundant. */
const PREREQUISITE_SHAPE_ACTIONS = new Set([
  "setup",
  "optin",
  "create",
  "create-escrow",
]);

/**
 * Drop standalone setup/opt-in enter actions when a capital-deploying open/increase
 * for the same opportunity remains (host expands prerequisites at quote time),
 * complete missing executionInput from Canix shape requiredInputs/inputHints
 * (same path for production agent plans and protocol-verify), sync swap
 * authorizedSpends from fromAssetId+amountRaw, and drop dependency entries that
 * are not action ids in this plan.
 */
export function normalizePortfolioPlan(
  plan: PortfolioPlan,
  opportunities: Opportunity[],
  snapshot?: PortfolioSnapshot,
): PortfolioPlan {
  const shapesByKey = new Map<string, OpportunityExecutionShape>();
  for (const opportunity of opportunities) {
    for (const shape of opportunity.executionShapes) {
      shapesByKey.set(shape.shapeKey, shape);
    }
  }

  const capitalOpportunityIds = new Set<string>();
  for (const action of plan.actions) {
    if (!isEnterAction(action) || !action.opportunityId) {
      continue;
    }
    const shape = action.executionShapeKey
      ? shapesByKey.get(action.executionShapeKey)
      : undefined;
    if (shape && !isPrerequisiteShape(shape)) {
      capitalOpportunityIds.add(action.opportunityId);
    }
  }

  const droppedIds = new Set<string>();
  let changed = false;
  const actions = plan.actions.flatMap((action) => {
    if (isEnterAction(action) && action.opportunityId) {
      const shape = action.executionShapeKey
        ? shapesByKey.get(action.executionShapeKey)
        : undefined;
      if (
        shape &&
        isPrerequisiteShape(shape) &&
        capitalOpportunityIds.has(action.opportunityId)
      ) {
        droppedIds.add(action.id);
        changed = true;
        return [];
      }
    }
    const filled = syncSwapAuthorizedSpend(
      completeActionExecutionInput(action, opportunities, snapshot),
    );
    if (filled !== action) {
      changed = true;
    }
    return [filled];
  });

  const actionIds = new Set(actions.map((action) => action.id));
  const normalizedActions = actions.map((action) => {
    const dependencies = action.dependencies.filter((dependency) => {
      if (droppedIds.has(dependency)) {
        return false;
      }
      if (dependency === action.id) {
        return true;
      }
      if (actionIds.has(dependency)) {
        return true;
      }
      // Shape keys / invented prerequisite labels are not executable dependencies.
      changed = true;
      console.warn(
        `[portfolio-policy] Dropping non-action dependency ${JSON.stringify(dependency)} from action ${JSON.stringify(action.id)}`,
      );
      return false;
    });
    if (dependencies.length !== action.dependencies.length) {
      changed = true;
      return { ...action, dependencies };
    }
    return action;
  });

  if (!changed) {
    return plan;
  }

  return {
    ...plan,
    actions: normalizedActions,
  };
}

function isEnterAction(action: PortfolioAction): boolean {
  return action.type === "open" || action.type === "increase";
}

function isPrerequisiteShape(shape: OpportunityExecutionShape): boolean {
  return PREREQUISITE_SHAPE_ACTIONS.has(shape.action.toLowerCase());
}

/**
 * Swaps must declare exactly one authorizedSpend matching fromAssetId+amountRaw.
 * LLM plans often drift (empty spends, wrong asset, mismatched amount) — rewrite
 * from the swap input when those fields are present and positive.
 */
export function syncSwapAuthorizedSpend(
  action: PortfolioAction,
): PortfolioAction {
  if (action.type !== "swap") {
    return action;
  }
  if (
    action.fromAssetId === null ||
    action.amountRaw === null ||
    !/^[1-9][0-9]*$/.test(action.amountRaw)
  ) {
    return action;
  }
  const expected = {
    assetId: action.fromAssetId,
    amountRaw: action.amountRaw,
  };
  if (
    action.authorizedSpends.length === 1 &&
    action.authorizedSpends[0]?.assetId === expected.assetId &&
    action.authorizedSpends[0]?.amountRaw === expected.amountRaw
  ) {
    return action;
  }
  return {
    ...action,
    authorizedSpends: [expected],
  };
}

export class PortfolioPolicy {
  constructor(private readonly config: PortfolioPolicyConfig) {}

  validate(
    snapshot: PortfolioSnapshot,
    plan: PortfolioPlan,
    opportunities: Opportunity[],
  ): PolicyResult {
    const hard: string[] = [];
    const soft: string[] = [];
    this.validatePlanStructure(snapshot, plan, opportunities, hard, soft);
    // Liquid (protocol=null) is a reserve floor, not a position-size cap.
    const deployedWeights = plan.targetAllocations
      .filter((item) => item.protocol !== null)
      .map((item) => item.weightPct);
    const maxPositionPct = Math.max(0, ...deployedWeights);
    if (maxPositionPct > this.config.maxPositionPct) {
      soft.push(
        `Target position ${maxPositionPct}% exceeds guidance of ${this.config.maxPositionPct}%`,
      );
    }
    const protocolWeights = new Map<string, number>();
    for (const allocation of plan.targetAllocations) {
      if (allocation.protocol) {
        protocolWeights.set(
          allocation.protocol,
          (protocolWeights.get(allocation.protocol) ?? 0) +
            allocation.weightPct,
        );
      }
    }
    const maxProtocolPct = Math.max(0, ...protocolWeights.values());
    if (maxProtocolPct > this.config.maxProtocolPct) {
      soft.push(
        `Target protocol allocation ${maxProtocolPct}% exceeds guidance of ${this.config.maxProtocolPct}%`,
      );
    }
    const liquidReservePct = sum(
      plan.targetAllocations
        .filter((item) => item.protocol === null)
        .map((item) => item.weightPct),
    );
    if (liquidReservePct < this.config.minLiquidReservePct) {
      soft.push(
        `Liquid reserve ${liquidReservePct}% is below guidance of ${this.config.minLiquidReservePct}%`,
      );
    }
    const currentWeights = new Map(
      plan.currentAllocations.map((item) => [item.key, item.weightPct]),
    );
    const allKeys = new Set([
      ...currentWeights.keys(),
      ...plan.targetAllocations.map((item) => item.key),
    ]);
    const targetWeights = new Map(
      plan.targetAllocations.map((item) => [item.key, item.weightPct]),
    );
    const turnoverPct =
      sum(
        [...allKeys].map((key) =>
          Math.abs(
            (targetWeights.get(key) ?? 0) - (currentWeights.get(key) ?? 0),
          ),
        ),
      ) / 2;
    if (
      plan.actions.some((action) => action.type !== "hold") &&
      plan.projectedNetBenefitUsd < this.config.minProjectedNetImprovementUsd
    ) {
      soft.push(
        `Projected net benefit is below guidance of $${this.config.minProjectedNetImprovementUsd}`,
      );
    }
    if (
      !snapshot.complete &&
      plan.actions.some((action) => action.type !== "hold")
    ) {
      const causes =
        snapshot.caveats.length > 0
          ? snapshot.caveats.join("; ")
          : "no caveats were recorded";
      const incompleteMessage = `Portfolio snapshot is incomplete (${causes})`;
      const blockIncomplete =
        this.config.blockIncompleteSnapshot ?? this.config.signingEnabled;
      if (blockIncomplete) {
        hard.push(`${incompleteMessage}; only hold is permitted while signing`);
      } else if (!this.config.signingEnabled) {
        soft.push(
          `${incompleteMessage}; signing is disabled so the plan is still reported`,
        );
      } else {
        soft.push(
          `${incompleteMessage}; continuing despite incomplete snapshot`,
        );
      }
    }
    const positions = new Map(
      snapshot.positions.map((position) => [position.positionId, position]),
    );
    this.validateOpportunityActions(plan, opportunities, hard, positions);
    if (this.config.signingEnabled) {
      return {
        approved: hard.length === 0,
        violations: hard,
        warnings: soft,
        metrics: {
          maxPositionPct,
          maxProtocolPct,
          liquidReservePct,
          turnoverPct,
        },
      };
    }
    return {
      approved: true,
      violations: [],
      warnings: [
        ...soft,
        ...hard.map(
          (violation) => `Would block if signing enabled: ${violation}`,
        ),
      ],
      metrics: {
        maxPositionPct,
        maxProtocolPct,
        liquidReservePct,
        turnoverPct,
      },
    };
  }

  private validatePlanStructure(
    snapshot: PortfolioSnapshot,
    plan: PortfolioPlan,
    opportunities: Opportunity[],
    violations: string[],
    soft: string[],
  ): void {
    reportDuplicates(
      plan.currentAllocations.map((allocation) => allocation.key),
      "current allocation key",
      violations,
    );
    reportDuplicates(
      plan.targetAllocations.map((allocation) => allocation.key),
      "target allocation key",
      violations,
    );
    reportDuplicates(
      plan.actions.map((action) => action.id),
      "action ID",
      violations,
    );

    const actions = new Set(plan.actions.map((action) => action.id));
    const positions = new Map(
      snapshot.positions.map((position) => [position.positionId, position]),
    );
    const opportunityById = new Map(
      opportunities.map((opportunity) => [
        opportunity.opportunityId,
        opportunity,
      ]),
    );
    const existingOpportunityIds = new Set(
      snapshot.positions.flatMap((position) =>
        position.opportunityId ? [position.opportunityId] : [],
      ),
    );
    const availableBalances = new Map(
      snapshot.liquidBalances.map((balance) => [
        balance.assetId,
        BigInt(balance.spendableAmountRaw ?? balance.amountRaw),
      ]),
    );

    for (const allocation of plan.targetAllocations) {
      if (
        allocation.opportunityId &&
        !opportunityById.has(allocation.opportunityId) &&
        !existingOpportunityIds.has(allocation.opportunityId)
      ) {
        soft.push(
          `Target allocation ${allocation.key} references an unknown opportunity`,
        );
      }
      const opportunity = allocation.opportunityId
        ? opportunityById.get(allocation.opportunityId)
        : undefined;
      if (
        opportunity &&
        allocation.protocol &&
        opportunity.protocol !== allocation.protocol
      ) {
        violations.push(
          `Target allocation ${allocation.key} has a protocol mismatch`,
        );
      }
    }

    for (const action of plan.actions) {
      const missingDependencies = action.dependencies.filter(
        (dependency) => !actions.has(dependency),
      );
      if (action.dependencies.includes(action.id)) {
        violations.push(
          `Action ${action.id} has invalid dependencies: depends on itself`,
        );
      } else if (missingDependencies.length > 0) {
        const quotedMissing = missingDependencies
          .map((dependency) => JSON.stringify(dependency))
          .join(", ");
        const planIds = [...actions].map((id) => JSON.stringify(id)).join(", ");
        violations.push(
          `Action ${action.id} depends on ${quotedMissing} but the plan only defines action ID(s) ${planIds}`,
        );
      }
      if (action.type === "hold") {
        continue;
      }
      if (action.amountRaw !== null && BigInt(action.amountRaw) === 0n) {
        violations.push(`Action ${action.id} has a zero amount`);
      }
      const spendAssetIds = action.authorizedSpends.map(
        (spend) => spend.assetId,
      );
      if (new Set(spendAssetIds).size !== spendAssetIds.length) {
        violations.push(`Action ${action.id} has duplicate authorized spends`);
      }
      if (action.type === "swap") {
        if (
          action.fromAssetId === null ||
          action.toAssetId === null ||
          action.fromAssetId === action.toAssetId ||
          action.amountRaw === null
        ) {
          violations.push(`Swap action ${action.id} is incomplete`);
        }
        if (
          action.authorizedSpends.length !== 1 ||
          action.authorizedSpends[0]?.assetId !== action.fromAssetId ||
          action.authorizedSpends[0]?.amountRaw !== action.amountRaw
        ) {
          violations.push(
            `Swap action ${action.id} authorized spend does not match its input`,
          );
        }
        continue;
      }
      if (!action.executionShapeKey || !action.executionInput) {
        const missing = [
          !action.executionShapeKey ? "executionShapeKey" : null,
          !action.executionInput ? "executionInput" : null,
        ].filter((value): value is string => value !== null);
        violations.push(
          `Action ${action.id} has no executable shape (missing ${missing.join(" and ")})`,
        );
      }
      if (["open", "increase"].includes(action.type)) {
        const opportunity = action.opportunityId
          ? opportunityById.get(action.opportunityId)
          : undefined;
        const existingPosition = action.positionId
          ? positions.get(action.positionId)
          : undefined;
        if (!opportunity) {
          // Topping up a known position: catalog may omit the validator/pool
          // even though the wallet already holds it. Allow when position binds
          // the opportunity and execution shape/input are present.
          const topsUpHeldPosition =
            action.type === "increase" &&
            existingPosition &&
            Boolean(action.executionShapeKey) &&
            Boolean(action.executionInput) &&
            (action.opportunityId === null ||
              action.opportunityId === existingPosition.opportunityId);
          if (topsUpHeldPosition) {
            soft.push(
              `Action ${action.id} increases held position ${existingPosition.positionId} without a researched opportunity catalog entry`,
            );
            if (
              action.protocol &&
              action.protocol !== existingPosition.protocol
            ) {
              violations.push(`Action ${action.id} has a protocol mismatch`);
            }
            if (
              action.authorizedSpends.length === 0 &&
              actionRequiresDeclaredSpend(action, undefined)
            ) {
              violations.push(
                `Action ${action.id} has no declared treasury spend`,
              );
            }
          } else {
            violations.push(
              `Action ${action.id} does not reference a researched opportunity`,
            );
          }
        } else if (
          action.protocol &&
          action.protocol !== opportunity.protocol
        ) {
          violations.push(`Action ${action.id} has a protocol mismatch`);
        } else {
          validateEnterShape(action, opportunity, violations);
          const shape = opportunity.executionShapes.find(
            (candidate) => candidate.shapeKey === action.executionShapeKey,
          );
          if (
            action.authorizedSpends.length === 0 &&
            actionRequiresDeclaredSpend(action, shape)
          ) {
            violations.push(
              `Action ${action.id} has no declared treasury spend`,
            );
          }
          validateRequiredAssets(
            action,
            opportunity,
            plan,
            availableBalances,
            this.config.signingEnabled ? violations : soft,
          );
        }
      }
      if (["reduce", "close", "claim"].includes(action.type)) {
        // reduce/close/claim withdraw or manage an existing position; sizing is
        // amountRaw / executionInput, not treasury authorizedSpends.
        const position = action.positionId
          ? positions.get(action.positionId)
          : undefined;
        if (!position) {
          violations.push(
            `Action ${action.id} does not reference a current position`,
          );
        } else if (action.protocol && action.protocol !== position.protocol) {
          violations.push(`Action ${action.id} has a protocol mismatch`);
        } else {
          validateExitOrManageShape(action, position, violations);
        }
      }
    }
  }

  private validateOpportunityActions(
    plan: PortfolioPlan,
    opportunities: Opportunity[],
    violations: string[],
    positions: Map<string, PortfolioSnapshot["positions"][number]>,
  ): void {
    const now = Date.now();
    for (const action of plan.actions) {
      if (
        !["open", "increase"].includes(action.type) ||
        !action.opportunityId
      ) {
        continue;
      }
      const opportunity = opportunities.find(
        (candidate) => candidate.opportunityId === action.opportunityId,
      );
      if (!opportunity) {
        const existingPosition = action.positionId
          ? positions.get(action.positionId)
          : undefined;
        if (
          action.type === "increase" &&
          existingPosition &&
          existingPosition.opportunityId === action.opportunityId
        ) {
          // Already soft-warned in validatePlanStructure when catalog-missing.
          continue;
        }
        violations.push(
          `Action ${action.id} references an opportunity not returned by MCP`,
        );
        continue;
      }
      if (
        opportunity.tvlUsd < this.config.minTvlUsd &&
        !opportunityTouchesPreferredHold(
          opportunity,
          this.config.preferredHoldAssetIds ?? [],
        )
      ) {
        violations.push(
          `Action ${action.id} TVL is below $${this.config.minTvlUsd}`,
        );
      }
      const ageHours =
        (now - new Date(opportunity.sourceTimestamp).getTime()) / 3_600_000;
      if (
        !Number.isFinite(ageHours) ||
        ageHours > this.config.maxSourceAgeHours
      ) {
        violations.push(
          `Action ${action.id} opportunity data is stale (${ageHours.toFixed(2)}h)`,
        );
      }
    }
  }
}

function validateEnterShape(
  action: PortfolioPlan["actions"][number],
  opportunity: Opportunity,
  violations: string[],
): void {
  if (!opportunity.executionReady || opportunity.executionShapes.length === 0) {
    violations.push(
      `Action ${action.id} targets opportunity ${opportunity.opportunityId} which is research-only (executionReady=false or empty executionShapes)`,
    );
    return;
  }
  const allowed = opportunity.executionShapes.map((shape) => shape.shapeKey);
  if (action.executionShapeKey && !allowed.includes(action.executionShapeKey)) {
    violations.push(
      `Action ${action.id} executionShapeKey ${JSON.stringify(action.executionShapeKey)} is not in opportunity ${opportunity.opportunityId} enter shapes [${allowed.map((key) => JSON.stringify(key)).join(", ")}]`,
    );
  }
}

function validateExitOrManageShape(
  action: PortfolioPlan["actions"][number],
  position: PortfolioSnapshot["positions"][number],
  violations: string[],
): void {
  if (!action.executionShapeKey) {
    return;
  }
  const allowed = [
    ...position.compatibleExitShapeKeys,
    ...position.compatibleManageShapeKeys,
  ];
  if (allowed.length === 0) {
    violations.push(
      `Action ${action.id} targets position ${position.positionId} with no compatibleExitShapeKeys/compatibleManageShapeKeys`,
    );
    return;
  }
  if (!allowed.includes(action.executionShapeKey)) {
    violations.push(
      `Action ${action.id} executionShapeKey ${JSON.stringify(action.executionShapeKey)} is not in position ${position.positionId} exit/manage keys [${allowed.map((key) => JSON.stringify(key)).join(", ")}]`,
    );
  }
}

function isSingleAssetEnterShape(
  shape: OpportunityExecutionShape,
): boolean {
  const key = shape.shapeKey.toLowerCase();
  const variant = shape.variant.toLowerCase();
  return key.includes("singleasset") || variant.includes("singleasset");
}

function parseAssetId(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return null;
}

/**
 * Assets the action must already hold (or produce via a dependency swap).
 * Uses the selected enter shape when present; single-sided adds narrow to the
 * deposit asset so Canix pool-pair requiredAssetIds do not falsely require the
 * other side.
 */
export function effectiveRequiredAssetIds(
  action: PortfolioPlan["actions"][number],
  opportunity: Opportunity,
): number[] {
  const selected = action.executionShapeKey
    ? opportunity.executionShapes.find(
        (shape) => shape.shapeKey === action.executionShapeKey,
      )
    : undefined;

  if (!selected) {
    return [
      ...new Set(
        opportunity.executionShapes.flatMap((shape) => shape.requiredAssetIds),
      ),
    ];
  }

  if (isSingleAssetEnterShape(selected)) {
    const fromInput = parseAssetId(action.executionInput?.depositAssetId);
    if (fromInput !== null) {
      return [fromInput];
    }
    if (action.fromAssetId !== null) {
      return [action.fromAssetId];
    }
    const spendIds = [
      ...new Set(action.authorizedSpends.map((spend) => spend.assetId)),
    ];
    if (spendIds.length === 1) {
      return spendIds;
    }
  }

  return [...new Set(selected.requiredAssetIds)];
}

function validateRequiredAssets(
  action: PortfolioPlan["actions"][number],
  opportunity: Opportunity,
  plan: PortfolioPlan,
  availableBalances: Map<number, bigint>,
  sink: string[],
): void {
  const required = new Set(effectiveRequiredAssetIds(action, opportunity));
  if (required.size === 0) {
    return;
  }
  const coveredBySwaps = new Set(
    plan.actions
      .filter(
        (candidate) =>
          candidate.type === "swap" &&
          action.dependencies.includes(candidate.id) &&
          candidate.toAssetId !== null,
      )
      .map((candidate) => candidate.toAssetId as number),
  );
  const missing = [...required].filter((assetId) => {
    if ((availableBalances.get(assetId) ?? 0n) > 0n) {
      return false;
    }
    return !coveredBySwaps.has(assetId);
  });
  if (missing.length > 0) {
    sink.push(
      `Action ${action.id} requires asset ID(s) ${missing.join(", ")} (from executionShapes.requiredAssetIds) but liquid balances lack them and no dependency swap produces them`,
    );
  }
}

/** Preferred-hold markets skip the global `minTvlUsd` floor while bootstrapping liquidity. */
export function opportunityTouchesPreferredHold(
  opportunity: Opportunity,
  preferredHoldAssetIds: number[],
): boolean {
  if (preferredHoldAssetIds.length === 0) {
    return false;
  }
  const preferred = new Set(preferredHoldAssetIds);
  return (opportunity.assetIds ?? []).some((assetId) => preferred.has(assetId));
}

/** True when this open/increase must declare authorizedSpends (capital transfer). */
function actionRequiresDeclaredSpend(
  action: PortfolioPlan["actions"][number],
  shape: Opportunity["executionShapes"][number] | undefined,
): boolean {
  const shapeKey = (
    action.executionShapeKey ??
    shape?.shapeKey ??
    ""
  ).toLowerCase();
  const shapeAction = (shape?.action ?? "").toLowerCase();
  // Borrow receives assets; collateral sync/reduce move escrow balances, not
  // treasury spends (amounts are already locked in the loan).
  if (
    shapeKey.includes("borrow") ||
    shapeAction === "borrow" ||
    shapeKey.includes("collateral") ||
    shapeAction === "collateral"
  ) {
    return false;
  }
  if (action.amountRaw !== null && BigInt(action.amountRaw) > 0n) {
    return true;
  }
  if (!shape) {
    return false;
  }
  return shape.requiredInputs.some((input) => {
    const lower = input.toLowerCase();
    // borrowAmount / repayAmount are not treasury spends.
    if (lower.includes("borrow") || lower.includes("repay")) {
      return false;
    }
    return /amount/i.test(input);
  });
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function reportDuplicates(
  values: string[],
  label: string,
  violations: string[],
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      violations.push(`Duplicate ${label}: ${value}`);
    }
    seen.add(value);
  }
}
