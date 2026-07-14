import { describe, expect, it } from "vitest";

import type { PortfolioAction } from "../src/domain.js";
import { PortfolioPolicy } from "../src/services/portfolio-policy.js";
import { opportunity, portfolioPlan, portfolioSnapshot } from "./fixtures.js";

const policy = new PortfolioPolicy({
  maxPositionPct: 60,
  maxProtocolPct: 70,
  minLiquidReservePct: 10,
  maxDailyTurnoverPct: 50,
  minTvlUsd: 100_000,
  maxSourceAgeHours: 24,
  minHoldingHorizonDays: 30,
  minProjectedNetImprovementUsd: 1,
});

const liquid = {
  key: "liquid:usdc",
  protocol: null,
  opportunityId: null,
  assetIds: [31_566_704],
  weightPct: 100,
  expectedApyPct: 0,
};

function openAction(overrides: Partial<PortfolioAction> = {}): PortfolioAction {
  return {
    id: "open-1",
    type: "open",
    protocol: "tinyman",
    opportunityId: "tinyman:pool:1",
    positionId: null,
    amountRaw: "100000000",
    fromAssetId: 31_566_704,
    toAssetId: null,
    targetWeightPct: 40,
    executionShapeKey: "tinyman:open",
    executionInput: { amount: "100000000" },
    rationale: "Diversify into a researched opportunity.",
    dependencies: [],
    ...overrides,
    authorizedSpends: overrides.authorizedSpends ?? [
      { assetId: 31_566_704, amountRaw: "100000000" },
    ],
  };
}

describe("PortfolioPolicy", () => {
  it("approves a complete, diversified plan based on researched data", () => {
    const candidate = opportunity({
      sourceTimestamp: new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
    });
    const result = policy.validate(
      portfolioSnapshot(),
      portfolioPlan({
        currentAllocations: [liquid],
        targetAllocations: [
          { ...liquid, weightPct: 60 },
          {
            key: "opportunity:tinyman:pool:1",
            protocol: "tinyman",
            opportunityId: candidate.opportunityId,
            assetIds: candidate.assetIds ?? [],
            weightPct: 40,
            expectedApyPct: candidate.apy,
          },
        ],
        actions: [openAction()],
        projectedNetBenefitUsd: 10,
      }),
      [candidate],
    );

    expect(result.approved).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("blocks actions when the on-chain snapshot is incomplete", () => {
    const result = policy.validate(
      portfolioSnapshot({ complete: false }),
      portfolioPlan({
        currentAllocations: [liquid],
        targetAllocations: [liquid],
        actions: [openAction()],
        projectedNetBenefitUsd: 10,
      }),
      [],
    );

    expect(result.approved).toBe(false);
    expect(result.violations).toContain(
      "Portfolio snapshot is incomplete; only hold is permitted",
    );
  });

  it("rejects unknown opportunities, malformed dependencies, and zero amounts", () => {
    const result = policy.validate(
      portfolioSnapshot(),
      portfolioPlan({
        currentAllocations: [liquid],
        targetAllocations: [
          {
            ...liquid,
            key: "unknown",
            opportunityId: "invented",
          },
        ],
        actions: [
          openAction({
            amountRaw: "0",
            opportunityId: "invented",
            dependencies: ["missing"],
          }),
        ],
        projectedNetBenefitUsd: 10,
      }),
      [],
    );

    expect(result.approved).toBe(false);
    expect(result.violations.join("\n")).toMatch(
      /unknown opportunity|invalid dependencies|zero amount|researched opportunity/,
    );
  });

  it("rejects duplicate action IDs and unsafe concentration", () => {
    const candidate = opportunity({
      sourceTimestamp: new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
    });
    const result = policy.validate(
      portfolioSnapshot(),
      portfolioPlan({
        currentAllocations: [liquid],
        targetAllocations: [
          {
            key: "concentrated",
            protocol: "tinyman",
            opportunityId: candidate.opportunityId,
            assetIds: candidate.assetIds ?? [],
            weightPct: 100,
            expectedApyPct: candidate.apy,
          },
        ],
        actions: [openAction(), openAction()],
        projectedNetBenefitUsd: 10,
      }),
      [candidate],
    );

    expect(result.approved).toBe(false);
    expect(result.violations).toContain("Duplicate action ID: open-1");
    expect(result.metrics.maxPositionPct).toBe(100);
    expect(result.metrics.maxProtocolPct).toBe(100);
  });

  it("rejects spends above the fresh on-chain liquid balance", () => {
    const candidate = opportunity({
      sourceTimestamp: new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
    });
    const result = policy.validate(
      portfolioSnapshot(),
      portfolioPlan({
        currentAllocations: [liquid],
        targetAllocations: [liquid],
        actions: [
          openAction({
            authorizedSpends: [
              { assetId: 31_566_704, amountRaw: "1000000001" },
            ],
          }),
        ],
        projectedNetBenefitUsd: 10,
      }),
      [candidate],
    );

    expect(result.violations).toContain(
      "Planned spend of asset 31566704 exceeds the on-chain spendable balance",
    );
  });
});
