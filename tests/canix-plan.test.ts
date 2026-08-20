import { describe, expect, it } from "vitest";

import {
  assertComposablePlan,
  buildPlanRequest,
  isFoundationSwapFeedingEnter,
  planResponseSchema,
  resolvePlanBudget,
  uniqueEnterAssetId,
} from "../src/integrations/canix402/plan.js";
import { enterShape, opportunity } from "./fixtures.js";
import type { PortfolioAction } from "../src/domain.js";

const address = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ";
const opportunityId = "reti-staking-12";

function expiresSoon(ms = 60_000): string {
  return new Date(Date.now() + ms).toISOString();
}

function planPayload(
  overrides: {
    steps?: unknown[];
    quotes?: Array<{ shapeKey: string; input?: Record<string, unknown> }>;
    warnings?: string[];
    blocked?: unknown[];
    executionSubmitted?: boolean;
    expiresAt?: string;
  } = {},
) {
  const expiresAt = overrides.expiresAt ?? expiresSoon();
  return {
    data: {
      allocations: [
        {
          opportunityId,
          protocol: "reti",
          quotes: overrides.quotes ?? [
            {
              shapeKey: "mainnet:reti:v1:stake:algo",
              input: { amount: "1000000" },
            },
          ],
          steps: overrides.steps ?? [
            {
              kind: "eligibility",
              order: 0,
              compileStatus: "compiled",
              warnings: [],
            },
            {
              kind: "enter",
              order: 1,
              compileStatus: "compiled",
              shapeKey: "mainnet:reti:v1:stake:algo",
              warnings: [],
              quote: {
                shapeKey: "mainnet:reti:v1:stake:algo",
                expiresAt,
                encodedTransactions: ["ENTER"],
                warnings: [],
                transactions: [],
              },
            },
          ],
          warnings: [],
        },
      ],
      blocked: overrides.blocked ?? [],
      expectedPositionDelta: {
        summary: "Enter ALGO into Réti.",
        entries: [],
      },
      fees: {
        x402Usdc: "0.25",
        estimatedNetworkFeeMicroAlgos: "4000",
        estimatedNetworkFeeUsd: null,
      },
      expiresAt,
      warnings: overrides.warnings ?? [],
    },
    meta: {
      address,
      budget: { assetId: 0, amount: "1000000" },
      fetchedAt: new Date().toISOString(),
      paymentRequired: true,
      executionSubmitted: overrides.executionSubmitted ?? false,
      quoteTimeAuthoritative: true,
      eligibilityEndpoint: "/eligibility",
    },
  };
}

function swapAction(): PortfolioAction {
  return {
    id: "swap-1",
    type: "swap",
    protocol: null,
    opportunityId: null,
    positionId: null,
    amountRaw: "1000000",
    fromAssetId: 0,
    toAssetId: 31_566_704,
    targetWeightPct: null,
    executionShapeKey: null,
    executionInput: null,
    authorizedSpends: [{ assetId: 0, amountRaw: "1000000" }],
    rationale: "Fund USDC enter.",
    dependencies: [],
  };
}

describe("Canix plan compile helpers", () => {
  it("builds a POST /plans request from an allocation intent", () => {
    const request = buildPlanRequest({
      address,
      action: {
        opportunityId,
        fromAssetId: 0,
        amountRaw: "2000000",
        authorizedSpends: [{ assetId: 0, amountRaw: "2000000" }],
        dependencies: [],
      },
      policy: {
        maxProtocolPct: 50,
        minTvlUsd: 6_000,
        maxSourceAgeHours: 24,
      },
    });
    expect(request).toEqual({
      address,
      budget: { assetId: 0, amount: "2000000" },
      constraints: {
        maxProtocolWeightBps: 5_000,
        noNewBorrows: true,
        executionReadyOnly: true,
        minTvlUsd: 6_000,
        maxSourceAgeSeconds: 86_400,
        maxAllocations: 1,
      },
      opportunityIds: [opportunityId],
    });
  });

  it("uses a foundation feeding-swap as the compose budget", () => {
    const swap = swapAction();
    const budget = resolvePlanBudget(
      {
        fromAssetId: 31_566_704,
        amountRaw: "900000",
        authorizedSpends: [{ assetId: 31_566_704, amountRaw: "900000" }],
        dependencies: ["swap-1"],
      },
      [swap],
    );
    expect(budget).toEqual({ assetId: 0, amount: "1000000" });
  });

  it("treats a unique requiredAssetId as compose-able", () => {
    const candidate = opportunity({
      protocol: "reti",
      opportunityId,
      assetIds: [0],
      executionShapes: [
        enterShape({
          shapeKey: "mainnet:reti:v1:stake:algo",
          protocol: "reti",
          action: "stake",
          variant: "algo",
          requiredAssetIds: [0],
          requiredInputs: ["amount"],
        }),
      ],
    });
    expect(uniqueEnterAssetId(candidate)).toBe(0);
  });

  it("does not treat two-sided LP required assets as unique", () => {
    expect(uniqueEnterAssetId(opportunity())).toBeNull();
  });

  it("identifies foundation swaps that feed an enter", () => {
    const swap = swapAction();
    const open: PortfolioAction = {
      ...swap,
      id: "open-1",
      type: "open",
      opportunityId,
      executionShapeKey: "mainnet:reti:v1:stake:algo",
      dependencies: ["swap-1"],
    };
    expect(isFoundationSwapFeedingEnter(swap, [swap, open])).toBe(true);
    expect(
      isFoundationSwapFeedingEnter({ ...swap, dependencies: ["reduce-1"] }, [
        swap,
        open,
      ]),
    ).toBe(false);
  });
});

describe("assertComposablePlan", () => {
  it("extracts unmerged enter groups from a stubbed OpenAPI plan", () => {
    const parsed = planResponseSchema.parse(planPayload());
    const groups = assertComposablePlan(parsed, { address, opportunityId });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      kind: "enter",
      encodedTransactions: ["ENTER"],
    });
  });

  it("preserves Haystack signer indexes on a composed swap step", () => {
    const expiresAt = expiresSoon();
    const parsed = planResponseSchema.parse(
      planPayload({
        steps: [
          {
            kind: "optin",
            order: 0,
            compileStatus: "compiled",
            warnings: [],
            group: {
              required: true,
              transactions: [
                {
                  index: 0,
                  encodedTransaction: "OPTIN",
                  signer: "user",
                },
              ],
              userSignIndexes: [0],
              expiresAt,
            },
          },
          {
            kind: "swap",
            order: 1,
            compileStatus: "compiled",
            warnings: [],
            group: {
              transactions: [
                {
                  index: 0,
                  encodedTransaction: "USER",
                  signer: "user",
                },
                {
                  index: 1,
                  encodedTransaction: "HAY",
                  signedTransaction: "HAY-SIGNED",
                  signer: "haystack",
                },
              ],
              userSignIndexes: [0],
              quoteExpiresAt: expiresAt,
            },
          },
          {
            kind: "enter",
            order: 2,
            compileStatus: "compiled",
            shapeKey: "mainnet:reti:v1:stake:algo",
            warnings: [],
            quote: {
              shapeKey: "mainnet:reti:v1:stake:algo",
              expiresAt,
              encodedTransactions: ["ENTER"],
              warnings: [],
              transactions: [],
            },
          },
        ],
      }),
    );
    const groups = assertComposablePlan(parsed, { address, opportunityId });
    expect(groups.map((group) => group.kind)).toEqual([
      "optin",
      "swap",
      "enter",
    ]);
    expect(groups[1]?.userSignIndexes).toEqual([0]);
    expect(groups[1]?.members[1]).toMatchObject({
      signer: "haystack",
      signed: "HAY-SIGNED",
    });
  });

  it("fails closed on a stale plan warning without returning groups", () => {
    expect(() =>
      assertComposablePlan(
        planResponseSchema.parse(
          planPayload({ warnings: ["stale quote: haystack route expired"] }),
        ),
        { address, opportunityId },
      ),
    ).toThrow(/failed closed: stale quote/);
  });

  it("fails closed when opt-in is required but missing", () => {
    expect(() =>
      assertComposablePlan(
        planResponseSchema.parse(
          planPayload({
            steps: [
              {
                kind: "optin",
                order: 0,
                compileStatus: "failed",
                warnings: ["missing opt-in for output ASA"],
              },
            ],
          }),
        ),
        { address, opportunityId },
      ),
    ).toThrow(/fail closed|missing opt-in/i);
  });

  it("fails closed when quotes[] includes synthetic Haystack keys", () => {
    expect(() =>
      assertComposablePlan(
        planResponseSchema.parse(
          planPayload({
            quotes: [
              { shapeKey: "mainnet:haystack:v1:swap:synthetic" },
              { shapeKey: "mainnet:reti:v1:stake:algo" },
            ],
          }),
        ),
        { address, opportunityId },
      ),
    ).toThrow(/synthetic Haystack/);
  });

  it("fails closed when Haystack members lack provider signatures", () => {
    const expiresAt = expiresSoon();
    expect(() =>
      assertComposablePlan(
        planResponseSchema.parse(
          planPayload({
            steps: [
              {
                kind: "swap",
                order: 0,
                compileStatus: "compiled",
                warnings: [],
                group: {
                  transactions: [
                    {
                      index: 0,
                      encodedTransaction: "USER",
                      signer: "user",
                    },
                    {
                      index: 1,
                      encodedTransaction: "HAY",
                      signer: "haystack",
                    },
                  ],
                  userSignIndexes: [0],
                  quoteExpiresAt: expiresAt,
                },
              },
            ],
          }),
        ),
        { address, opportunityId },
      ),
    ).toThrow(/missing its provider signature/);
  });

  it("fails closed when enter/setup includes Haystack-signed members", () => {
    const expiresAt = expiresSoon();
    expect(() =>
      assertComposablePlan(
        planResponseSchema.parse(
          planPayload({
            steps: [
              {
                kind: "enter",
                order: 0,
                compileStatus: "compiled",
                warnings: [],
                group: {
                  transactions: [
                    {
                      index: 0,
                      encodedTransaction: "ENTER",
                      signer: "user",
                    },
                    {
                      index: 1,
                      encodedTransaction: "HAY",
                      signedTransaction: "HAY-SIGNED",
                      signer: "haystack",
                    },
                  ],
                  userSignIndexes: [0],
                  quoteExpiresAt: expiresAt,
                },
              },
            ],
          }),
        ),
        { address, opportunityId },
      ),
    ).toThrow(/merged swap\+enter/);
  });

  it("fails closed when the opportunity is blocked", () => {
    expect(() =>
      assertComposablePlan(
        planResponseSchema.parse(
          planPayload({
            blocked: [
              { opportunityId, reason: "two-sided LP is not auto-composed" },
            ],
          }),
        ),
        { address, opportunityId },
      ),
    ).toThrow(/blocked/);
  });
});
