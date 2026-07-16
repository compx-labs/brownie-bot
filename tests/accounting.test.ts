import { describe, expect, it } from "vitest";

import type { Position } from "../src/domain.js";
import {
  buildDefiByProtocol,
  combineKnownTotals,
  priceWalletAsas,
  standardWalletAsas,
  sumProtocolValues,
} from "../src/services/accounting.js";
import { formatMoney, money } from "../src/services/money.js";

describe("accounting report math", () => {
  it("aggregates DeFi positions by protocol with signed debt", () => {
    const positions: Position[] = [
      {
        protocol: "folks",
        positionType: "supplied",
        positionId: "supplied-1",
        opportunityId: null,
        assetId: 31_566_704,
        assetSymbol: "USDC",
        amountRaw: "1000000",
        amount: "1",
        usdValue: 1,
      },
      {
        protocol: "folks",
        positionType: "debt",
        positionId: "debt-1",
        opportunityId: null,
        assetId: 0,
        assetSymbol: "ALGO",
        amountRaw: "1000000",
        amount: "1",
        usdValue: 0.5,
      },
      {
        protocol: "tinyman",
        positionType: "lp",
        positionId: "lp-1",
        opportunityId: null,
        assetId: 123,
        assetSymbol: "TMPOOL",
        amountRaw: "1",
        amount: "1",
        usdValue: 2,
      },
    ];

    const byProtocol = buildDefiByProtocol(positions);
    expect(byProtocol).toEqual([
      { protocol: "folks", valueUsd: "0.50", positionCount: 2 },
      { protocol: "tinyman", valueUsd: "2.00", positionCount: 1 },
    ]);
    expect(formatMoney(sumProtocolValues(byProtocol)!)).toBe("2.5");
  });

  it("prices standard wallet ASAs and reports unpriced assets without failing", () => {
    const priced = priceWalletAsas(
      [
        {
          assetId: 31_566_704,
          amountRaw: "2000000",
          decimals: 6,
          symbol: "USDC",
        },
        {
          assetId: 1_164_556_102,
          amountRaw: "1000",
          decimals: 0,
        },
      ],
      [
        {
          assetId: 31_566_704,
          priceUsd: "1",
          source: "compx",
          fetchedAt: new Date().toISOString(),
          stale: false,
        },
      ],
      24,
    );

    expect(formatMoney(priced.walletAsaValueUsd!)).toBe("2");
    expect(priced.unpricedAssetIds).toEqual([1_164_556_102]);
    expect(priced.notes[0]).toContain("Missing USD price");
  });

  it("includes ALGO in wallet token USD pricing", () => {
    const balances = standardWalletAsas([
      { assetId: 0, amountRaw: "5000000", decimals: 6, symbol: "ALGO" },
      { assetId: 31_566_704, amountRaw: "1000000", decimals: 6 },
    ]);
    const priced = priceWalletAsas(
      balances,
      [
        {
          assetId: 0,
          priceUsd: "0.2",
          source: "compx",
          fetchedAt: new Date().toISOString(),
          stale: false,
        },
        {
          assetId: 31_566_704,
          priceUsd: "1",
          source: "compx",
          fetchedAt: new Date().toISOString(),
          stale: false,
        },
      ],
      24,
    );
    expect(balances.map((balance) => balance.assetId)).toEqual([
      0,
      31_566_704,
    ]);
    expect(formatMoney(priced.walletAsaValueUsd!)).toBe("2");
  });

  it("combines known DeFi and wallet totals", () => {
    expect(formatMoney(combineKnownTotals(money(2), money(3))!)).toBe("5");
    expect(formatMoney(combineKnownTotals(money(2), null)!)).toBe("2");
    expect(combineKnownTotals(null, null)).toBeNull();
  });
});
