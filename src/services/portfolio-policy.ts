import type {
  Opportunity,
  PolicyResult,
  PortfolioPlan,
  PortfolioSnapshot,
} from "../domain.js";

export interface PortfolioPolicyConfig {
  maxPositionPct: number;
  maxProtocolPct: number;
  minLiquidReservePct: number;
  maxDailyTurnoverPct: number;
  minTvlUsd: number;
  maxSourceAgeHours: number;
  minHoldingHorizonDays: number;
  minProjectedNetImprovementUsd: number;
}

export class PortfolioPolicy {
  constructor(private readonly config: PortfolioPolicyConfig) {}

  validate(
    snapshot: PortfolioSnapshot,
    plan: PortfolioPlan,
    opportunities: Opportunity[],
  ): PolicyResult {
    const violations: string[] = [];
    this.validatePlanStructure(snapshot, plan, opportunities, violations);
    const currentTotal = sum(
      plan.currentAllocations.map((item) => item.weightPct),
    );
    if (Math.abs(currentTotal - 100) > 0.01) {
      violations.push(
        `Current allocations total ${currentTotal.toFixed(4)}%, not 100%`,
      );
    }
    const targetTotal = sum(
      plan.targetAllocations.map((item) => item.weightPct),
    );
    if (Math.abs(targetTotal - 100) > 0.01) {
      violations.push(
        `Target allocations total ${targetTotal.toFixed(4)}%, not 100%`,
      );
    }
    const maxPositionPct = Math.max(
      0,
      ...plan.targetAllocations.map((item) => item.weightPct),
    );
    if (maxPositionPct > this.config.maxPositionPct) {
      violations.push(
        `Target position ${maxPositionPct}% exceeds ${this.config.maxPositionPct}%`,
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
      violations.push(
        `Target protocol allocation ${maxProtocolPct}% exceeds ${this.config.maxProtocolPct}%`,
      );
    }
    const liquidReservePct = sum(
      plan.targetAllocations
        .filter((item) => item.protocol === null)
        .map((item) => item.weightPct),
    );
    if (liquidReservePct < this.config.minLiquidReservePct) {
      violations.push(
        `Liquid reserve ${liquidReservePct}% is below ${this.config.minLiquidReservePct}%`,
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
    if (turnoverPct > this.config.maxDailyTurnoverPct) {
      violations.push(
        `Planned turnover ${turnoverPct}% exceeds ${this.config.maxDailyTurnoverPct}%`,
      );
    }
    if (plan.holdingHorizonDays < this.config.minHoldingHorizonDays) {
      violations.push(
        `Holding horizon is below ${this.config.minHoldingHorizonDays} days`,
      );
    }
    if (
      plan.actions.some((action) => action.type !== "hold") &&
      plan.projectedNetBenefitUsd < this.config.minProjectedNetImprovementUsd
    ) {
      violations.push(
        `Projected net benefit is below $${this.config.minProjectedNetImprovementUsd}`,
      );
    }
    if (
      !snapshot.complete &&
      plan.actions.some((action) => action.type !== "hold")
    ) {
      violations.push(
        "Portfolio snapshot is incomplete; only hold is permitted",
      );
    }
    this.validateOpportunityActions(plan, opportunities, violations);
    return {
      approved: violations.length === 0,
      violations,
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
    const plannedSpends = new Map<number, bigint>();

    for (const allocation of plan.targetAllocations) {
      if (
        allocation.opportunityId &&
        !opportunityById.has(allocation.opportunityId) &&
        !existingOpportunityIds.has(allocation.opportunityId)
      ) {
        violations.push(
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
      if (
        action.dependencies.includes(action.id) ||
        action.dependencies.some((dependency) => !actions.has(dependency))
      ) {
        violations.push(`Action ${action.id} has invalid dependencies`);
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
      for (const spend of action.authorizedSpends) {
        plannedSpends.set(
          spend.assetId,
          (plannedSpends.get(spend.assetId) ?? 0n) + BigInt(spend.amountRaw),
        );
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
        violations.push(`Action ${action.id} has no executable shape`);
      }
      if (["open", "increase"].includes(action.type)) {
        if (action.authorizedSpends.length === 0) {
          violations.push(`Action ${action.id} has no declared treasury spend`);
        }
        const opportunity = action.opportunityId
          ? opportunityById.get(action.opportunityId)
          : undefined;
        if (!opportunity) {
          violations.push(
            `Action ${action.id} does not reference a researched opportunity`,
          );
        } else if (
          action.protocol &&
          action.protocol !== opportunity.protocol
        ) {
          violations.push(`Action ${action.id} has a protocol mismatch`);
        }
      }
      if (["reduce", "close", "claim"].includes(action.type)) {
        if (action.type === "reduce" && action.authorizedSpends.length === 0) {
          violations.push(`Action ${action.id} has no declared treasury spend`);
        }
        const position = action.positionId
          ? positions.get(action.positionId)
          : undefined;
        if (!position) {
          violations.push(
            `Action ${action.id} does not reference a current position`,
          );
        } else if (action.protocol && action.protocol !== position.protocol) {
          violations.push(`Action ${action.id} has a protocol mismatch`);
        }
      }
    }
    for (const [assetId, amount] of plannedSpends) {
      if (amount > (availableBalances.get(assetId) ?? 0n)) {
        violations.push(
          `Planned spend of asset ${assetId} exceeds the on-chain spendable balance`,
        );
      }
    }
  }

  private validateOpportunityActions(
    plan: PortfolioPlan,
    opportunities: Opportunity[],
    violations: string[],
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
        violations.push(
          `Action ${action.id} references an opportunity not returned by MCP`,
        );
        continue;
      }
      if (opportunity.tvlUsd < this.config.minTvlUsd) {
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
