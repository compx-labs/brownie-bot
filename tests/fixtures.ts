import type {
  Opportunity,
  OpportunityExecutionShape,
  PortfolioPlan,
  PortfolioSnapshot,
  Position,
} from "../src/domain.js";

export function enterShape(
  overrides: Partial<OpportunityExecutionShape> = {},
): OpportunityExecutionShape {
  return {
    shapeKey: "mainnet:tinyman:v2:addLiquidity:flexible",
    protocol: "tinyman",
    protocolVersion: "v2",
    action: "addLiquidity",
    variant: "flexible",
    title: "Add Tinyman LP",
    summary: "Add flexible liquidity to the Tinyman pool.",
    order: 0,
    requiredInputs: ["assetAId", "assetBId", "assetAAmount", "assetBAmount"],
    requiredAssetIds: [0, 31_566_704],
    inputHints: {
      assetAId: 0,
      assetBId: 31_566_704,
    },
    ...overrides,
  };
}

export function opportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  const executionShapes =
    overrides.executionShapes ??
    [
      enterShape({
        requiredAssetIds: overrides.assetIds ?? [0, 31_566_704],
      }),
    ];
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
    executionShapes,
    executionReady: overrides.executionReady ?? executionShapes.length > 0,
  };
}

export function position(overrides: Partial<Position> = {}): Position {
  return {
    protocol: "tinyman",
    positionType: "lp",
    positionId: "tinyman:lp:1",
    opportunityId: "tinyman:pool:1",
    assetId: 0,
    assetSymbol: "TMPOOL2",
    amountRaw: "1000",
    amount: "0.001",
    usdValue: 10,
    compatibleExitShapeKeys: [
      "mainnet:tinyman:v2:removeLiquidity:flexible",
    ],
    compatibleManageShapeKeys: [],
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
        assetId: 0,
        amountRaw: "5000000",
        spendableAmountRaw: "4000000",
        decimals: 6,
      },
      {
        assetId: 31_566_704,
        amountRaw: "1000000000",
        decimals: 6,
      },
    ],
    minimumBalanceRaw: "100000",
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
