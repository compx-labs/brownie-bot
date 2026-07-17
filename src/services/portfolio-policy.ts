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
  minTvlUsd: number;
  maxSourceAgeHours: number;
  minProjectedNetImprovementUsd: number;
  /** When false, structural and data-quality issues become warnings so planning/dry-run can pass. */
  signingEnabled: boolean;
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
    const currentTotal = sum(
      plan.currentAllocations.map((item) => item.weightPct),
    );
    if (Math.abs(currentTotal - 100) > 0.01) {
      hard.push(
        `Current allocations total ${currentTotal.toFixed(4)}%, not 100%`,
      );
    }
    const targetTotal = sum(
      plan.targetAllocations.map((item) => item.weightPct),
    );
    if (Math.abs(targetTotal - 100) > 0.01) {
      hard.push(
        `Target allocations total ${targetTotal.toFixed(4)}%, not 100%`,
      );
    }
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
      if (this.config.signingEnabled) {
        hard.push(`${incompleteMessage}; only hold is permitted while signing`);
      } else {
        soft.push(
          `${incompleteMessage}; signing is disabled so the plan is still reported`,
        );
      }
    }
    this.validateOpportunityActions(plan, opportunities, hard);
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
        const planIds = [...actions]
          .map((id) => JSON.stringify(id))
          .join(", ");
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
        const missing = [
          !action.executionShapeKey ? "executionShapeKey" : null,
          !action.executionInput ? "executionInput" : null,
        ].filter((value): value is string => value !== null);
        violations.push(
          `Action ${action.id} has no executable shape (missing ${missing.join(" and ")})`,
        );
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
        } else {
          validateEnterShape(action, opportunity, violations);
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
        } else {
          validateExitOrManageShape(action, position, violations);
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
  if (
    action.executionShapeKey &&
    !allowed.includes(action.executionShapeKey)
  ) {
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

function validateRequiredAssets(
  action: PortfolioPlan["actions"][number],
  opportunity: Opportunity,
  plan: PortfolioPlan,
  availableBalances: Map<number, bigint>,
  sink: string[],
): void {
  const required = new Set(
    opportunity.executionShapes.flatMap((shape) => shape.requiredAssetIds),
  );
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
