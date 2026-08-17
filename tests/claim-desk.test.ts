import { describe, expect, it } from "vitest";

import {
  actionHasDeskClaimQuote,
  alignQuotesByShapeKey,
  compactClaimableForModel,
  findClaimableRow,
  findClaimableRows,
  normalizeWalletClaimable,
  planClaimQuoteRequests,
  quoteRequestsForClaimAction,
  selectClaimQuoteRequests,
} from "../src/services/claim-desk.js";
import type { PortfolioAction } from "../src/domain.js";

const claimAction = (
  overrides: Partial<PortfolioAction> = {},
): PortfolioAction => ({
  id: "claim-1",
  type: "claim",
  protocol: "tinyman",
  opportunityId: "tinyman:pool:1:farm",
  positionId: "tinyman:reward:1",
  amountRaw: null,
  fromAssetId: null,
  toAssetId: null,
  targetWeightPct: null,
  executionShapeKey: "mainnet:tinyman:staking-v1:farm:claimRewards",
  executionInput: { userAddress: "ADDR" },
  authorizedSpends: [],
  rationale: "Claim farm rewards",
  dependencies: [],
  ...overrides,
});

describe("claim desk", () => {
  it("normalizes rows, claimAllQuotes, and worthClaiming totals", () => {
    const claimable = normalizeWalletClaimable({
      data: [
        {
          claimKey: "tinyman-farm",
          positionId: "tinyman:reward:1",
          opportunityId: "tinyman:pool:1:farm",
          protocol: "tinyman",
          shapeKey: "mainnet:tinyman:staking-v1:farm:claimRewards",
          usdValue: 1.25,
          worthClaiming: true,
          quote: {
            shapeKey: "mainnet:tinyman:staking-v1:farm:claimRewards",
            input: { poolId: "POOL" },
          },
        },
      ],
      claimAllQuotes: [
        {
          shapeKey: "mainnet:tinyman:staking-v1:farm:claimRewards",
          input: { poolId: "POOL" },
        },
      ],
      totals: { claimableUsd: 1.25, worthClaimingUsd: 1.25 },
      meta: { address: "ADDR" },
    });

    expect(claimable.rows).toHaveLength(1);
    expect(claimable.claimAllQuotes).toHaveLength(1);
    expect(claimable.totals.worthClaimingUsd).toBe(1.25);
    expect(compactClaimableForModel(claimable)).toMatchObject({
      totals: { worthClaimingUsd: 1.25 },
      rows: [{ worthClaiming: true, claimKey: "tinyman-farm" }],
    });
  });

  it("selects per-row desk quotes for planned claims", () => {
    const claimable = normalizeWalletClaimable({
      data: [
        {
          positionId: "tinyman:reward:1",
          quote: {
            shapeKey: "mainnet:tinyman:staking-v1:farm:claimRewards",
            input: { programId: 1 },
          },
        },
      ],
    });
    const action = claimAction();
    expect(findClaimableRow(action, claimable)?.positionId).toBe(
      "tinyman:reward:1",
    );
    expect(quoteRequestsForClaimAction(action, claimable)).toEqual([
      {
        shapeKey: "mainnet:tinyman:staking-v1:farm:claimRewards",
        input: { programId: 1 },
      },
    ]);
    expect(
      selectClaimQuoteRequests([action], claimable, () => [
        { shapeKey: "fallback", input: {} },
      ]),
    ).toEqual([
      {
        actionId: "claim-1",
        quote: {
          shapeKey: "mainnet:tinyman:staking-v1:farm:claimRewards",
          input: { programId: 1 },
        },
      },
    ]);
  });

  it("falls back when the desk has no matching row", () => {
    const claimable = normalizeWalletClaimable({ data: [] });
    const action = claimAction();
    expect(
      selectClaimQuoteRequests([action], claimable, () => [
        { shapeKey: "fallback", input: { amount: "1" } },
      ]),
    ).toEqual([
      {
        actionId: "claim-1",
        quote: { shapeKey: "fallback", input: { amount: "1" } },
      },
    ]);
  });

  it("does not bind a row from a substring claimKey or position-only match", () => {
    const claimable = normalizeWalletClaimable({
      data: [
        {
          claimKey: "claim",
          positionId: "haystack:reward:1",
          shapeKey: "mainnet:haystack:v1:claim",
          quote: {
            shapeKey: "mainnet:haystack:v1:claim",
            input: { farm: "HAY" },
          },
        },
        {
          claimKey: "farm",
          positionId: "tinyman:reward:1",
          shapeKey: "mainnet:tinyman:staking-v1:farm:harvest",
          quote: {
            shapeKey: "mainnet:tinyman:staking-v1:farm:harvest",
            input: { poolId: "WRONG" },
          },
        },
        {
          claimKey: "tinyman-farm",
          positionId: "tinyman:reward:1",
          shapeKey: "mainnet:tinyman:staking-v1:farm:claimRewards",
          quote: {
            shapeKey: "mainnet:tinyman:staking-v1:farm:claimRewards",
            input: { poolId: "RIGHT" },
          },
        },
      ],
    });
    const action = claimAction({
      positionId: "tinyman:reward:1",
      executionShapeKey: "mainnet:tinyman:staking-v1:farm:claimRewards",
    });
    expect(findClaimableRow(action, claimable)?.quote?.input).toEqual({
      poolId: "RIGHT",
    });
    expect(
      findClaimableRow(
        claimAction({
          positionId: "other",
          opportunityId: "other",
          executionShapeKey: "mainnet:tinyman:staking-v1:farm:claimRewards",
        }),
        claimable,
      )?.quote?.input,
    ).toEqual({ poolId: "RIGHT" });
    expect(
      actionHasDeskClaimQuote(
        claimAction({
          positionId: "reti:reward:1",
          opportunityId: "reti:1",
          protocol: "reti",
          executionShapeKey: "mainnet:reti:v1:claim",
        }),
        claimable,
      ),
    ).toBe(false);
  });

  it("collects every row that shares a claimKey as the compile unit", () => {
    const claimable = normalizeWalletClaimable({
      data: [
        {
          claimKey: "haystack",
          positionId: "haystack:usdc",
          quote: {
            shapeKey: "mainnet:haystack:v1:claim",
            input: { userAddress: "ADDR" },
          },
        },
        {
          claimKey: "haystack",
          positionId: "haystack:hay",
          quote: {
            shapeKey: "mainnet:haystack:v1:claim",
            input: { userAddress: "ADDR" },
          },
        },
      ],
    });
    const action = claimAction({
      id: "claim-hay-usdc",
      protocol: "haystack",
      positionId: "haystack:usdc",
      opportunityId: "haystack:stake",
      executionShapeKey: "mainnet:haystack:v1:claim",
    });
    expect(findClaimableRows(action, claimable)).toHaveLength(2);
    expect(quoteRequestsForClaimAction(action, claimable)).toEqual([
      {
        shapeKey: "mainnet:haystack:v1:claim",
        input: { userAddress: "ADDR" },
      },
    ]);
  });

  it("skips a second action that resolves to the same claimKey", () => {
    const claimable = normalizeWalletClaimable({
      data: [
        {
          claimKey: "pact",
          positionId: "pact:a",
          quote: {
            shapeKey: "mainnet:pact:v1:farm:claim",
            input: { farmAppId: 1 },
          },
        },
        {
          claimKey: "pact",
          positionId: "pact:b",
          quote: {
            shapeKey: "mainnet:pact:v1:farm:claim",
            input: { farmAppId: 1 },
          },
        },
      ],
    });
    const first = claimAction({
      id: "claim-pact-a",
      protocol: "pact",
      positionId: "pact:a",
      opportunityId: "pact:farm",
      executionShapeKey: "mainnet:pact:v1:farm:claim",
    });
    const second = claimAction({
      id: "claim-pact-b",
      protocol: "pact",
      positionId: "pact:b",
      opportunityId: "pact:farm",
      executionShapeKey: "mainnet:pact:v1:farm:claim",
    });
    const plan = planClaimQuoteRequests([first, second], claimable);
    expect(plan.planned).toEqual([
      {
        actionId: "claim-pact-a",
        quote: {
          shapeKey: "mainnet:pact:v1:farm:claim",
          input: { farmAppId: 1 },
        },
      },
    ]);
    expect(plan.skipped).toEqual([
      {
        actionId: "claim-pact-b",
        status: "skipped",
        error: "Duplicate claimKey pact already queued",
      },
    ]);
    expect(plan.unmatchedIds).toEqual([]);
  });

  it("leaves unmatched claims out of the desk plan so they can use executeAction", () => {
    const claimable = normalizeWalletClaimable({
      data: [
        {
          positionId: "tinyman:reward:1",
          quote: {
            shapeKey: "mainnet:tinyman:staking-v1:farm:claimRewards",
            input: { poolId: "POOL" },
          },
        },
      ],
    });
    const desk = claimAction();
    const reti = claimAction({
      id: "claim-reti",
      protocol: "reti",
      positionId: "reti:reward:1",
      opportunityId: "reti:1",
      executionShapeKey: "mainnet:reti:v1:claim",
    });
    const plan = planClaimQuoteRequests([desk, reti], claimable);
    expect(plan.planned.map((item) => item.actionId)).toEqual(["claim-1"]);
    expect(plan.unmatchedIds).toEqual(["claim-reti"]);
  });

  it("aligns compiled quotes by shapeKey with index only as a tie-break", () => {
    const aligned = alignQuotesByShapeKey(
      [
        {
          actionId: "claim-farm",
          quote: {
            shapeKey: "mainnet:tinyman:staking-v1:farm:claimRewards",
            input: { poolId: "A" },
          },
        },
        {
          actionId: "claim-hay",
          quote: {
            shapeKey: "mainnet:haystack:v1:claim",
            input: {},
          },
        },
      ],
      [
        {
          shapeKey: "mainnet:haystack:v1:claim",
          encodedTransactions: ["HAY"],
        },
        {
          shapeKey: "mainnet:tinyman:staking-v1:farm:claimRewards",
          encodedTransactions: ["TINY"],
        },
      ],
    );
    expect(aligned.map((item) => item.actionId)).toEqual([
      "claim-farm",
      "claim-hay",
    ]);
    expect(aligned.map((item) => item.quote.encodedTransactions)).toEqual([
      ["TINY"],
      ["HAY"],
    ]);
  });
});
