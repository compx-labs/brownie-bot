import { describe, expect, it, vi } from "vitest";

import type { PortfolioAction } from "../src/domain.js";
import { PortfolioPolicy, normalizePortfolioPlan, syncSwapAuthorizedSpend } from "../src/services/portfolio-policy.js";
import {
  enterShape,
  opportunity,
  portfolioPlan,
  portfolioSnapshot,
} from "./fixtures.js";

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

  it("blocks open/increase when opportunity TVL is below minTvlUsd", () => {
    const candidate = opportunity({
      tvlUsd: 45,
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

    expect(result.approved).toBe(false);
    expect(result.violations.join("\n")).toMatch(/TVL is below \$100000/);
  });

  it("waives minTvlUsd when opportunity assetIds intersect preferred holds", () => {
    const preferredAssetId = 1_732_165_149;
    const preferredPolicy = new PortfolioPolicy({
      ...policyConfig,
      preferredHoldAssetIds: [preferredAssetId],
    });
    const candidate = opportunity({
      protocol: "compx",
      opportunityId: "compx:lending:compx",
      assetPair: "COMPX",
      assetIds: [preferredAssetId],
      tvlUsd: 45,
      executionShapes: [
        enterShape({
          shapeKey: "mainnet:compx:v1:deposit:asa",
          protocol: "compx",
          action: "deposit",
          variant: "asa",
          requiredAssetIds: [preferredAssetId],
          requiredInputs: ["assetId", "amount"],
          inputHints: { assetId: preferredAssetId },
        }),
      ],
      sourceTimestamp: new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
    });
    const result = preferredPolicy.validate(
      portfolioSnapshot({
        liquidBalances: [
          {
            assetId: preferredAssetId,
            symbol: "COMPX",
            amountRaw: "4000000000000",
            spendableAmountRaw: "4000000000000",
            decimals: 6,
            usdValue: 41.12,
          },
        ],
      }),
      portfolioPlan({
        currentAllocations: [
          {
            key: "liquid:compx",
            protocol: null,
            opportunityId: null,
            assetIds: [preferredAssetId],
            weightPct: 100,
            expectedApyPct: 0,
          },
        ],
        targetAllocations: [
          {
            key: "liquid:compx",
            protocol: null,
            opportunityId: null,
            assetIds: [preferredAssetId],
            weightPct: 60,
            expectedApyPct: 0,
          },
          {
            key: "opportunity:compx:lending:compx",
            protocol: "compx",
            opportunityId: candidate.opportunityId,
            assetIds: [preferredAssetId],
            weightPct: 40,
            expectedApyPct: 0,
          },
        ],
        actions: [
          openAction({
            id: "open-compx-lending",
            protocol: "compx",
            opportunityId: candidate.opportunityId,
            amountRaw: "4000000000000",
            fromAssetId: preferredAssetId,
            executionShapeKey: "mainnet:compx:v1:deposit:asa",
            authorizedSpends: [
              { assetId: preferredAssetId, amountRaw: "4000000000000" },
            ],
            rationale: "Build CompX lending liquidity",
          }),
        ],
        projectedNetBenefitUsd: 10,
      }),
      [candidate],
    );

    expect(result.approved).toBe(true);
    expect(result.violations.join("\n")).not.toMatch(/TVL is below/);
  });

  it("does not hard-block when allocation weights are near but not exactly 100%", () => {
    const candidate = opportunity({
      sourceTimestamp: new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
    });
    const result = policy.validate(
      portfolioSnapshot(),
      portfolioPlan({
        currentAllocations: [{ ...liquid, weightPct: 99.2 }],
        targetAllocations: [
          { ...liquid, weightPct: 58.8 },
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
    expect(result.violations.join("\n")).not.toMatch(/allocations total/);
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

  it("allows incomplete snapshots when blockIncompleteSnapshot is false", () => {
    const verifyLikePolicy = new PortfolioPolicy({
      ...policyConfig,
      blockIncompleteSnapshot: false,
    });
    const candidate = opportunity({
      sourceTimestamp: new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
    });
    const result = verifyLikePolicy.validate(
      portfolioSnapshot({
        complete: false,
        caveats: [
          "pact positions are partial: Pact farm reward USD pricing is unavailable.",
          "At least one aggregate position valuation is incomplete",
        ],
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
      /Pact farm reward USD pricing is unavailable.*continuing despite incomplete snapshot/,
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

  it("rejects malformed dependencies and zero amounts, and warns on unknown target opportunities", () => {
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
    expect(result.warnings).toContain(
      "Target allocation unknown references an unknown opportunity",
    );
    expect(result.violations.join("\n")).toMatch(
      /depends on "missing"|zero amount|researched opportunity/,
    );
    expect(result.violations.join("\n")).not.toMatch(/unknown opportunity/);
  });

  it("does not block hold allocations for opportunities missing from research results", () => {
    const candidate = opportunity({
      sourceTimestamp: new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
    });
    const result = policy.validate(
      portfolioSnapshot(),
      portfolioPlan({
        currentAllocations: [
          liquid,
          {
            key: "tinyman-existing-lp",
            protocol: "tinyman",
            opportunityId: "tinyman:pool:held-but-unlisted",
            assetIds: [0, 31_566_704],
            weightPct: 0,
            expectedApyPct: 5,
          },
        ],
        targetAllocations: [
          { ...liquid, weightPct: 60 },
          {
            key: "tinyman-existing-lp",
            protocol: "tinyman",
            opportunityId: "tinyman:pool:held-but-unlisted",
            assetIds: [0, 31_566_704],
            weightPct: 0,
            expectedApyPct: 5,
          },
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
    expect(result.warnings).toContain(
      "Target allocation tinyman-existing-lp references an unknown opportunity",
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
      compatibleExitShapeKeys: ["mainnet:tinyman:v2:removeLiquidity:flexible"],
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

  it("allows reduce without authorizedSpends when exit shape and position match", () => {
    const held = {
      protocol: "folks-finance" as const,
      positionType: "supplied" as const,
      positionId: "folks:usdc:1",
      opportunityId: "folks:usdc:1",
      assetId: 31_566_704,
      assetSymbol: "USDC",
      amountRaw: "10000000",
      amount: "10",
      usdValue: 10,
      compatibleExitShapeKeys: ["mainnet:folks:v2:withdraw:escrow"],
      compatibleManageShapeKeys: [] as string[],
    };
    const result = policy.validate(
      portfolioSnapshot({
        positions: [held],
        liquidBalances: [
          {
            assetId: 31_566_704,
            amountRaw: "5000000",
            spendableAmountRaw: "5000000",
            symbol: "USDC",
            decimals: 6,
            usdValue: 5,
          },
        ],
      }),
      portfolioPlan({
        currentAllocations: [liquid],
        targetAllocations: [liquid],
        actions: [
          {
            id: "reduce-1",
            type: "reduce",
            protocol: "folks-finance",
            opportunityId: held.opportunityId,
            positionId: held.positionId,
            amountRaw: "5000000",
            fromAssetId: 31_566_704,
            toAssetId: null,
            targetWeightPct: null,
            executionShapeKey: "mainnet:folks:v2:withdraw:escrow",
            executionInput: {
              amount: "5000000",
              amountDenomination: "asset",
            },
            authorizedSpends: [],
            rationale: "Withdraw $5 USDC to trim Folks concentration.",
            dependencies: [],
          },
        ],
        projectedNetBenefitUsd: 10,
      }),
      [],
    );

    expect(result.approved).toBe(true);
    expect(result.violations).toEqual([]);
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

  it("does not block spends above the on-chain liquid balance", () => {
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

    expect(result.approved).toBe(true);
    expect(result.violations).not.toContain(
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
            authorizedSpends: [{ assetId: 31_566_704, amountRaw: "500000000" }],
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
    const rawPlan = portfolioPlan({
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
          executionInput: null,
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
    });
    const plan = normalizePortfolioPlan(rawPlan, [candidate]);
    expect(plan.actions.map((action) => action.id)).toEqual([
      "deposit-usdc-to-folks",
    ]);
    expect(plan.actions[0]?.dependencies).toEqual([]);

    const result = policy.validate(portfolioSnapshot(), plan, [candidate]);

    expect(result.approved).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("drops shapeKey strings mistakenly placed in dependencies", () => {
    const candidate = opportunity({
      protocol: "folks",
      opportunityId: "folks:usdc:1",
      assetPair: "USDC",
      assetIds: [31_566_704],
      sourceTimestamp: new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
      executionShapes: [
        enterShape({
          shapeKey: "mainnet:folks-finance:v2:setup:depositEscrow",
          protocol: "folks",
          action: "setup",
          variant: "depositEscrow",
          title: "Setup",
          summary: "Create escrow",
          order: 0,
          requiredInputs: [],
          requiredAssetIds: [],
        }),
        enterShape({
          shapeKey: "mainnet:folks-finance:v2:setup:optEscrowAsset",
          protocol: "folks",
          action: "optin",
          variant: "optEscrowAsset",
          title: "Opt in",
          summary: "Opt escrow into USDC",
          order: 1,
          requiredInputs: ["assetId"],
          requiredAssetIds: [31_566_704],
          inputHints: { assetId: 31_566_704 },
        }),
        enterShape({
          shapeKey: "mainnet:folks-finance:v2:deposit:escrow",
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
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const plan = normalizePortfolioPlan(
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
            id: "open-folks-usdc",
            protocol: "folks",
            opportunityId: candidate.opportunityId,
            executionShapeKey: "mainnet:folks-finance:v2:deposit:escrow",
            executionInput: {
              assetId: 31_566_704,
              assetAmount: "30000000",
            },
            authorizedSpends: [
              { assetId: 31_566_704, amountRaw: "30000000" },
            ],
            dependencies: [
              "mainnet:folks-finance:v2:setup:depositEscrow",
              "mainnet:folks-finance:v2:setup:optEscrowAsset",
            ],
          }),
        ],
        projectedNetBenefitUsd: 10,
      }),
      [candidate],
    );

    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]?.dependencies).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();

    const result = policy.validate(portfolioSnapshot(), plan, [candidate]);
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

  it("allows increase on a held position when the opportunity catalog missed it", () => {
    const held = {
      protocol: "reti",
      positionType: "staked" as const,
      positionId: "reti:staked:220:99",
      opportunityId: "reti-staking-220",
      assetId: 0,
      assetSymbol: "ALGO",
      amountRaw: "1000000000",
      amount: "1000",
      usdValue: 200,
      compatibleExitShapeKeys: ["mainnet:reti:v1:unstake:algo"],
      compatibleManageShapeKeys: [] as string[],
      inputHints: { validatorId: 220, poolAppId: 99, assetId: 0 },
    };
    const rawPlan = portfolioPlan({
      currentAllocations: [
        { ...liquid, weightPct: 80 },
        {
          key: "reti:staked",
          protocol: "reti",
          opportunityId: held.opportunityId,
          assetIds: [0],
          weightPct: 20,
          expectedApyPct: 4.5,
        },
      ],
      targetAllocations: [
        { ...liquid, weightPct: 60 },
        {
          key: "reti:staked",
          protocol: "reti",
          opportunityId: held.opportunityId,
          assetIds: [0],
          weightPct: 40,
          expectedApyPct: 4.5,
        },
      ],
      actions: [
        openAction({
          id: "a5",
          type: "increase",
          protocol: "reti",
          opportunityId: null,
          positionId: held.positionId,
          amountRaw: "2500000000",
          fromAssetId: 0,
          executionShapeKey: "mainnet:reti:v1:stake:algo",
          executionInput: null,
          authorizedSpends: [{ assetId: 0, amountRaw: "2500000000" }],
        }),
      ],
      projectedNetBenefitUsd: 10,
    });
    const snapshot = portfolioSnapshot({
      positions: [held],
      liquidBalances: [
        {
          assetId: 0,
          amountRaw: "5000000000",
          spendableAmountRaw: "5000000000",
          decimals: 6,
          symbol: "ALGO",
          usdValue: 1000,
        },
      ],
    });
    const plan = normalizePortfolioPlan(rawPlan, [], snapshot);

    expect(plan.actions[0]?.opportunityId).toBe("reti-staking-220");
    expect(plan.actions[0]?.executionInput).toMatchObject({
      validatorId: 220,
      amount: "2500000000",
    });

    const result = policy.validate(snapshot, plan, []);
    expect(result.approved).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.warnings.join("\n")).toMatch(
      /increases held position reti:staked:220:99 without a researched opportunity/,
    );
  });
});

describe("syncSwapAuthorizedSpend", () => {
  const hayAssetId = 3_160_000_000;
  const amountRaw = "2053000000";

  function swapAction(
    overrides: Partial<PortfolioAction> = {},
  ): PortfolioAction {
    return {
      id: "a1",
      type: "swap",
      protocol: "haystack",
      opportunityId: null,
      positionId: null,
      amountRaw,
      fromAssetId: hayAssetId,
      toAssetId: 31_566_704,
      targetWeightPct: null,
      executionShapeKey: null,
      executionInput: null,
      authorizedSpends: [],
      rationale: "Rotate idle HAY into USDC.",
      dependencies: [],
      ...overrides,
    };
  }

  it("rewrites empty or mismatched authorizedSpends from swap input", () => {
    expect(syncSwapAuthorizedSpend(swapAction()).authorizedSpends).toEqual([
      { assetId: hayAssetId, amountRaw },
    ]);
    expect(
      syncSwapAuthorizedSpend(
        swapAction({
          authorizedSpends: [{ assetId: 31_566_704, amountRaw: "1" }],
        }),
      ).authorizedSpends,
    ).toEqual([{ assetId: hayAssetId, amountRaw }]);
  });

  it("leaves an already-matching spend unchanged", () => {
    const action = swapAction({
      authorizedSpends: [{ assetId: hayAssetId, amountRaw }],
    });
    expect(syncSwapAuthorizedSpend(action)).toBe(action);
  });

  it("normalizes drift so policy accepts the swap", () => {
    const plan = normalizePortfolioPlan(
      portfolioPlan({
        currentAllocations: [liquid],
        targetAllocations: [liquid],
        actions: [
          swapAction({
            authorizedSpends: [{ assetId: 31_566_704, amountRaw: "999" }],
          }),
        ],
        projectedNetBenefitUsd: 10,
      }),
      [],
    );

    expect(plan.actions[0]?.authorizedSpends).toEqual([
      { assetId: hayAssetId, amountRaw },
    ]);

    const result = policy.validate(portfolioSnapshot(), plan, []);
    expect(result.approved).toBe(true);
    expect(result.violations).toEqual([]);
  });

  const BOTSY_ASSET_ID = 2_611_139_760;

  it("approves singleAsset open when sibling flexible requires a missing pool ASA", () => {
    const candidate = opportunity({
      opportunityId: "tinyman:botsy-algo:farm",
      assetPair: "BOTSY/ALGO",
      assetIds: [BOTSY_ASSET_ID, 0],
      sourceTimestamp: new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
      executionShapes: [
        enterShape({
          shapeKey: "mainnet:tinyman:v2:addLiquidityAndFarm:flexible",
          action: "addLiquidityAndFarm",
          variant: "flexible",
          requiredInputs: [
            "assetAId",
            "assetBId",
            "assetAAmount",
            "assetBAmount",
          ],
          requiredAssetIds: [BOTSY_ASSET_ID, 0],
          inputHints: { assetAId: BOTSY_ASSET_ID, assetBId: 0 },
        }),
        enterShape({
          shapeKey: "mainnet:tinyman:v2:addLiquidityAndFarm:singleAsset",
          action: "addLiquidityAndFarm",
          variant: "singleAsset",
          requiredInputs: [
            "depositAssetId",
            "depositAmount",
            "assetAId",
            "assetBId",
            "maxSlippageBps",
          ],
          // Canix often lists both pool ASAs even for single-sided.
          requiredAssetIds: [BOTSY_ASSET_ID, 0],
          inputHints: { assetAId: BOTSY_ASSET_ID, assetBId: 0 },
        }),
      ],
    });

    const result = policy.validate(
      portfolioSnapshot({
        liquidBalances: [
          {
            assetId: 0,
            amountRaw: "500000000",
            spendableAmountRaw: "400000000",
            decimals: 6,
          },
        ],
      }),
      portfolioPlan({
        currentAllocations: [
          {
            key: "liquid:algo",
            protocol: null,
            opportunityId: null,
            assetIds: [0],
            weightPct: 100,
            expectedApyPct: 0,
          },
        ],
        targetAllocations: [
          {
            key: "liquid:algo",
            protocol: null,
            opportunityId: null,
            assetIds: [0],
            weightPct: 60,
            expectedApyPct: 0,
          },
          {
            key: "opportunity:tinyman:botsy-algo:farm",
            protocol: "tinyman",
            opportunityId: candidate.opportunityId,
            assetIds: [BOTSY_ASSET_ID, 0],
            weightPct: 40,
            expectedApyPct: candidate.apy,
          },
        ],
        actions: [
          openAction({
            id: "open-botsy-algo-farm",
            opportunityId: candidate.opportunityId,
            amountRaw: "330000000",
            fromAssetId: 0,
            executionShapeKey:
              "mainnet:tinyman:v2:addLiquidityAndFarm:singleAsset",
            executionInput: {
              depositAssetId: 0,
              depositAmount: "330000000",
              assetAId: BOTSY_ASSET_ID,
              assetBId: 0,
            },
            authorizedSpends: [{ assetId: 0, amountRaw: "330000000" }],
            rationale: "Single-sided ALGO into BOTSY/ALGO farm.",
          }),
        ],
        projectedNetBenefitUsd: 10,
      }),
      [candidate],
    );

    expect(result.approved).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("blocks flexible open when the other pool ASA is missing and no swap covers it", () => {
    const candidate = opportunity({
      opportunityId: "tinyman:botsy-algo:farm",
      assetPair: "BOTSY/ALGO",
      assetIds: [BOTSY_ASSET_ID, 0],
      sourceTimestamp: new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
      executionShapes: [
        enterShape({
          shapeKey: "mainnet:tinyman:v2:addLiquidityAndFarm:flexible",
          action: "addLiquidityAndFarm",
          variant: "flexible",
          requiredAssetIds: [BOTSY_ASSET_ID, 0],
          inputHints: { assetAId: BOTSY_ASSET_ID, assetBId: 0 },
        }),
        enterShape({
          shapeKey: "mainnet:tinyman:v2:addLiquidityAndFarm:singleAsset",
          action: "addLiquidityAndFarm",
          variant: "singleAsset",
          requiredInputs: ["depositAssetId", "depositAmount"],
          requiredAssetIds: [BOTSY_ASSET_ID, 0],
          inputHints: { assetAId: BOTSY_ASSET_ID, assetBId: 0 },
        }),
      ],
    });

    const result = policy.validate(
      portfolioSnapshot({
        liquidBalances: [
          {
            assetId: 0,
            amountRaw: "500000000",
            spendableAmountRaw: "400000000",
            decimals: 6,
          },
        ],
      }),
      portfolioPlan({
        currentAllocations: [
          {
            key: "liquid:algo",
            protocol: null,
            opportunityId: null,
            assetIds: [0],
            weightPct: 100,
            expectedApyPct: 0,
          },
        ],
        targetAllocations: [
          {
            key: "liquid:algo",
            protocol: null,
            opportunityId: null,
            assetIds: [0],
            weightPct: 60,
            expectedApyPct: 0,
          },
          {
            key: "opportunity:tinyman:botsy-algo:farm",
            protocol: "tinyman",
            opportunityId: candidate.opportunityId,
            assetIds: [BOTSY_ASSET_ID, 0],
            weightPct: 40,
            expectedApyPct: candidate.apy,
          },
        ],
        actions: [
          openAction({
            id: "open-botsy-algo-farm",
            opportunityId: candidate.opportunityId,
            amountRaw: "330000000",
            fromAssetId: 0,
            executionShapeKey:
              "mainnet:tinyman:v2:addLiquidityAndFarm:flexible",
            executionInput: {
              assetAId: BOTSY_ASSET_ID,
              assetBId: 0,
              assetAAmount: "0",
              assetBAmount: "330000000",
            },
            authorizedSpends: [{ assetId: 0, amountRaw: "330000000" }],
            rationale: "Two-sided add without BOTSY.",
          }),
        ],
        projectedNetBenefitUsd: 10,
      }),
      [candidate],
    );

    expect(result.approved).toBe(false);
    expect(
      result.violations.some((message) =>
        message.includes(`requires asset ID(s) ${BOTSY_ASSET_ID}`),
      ),
    ).toBe(true);
  });

  it("approves singleAsset open depositing ALGO when the other pool ASA is absent", () => {
    const candidate = opportunity({
      opportunityId: "tinyman:pool:algo-usdc-single",
      assetPair: "ALGO/USDC",
      assetIds: [0, 31_566_704],
      sourceTimestamp: new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
      executionShapes: [
        enterShape({
          shapeKey: "mainnet:tinyman:v2:addLiquidity:singleAsset",
          action: "addLiquidity",
          variant: "singleAsset",
          requiredInputs: [
            "depositAssetId",
            "depositAmount",
            "assetAId",
            "assetBId",
          ],
          requiredAssetIds: [0, 31_566_704],
          inputHints: { assetAId: 0, assetBId: 31_566_704 },
        }),
      ],
    });

    const result = policy.validate(
      portfolioSnapshot({
        liquidBalances: [
          {
            assetId: 0,
            amountRaw: "500000000",
            spendableAmountRaw: "400000000",
            decimals: 6,
          },
        ],
      }),
      portfolioPlan({
        currentAllocations: [
          {
            key: "liquid:algo",
            protocol: null,
            opportunityId: null,
            assetIds: [0],
            weightPct: 100,
            expectedApyPct: 0,
          },
        ],
        targetAllocations: [
          {
            key: "liquid:algo",
            protocol: null,
            opportunityId: null,
            assetIds: [0],
            weightPct: 60,
            expectedApyPct: 0,
          },
          {
            key: "opportunity:tinyman:pool:algo-usdc-single",
            protocol: "tinyman",
            opportunityId: candidate.opportunityId,
            assetIds: [0, 31_566_704],
            weightPct: 40,
            expectedApyPct: candidate.apy,
          },
        ],
        actions: [
          openAction({
            id: "open-algo-usdc-single",
            opportunityId: candidate.opportunityId,
            amountRaw: "100000000",
            fromAssetId: 0,
            executionShapeKey: "mainnet:tinyman:v2:addLiquidity:singleAsset",
            executionInput: {
              depositAssetId: 0,
              depositAmount: "100000000",
              assetAId: 0,
              assetBId: 31_566_704,
            },
            authorizedSpends: [{ assetId: 0, amountRaw: "100000000" }],
            rationale: "Single-sided ALGO into ALGO/USDC.",
          }),
        ],
        projectedNetBenefitUsd: 10,
      }),
      [candidate],
    );

    expect(result.approved).toBe(true);
    expect(result.violations).toEqual([]);
  });
});

describe("claim-all zero amount normalization", () => {
  const claimShape =
    "mainnet:tinyman:staking-v1:farm:claimRewards";
  const rewardPositionId =
    "tinyman:reward:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ:123456:31566704";

  it("clears amountRaw 0 on claim-all so a multi-action plan is not hard-blocked", () => {
    const held = {
      protocol: "tinyman" as const,
      positionType: "reward" as const,
      positionId: rewardPositionId,
      opportunityId: "tinyman:pool:1:farm",
      assetId: 31_566_704,
      assetSymbol: "TINY",
      amountRaw: "0",
      amount: "0",
      usdValue: 0,
      compatibleExitShapeKeys: [] as string[],
      compatibleManageShapeKeys: [claimShape],
    };
    const rawPlan = portfolioPlan({
      currentAllocations: [liquid],
      targetAllocations: [liquid],
      actions: [
        {
          id: "a3",
          type: "claim",
          protocol: "tinyman",
          opportunityId: held.opportunityId,
          positionId: held.positionId,
          amountRaw: "0",
          fromAssetId: null,
          toAssetId: null,
          targetWeightPct: null,
          executionShapeKey: claimShape,
          executionInput: null,
          authorizedSpends: [],
          rationale: "Claim accrued rewards.",
          dependencies: [],
        },
      ],
      projectedNetBenefitUsd: 10,
    });

    const before = policy.validate(
      portfolioSnapshot({ positions: [held] }),
      rawPlan,
      [],
    );
    expect(before.approved).toBe(false);
    expect(before.violations.join("\n")).toMatch(/zero amount/);

    const plan = normalizePortfolioPlan(
      rawPlan,
      [],
      portfolioSnapshot({ positions: [held] }),
    );
    expect(plan.actions[0]?.amountRaw).toBeNull();

    const after = policy.validate(
      portfolioSnapshot({ positions: [held] }),
      plan,
      [],
    );
    expect(after.approved).toBe(true);
    expect(after.violations).toEqual([]);
  });
});
