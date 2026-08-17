import { describe, expect, it } from "vitest";

import {
  compactClaimableForModel,
  findClaimableRow,
  normalizeWalletClaimable,
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
});
