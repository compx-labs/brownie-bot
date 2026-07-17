import { describe, expect, it } from "vitest";

import type { PortfolioAction } from "../src/domain.js";
import { PortfolioPolicy } from "../src/services/portfolio-policy.js";
import { enterShape, opportunity, portfolioPlan, portfolioSnapshot } from "./fixtures.js";

const policyConfig = {
  maxPositionPct: 60,
  maxProtocolPct: 70,
  minLiquidReservePct: 10,
  minTvlUsd: 100_000,
  maxSourceAgeHours: 24,
  minProjectedNetImprovementUsd: 1,
  signingEnabled: true,
};

const policy = new PortfolioPolicy(policyConfig);

const dryRunPolicy = new PortfolioPolicy({
  ...policyConfig,
  signingEnabled: false,
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
    executionShapeKey: "mainnet:tinyman:v2:addLiquidity:flexible",
    executionInput: {
      assetAId: 0,
      assetBId: 31_566_704,
      assetAAmount: "1000000",
      assetBAmount: "100000000",
    },
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
    expect(result.warnings).toEqual([]);
  });

  it("blocks actions when the on-chain snapshot is incomplete and signing is enabled", () => {
    const result = policy.validate(
      portfolioSnapshot({
        complete: false,
        caveats: ["folks positions are unavailable: timeout"],
      }),
      portfolioPlan({
        currentAllocations: [liquid],
        targetAllocations: [liquid],
        actions: [openAction()],
        projectedNetBenefitUsd: 10,
      }),
      [],
    );

    expect(result.approved).toBe(false);
    expect(result.violations.join("\n")).toMatch(
      /Portfolio snapshot is incomplete \(folks positions are unavailable: timeout\).*only hold is permitted while signing/,
    );
  });

  it("approves incomplete snapshots when signing is disabled and reports caveats", () => {
    const candidate = opportunity({
      sourceTimestamp: new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
    });
    const result = dryRunPolicy.validate(
      portfolioSnapshot({
        complete: false,
        caveats: ["At least one aggregate position valuation is incomplete"],
      }),
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
    expect(result.warnings.join("\n")).toMatch(
      /incomplete \(At least one aggregate position valuation is incomplete\).*signing is disabled/,
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
      /unknown opportunity|depends on "missing"|zero amount|researched opportunity/,
    );
  });

  it("warns on deployed concentration guidance instead of blocking", () => {
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
        actions: [openAction()],
        projectedNetBenefitUsd: 10,
      }),
      [candidate],
    );

    expect(result.approved).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "Target position 100% exceeds guidance of 60%",
        "Target protocol allocation 100% exceeds guidance of 70%",
        "Liquid reserve 0% is below guidance of 10%",
      ]),
    );
    expect(result.metrics.maxPositionPct).toBe(100);
    expect(result.metrics.maxProtocolPct).toBe(100);
  });

  it("does not treat a large liquid reserve as a position-cap breach", () => {
    const candidate = opportunity({
      sourceTimestamp: new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
    });
    const result = policy.validate(
      portfolioSnapshot(),
      portfolioPlan({
        currentAllocations: [liquid],
        targetAllocations: [
          { ...liquid, weightPct: 92 },
          {
            key: "opportunity:tinyman:pool:1",
            protocol: "tinyman",
            opportunityId: candidate.opportunityId,
            assetIds: candidate.assetIds ?? [],
            weightPct: 8,
            expectedApyPct: candidate.apy,
          },
        ],
        actions: [openAction({ targetWeightPct: 8 })],
        projectedNetBenefitUsd: 10,
      }),
      [candidate],
    );

    expect(result.approved).toBe(true);
    expect(result.metrics.maxPositionPct).toBe(8);
    expect(result.warnings.join("\n")).not.toMatch(
      /Target position .* exceeds guidance/,
    );
  });

  it("rejects invented enter shape keys not listed on the opportunity", () => {
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
            executionShapeKey: "tinyman:open",
          }),
        ],
        projectedNetBenefitUsd: 10,
      }),
      [candidate],
    );

    expect(result.approved).toBe(false);
    expect(result.violations.join("\n")).toMatch(
      /executionShapeKey "tinyman:open".*enter shapes/,
    );
  });

  it("rejects exit shapes outside the position catalog", () => {
    const held = {
      protocol: "tinyman" as const,
      positionType: "lp" as const,
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
      compatibleManageShapeKeys: [] as string[],
    };
    const result = policy.validate(
      portfolioSnapshot({ positions: [held] }),
      portfolioPlan({
        currentAllocations: [liquid],
        targetAllocations: [liquid],
        actions: [
          {
            id: "close-1",
            type: "close",
            protocol: "tinyman",
            opportunityId: null,
            positionId: held.positionId,
            amountRaw: null,
            fromAssetId: null,
            toAssetId: null,
            targetWeightPct: null,
            executionShapeKey: "invented:exit",
            executionInput: { poolTokenAmount: "1000" },
            authorizedSpends: [],
            rationale: "Exit.",
            dependencies: [],
          },
        ],
        projectedNetBenefitUsd: 10,
      }),
      [],
    );

    expect(result.approved).toBe(false);
    expect(result.violations.join("\n")).toMatch(
      /executionShapeKey "invented:exit".*exit\/manage keys/,
    );
  });

  it("rejects duplicate action IDs", () => {
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
        actions: [openAction(), openAction()],
        projectedNetBenefitUsd: 10,
      }),
      [candidate],
    );

    expect(result.approved).toBe(false);
    expect(result.violations).toContain("Duplicate action ID: open-1");
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

  it("allows deposit spends above liquid balance when a dependency swap produces the asset", () => {
    const candidate = opportunity({
      protocol: "folks",
      opportunityId: "folks:usdc:1",
      assetPair: "USDC",
      assetIds: [31_566_704],
      sourceTimestamp: new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
      executionShapes: [
        enterShape({
          shapeKey: "mainnet:folks:v2:deposit:escrow",
          protocol: "folks",
          action: "deposit",
          variant: "escrow",
          title: "Deposit",
          summary: "Deposit USDC",
          requiredInputs: ["assetAmount"],
          requiredAssetIds: [31_566_704],
          inputHints: { assetId: 31_566_704 },
        }),
      ],
    });
    const result = policy.validate(
      portfolioSnapshot({
        liquidBalances: [
          {
            assetId: 0,
            amountRaw: "2000000000",
            spendableAmountRaw: "2000000000",
            decimals: 6,
          },
          {
            assetId: 31_566_704,
            amountRaw: "1000000",
            decimals: 6,
          },
        ],
      }),
      portfolioPlan({
        currentAllocations: [liquid],
        targetAllocations: [
          { ...liquid, weightPct: 65 },
          {
            key: "opportunity:folks:usdc:1",
            protocol: "folks",
            opportunityId: candidate.opportunityId,
            assetIds: [31_566_704],
            weightPct: 35,
            expectedApyPct: 13.44,
          },
        ],
        actions: [
          {
            id: "swap-algo-to-usdc",
            type: "swap",
            protocol: null,
            opportunityId: null,
            positionId: null,
            amountRaw: "950000000",
            fromAssetId: 0,
            toAssetId: 31_566_704,
            targetWeightPct: null,
            executionShapeKey: null,
            executionInput: null,
            authorizedSpends: [{ assetId: 0, amountRaw: "950000000" }],
            rationale: "Fund USDC deposit.",
            dependencies: [],
          },
          openAction({
            id: "folks-deposit-usdc",
            protocol: "folks",
            opportunityId: candidate.opportunityId,
            amountRaw: "500000000",
            fromAssetId: 31_566_704,
            executionShapeKey: "mainnet:folks:v2:deposit:escrow",
            executionInput: {
              assetId: 31_566_704,
              assetAmount: "500000000",
            },
            authorizedSpends: [
              { assetId: 31_566_704, amountRaw: "500000000" },
            ],
            dependencies: ["swap-algo-to-usdc"],
          }),
        ],
        projectedNetBenefitUsd: 10,
      }),
      [candidate],
    );

    expect(result.approved).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("allows open actions with empty spends for setup and opt-in shapes", () => {
    const candidate = opportunity({
      protocol: "folks",
      opportunityId: "folks:usdc:1",
      assetPair: "USDC",
      assetIds: [31_566_704],
      sourceTimestamp: new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
      executionShapes: [
        enterShape({
          shapeKey: "mainnet:folks:v2:setup:escrow",
          protocol: "folks",
          action: "setup",
          variant: "escrow",
          title: "Setup",
          summary: "Create escrow",
          order: 0,
          requiredInputs: [],
          requiredAssetIds: [],
          inputHints: { poolAppId: 123 },
        }),
        enterShape({
          shapeKey: "mainnet:folks:v2:optin:escrow",
          protocol: "folks",
          action: "optin",
          variant: "escrow",
          title: "Opt in",
          summary: "Opt escrow into USDC",
          order: 1,
          requiredInputs: ["assetId"],
          // Asset id is listed for opt-in context, not a treasury transfer.
          requiredAssetIds: [31_566_704],
          inputHints: { assetId: 31_566_704 },
        }),
        enterShape({
          shapeKey: "mainnet:folks:v2:deposit:escrow",
          protocol: "folks",
          action: "deposit",
          variant: "escrow",
          title: "Deposit",
          summary: "Deposit USDC",
          order: 2,
          requiredInputs: ["assetAmount"],
          requiredAssetIds: [31_566_704],
          inputHints: { assetId: 31_566_704 },
        }),
      ],
    });
    const result = policy.validate(
      portfolioSnapshot(),
      portfolioPlan({
        currentAllocations: [liquid],
        targetAllocations: [
          { ...liquid, weightPct: 60 },
          {
            key: "opportunity:folks:usdc:1",
            protocol: "folks",
            opportunityId: candidate.opportunityId,
            assetIds: [31_566_704],
            weightPct: 40,
            expectedApyPct: 13.44,
          },
        ],
        actions: [
          openAction({
            id: "create-folks-deposit-escrow",
            protocol: "folks",
            opportunityId: candidate.opportunityId,
            amountRaw: null,
            fromAssetId: null,
            executionShapeKey: "mainnet:folks:v2:setup:escrow",
            executionInput: { poolAppId: 123 },
            authorizedSpends: [],
          }),
          openAction({
            id: "opt-folks-escrow-into-usdc",
            protocol: "folks",
            opportunityId: candidate.opportunityId,
            amountRaw: null,
            fromAssetId: null,
            executionShapeKey: "mainnet:folks:v2:optin:escrow",
            executionInput: { assetId: 31_566_704 },
            authorizedSpends: [],
            dependencies: ["create-folks-deposit-escrow"],
          }),
          openAction({
            id: "deposit-usdc-to-folks",
            protocol: "folks",
            opportunityId: candidate.opportunityId,
            executionShapeKey: "mainnet:folks:v2:deposit:escrow",
            executionInput: {
              assetId: 31_566_704,
              assetAmount: "100000000",
            },
            dependencies: [
              "create-folks-deposit-escrow",
              "opt-folks-escrow-into-usdc",
            ],
          }),
        ],
        projectedNetBenefitUsd: 10,
      }),
      [candidate],
    );

    expect(result.approved).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("still requires declared spends on deposit shapes with amount inputs", () => {
    const candidate = opportunity({
      protocol: "folks",
      opportunityId: "folks:usdc:1",
      assetPair: "USDC",
      assetIds: [31_566_704],
      sourceTimestamp: new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
      executionShapes: [
        enterShape({
          shapeKey: "mainnet:folks:v2:deposit:escrow",
          protocol: "folks",
          action: "deposit",
          variant: "escrow",
          title: "Deposit",
          summary: "Deposit USDC",
          requiredInputs: ["assetAmount"],
          requiredAssetIds: [31_566_704],
          inputHints: { assetId: 31_566_704 },
        }),
      ],
    });
    const result = policy.validate(
      portfolioSnapshot(),
      portfolioPlan({
        currentAllocations: [liquid],
        targetAllocations: [liquid],
        actions: [
          openAction({
            id: "deposit-usdc-to-folks",
            protocol: "folks",
            opportunityId: candidate.opportunityId,
            amountRaw: null,
            executionShapeKey: "mainnet:folks:v2:deposit:escrow",
            executionInput: {
              assetId: 31_566_704,
              assetAmount: "100000000",
            },
            authorizedSpends: [],
          }),
        ],
        projectedNetBenefitUsd: 10,
      }),
      [candidate],
    );

    expect(result.approved).toBe(false);
    expect(result.violations).toContain(
      "Action deposit-usdc-to-folks has no declared treasury spend",
    );
  });

  it("demotes hard issues to warnings when signing is disabled", () => {
    const result = dryRunPolicy.validate(
      portfolioSnapshot(),
      portfolioPlan({
        currentAllocations: [liquid],
        targetAllocations: [liquid],
        actions: [
          openAction({
            dependencies: ["swap-first"],
            executionShapeKey: null,
            executionInput: null,
          }),
        ],
        projectedNetBenefitUsd: 10,
      }),
      [],
    );

    expect(result.approved).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.warnings.join("\n")).toMatch(
      /Would block if signing enabled:.*depends on "swap-first" but the plan only defines action ID\(s\) "open-1"/,
    );
    expect(result.warnings.join("\n")).toMatch(
      /Would block if signing enabled:.*missing executionShapeKey and executionInput/,
    );
  });
});
