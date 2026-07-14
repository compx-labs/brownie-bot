import type {
  Opportunity,
  PortfolioPlan,
  PortfolioSnapshot,
} from "../src/domain.js";

export function opportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    protocol: "tinyman",
    opportunityType: "lp",
    opportunityId: "tinyman:pool:1",
    assetPair: "ALGO/USDC",
    assetIds: [0, 31_566_704],
    apy: 5,
    yieldBasis: "apy",
    tvlUsd: 1_000_000,
    sourceTimestamp: "2026-07-13T08:00:00.000Z",
    fetchedAt: "2026-07-13T08:01:00.000Z",
    ...overrides,
  };
}

export function portfolioSnapshot(
  overrides: Partial<PortfolioSnapshot> = {},
): PortfolioSnapshot {
  return {
    address: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ",
    fetchedAt: "2026-07-14T08:00:00.000Z",
    positions: [],
    protocols: [],
    totals: {
      suppliedUsd: 0,
      borrowedUsd: 0,
      rewardsUsd: 0,
      netUsd: 0,
    },
    liquidBalances: [
      {
        assetId: 31_566_704,
        amountRaw: "1000000000",
        decimals: 6,
      },
    ],
    complete: true,
    caveats: [],
    ...overrides,
  };
}

export function portfolioPlan(
  overrides: Partial<PortfolioPlan> = {},
): PortfolioPlan {
  return {
    currentAllocations: [],
    targetAllocations: [],
    actions: [],
    holdDecisions: ["Hold the liquid reserve."],
    currentAnnualizedReturnPct: 0,
    targetAnnualizedReturnPct: 0,
    estimatedOneTimeCostsUsd: 0,
    projectedNetBenefitUsd: 0,
    holdingHorizonDays: 30,
    evidence: [],
    assumptions: [],
    risks: [],
    confidence: 0.8,
    summary: "No compelling risk-adjusted changes are available.",
    ...overrides,
  };
}
