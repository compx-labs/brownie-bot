import { describe, expect, it } from "vitest";

import type { Position } from "../src/domain.js";
import {
  collectRepriceAssetIds,
  positionNeedsTokenReprice,
  recomputeWalletPositionTotals,
  repricePositionsFromTokenPrices,
} from "../src/services/position-pricing.js";

function position(overrides: Partial<Position>): Position {
  return {
    protocol: "folks-finance",
    positionType: "supplied",
    positionId: "folks-finance:supplied:escrow",
    opportunityId: null,
    assetId: 31_566_704,
    assetSymbol: "USDC",
    amountRaw: "34000036",
    amount: "34.000036",
    usdValue: 0,
    compatibleExitShapeKeys: [],
    compatibleManageShapeKeys: [],
    ...overrides,
  };
}

describe("position token reprice", () => {
  it("detects zero-valued Folks supplies that still have amount", () => {
    expect(positionNeedsTokenReprice(position({}))).toBe(true);
    expect(positionNeedsTokenReprice(position({ usdValue: null }))).toBe(true);
    expect(positionNeedsTokenReprice(position({ usdValue: 34 }))).toBe(false);
    expect(positionNeedsTokenReprice(position({ amount: "0" }))).toBe(false);
    expect(
      positionNeedsTokenReprice(position({ assetId: null, assetSymbol: "USDC" })),
    ).toBe(true);
    expect(
      positionNeedsTokenReprice(position({ assetId: null, assetSymbol: null })),
    ).toBe(false);
  });

  it("reprices USDC at $1 when CompX has no quote", () => {
    const { positions, notes } = repricePositionsFromTokenPrices(
      [
        position({ assetId: null, assetSymbol: "USDC" }),
        position({
          protocol: "tinyman",
          positionType: "lp",
          positionId: "tinyman:lp:1",
          assetId: 1_002_590_888,
          amount: "2.11",
          usdValue: 2,
        }),
      ],
      [
        {
          assetId: 1_002_590_888,
          priceUsd: null,
          source: "compx",
          fetchedAt: new Date().toISOString(),
          stale: false,
        },
      ],
    );

    expect(positions[0]?.usdValue).toBe(34);
    expect(positions[1]?.usdValue).toBe(2);
    expect(notes[0]).toContain("unit-usd-peg");
    expect(collectRepriceAssetIds([position({ assetId: null })])).toEqual([
      31_566_704,
    ]);
  });

  it("prefers CompX price when available", () => {
    const { positions, notes } = repricePositionsFromTokenPrices(
      [position({})],
      [
        {
          assetId: 31_566_704,
          priceUsd: "1.01",
          source: "compx",
          fetchedAt: new Date().toISOString(),
          stale: false,
        },
      ],
    );
    expect(positions[0]?.usdValue).toBe(34.34);
    expect(notes[0]).toContain("compx");
  });

  it("recomputes aggregate totals after reprice", () => {
    const totals = recomputeWalletPositionTotals([
      position({ usdValue: 34 }),
      position({
        protocol: "tinyman",
        positionType: "lp",
        positionId: "lp",
        usdValue: 2,
      }),
    ]);
    expect(totals).toEqual({
      suppliedUsd: 36,
      borrowedUsd: 0,
      rewardsUsd: 0,
      netUsd: 36,
    });
  });
});
