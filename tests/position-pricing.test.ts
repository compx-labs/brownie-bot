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
      positionNeedsTokenReprice(
        position({ assetId: null, assetSymbol: null }),
      ),
    ).toBe(true);
  });

  it("treats Canix microscopic Folks usdValue as unpriced", () => {
    // Live Canix bug: amount ~34 USDC but usdValue ~3.4e-9
    expect(
      positionNeedsTokenReprice(position({ usdValue: 3.39986e-9 })),
    ).toBe(true);
    const { positions, notes } = repricePositionsFromTokenPrices(
      [position({ usdValue: 3.39986e-9 })],
      [],
    );
    expect(positions[0]?.usdValue).toBe(34);
    expect(notes[0]).toContain("unit-usd-peg");
  });

  it("reprices Folks USDC at $1 when CompX returns null or zero", () => {
    for (const priceUsd of [null, "0"] as const) {
      const { positions, notes } = repricePositionsFromTokenPrices(
        [position({ assetId: null, assetSymbol: "USDC" })],
        [
          {
            assetId: 31_566_704,
            priceUsd,
            source: "compx",
            fetchedAt: new Date().toISOString(),
            stale: false,
          },
        ],
      );
      expect(positions[0]?.usdValue).toBe(34);
      expect(notes[0]).toContain("unit-usd-peg");
    }
  });

  it("ignores unusable CompX quotes on non-stable asset ids and pegs Folks supply", () => {
    const { positions, notes } = repricePositionsFromTokenPrices(
      [position({ assetId: 9_999_999_999, assetSymbol: null })],
      [
        {
          assetId: 9_999_999_999,
          priceUsd: "0",
          source: "compx",
          fetchedAt: new Date().toISOString(),
          stale: false,
        },
      ],
    );
    expect(positions[0]?.usdValue).toBe(34);
    expect(notes[0]).toContain("unit-usd-peg");
    expect(collectRepriceAssetIds([position({ assetId: null })])).toEqual([
      31_566_704,
    ]);
  });

  it("prefers positive CompX price when available", () => {
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
