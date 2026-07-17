import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertNoArgs,
  assertNoExtraArgs,
  parseLimit,
  printOpportunities,
  printPortfolioSnapshot,
} from "../src/cli/shared.js";
import { opportunity, portfolioSnapshot, position } from "./fixtures.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CLI arguments", () => {
  it("uses ten results by default and accepts an explicit limit", () => {
    expect(parseLimit(undefined)).toBe(10);
    expect(parseLimit("25")).toBe(25);
  });

  it("rejects invalid and extra arguments", () => {
    expect(() => parseLimit("0")).toThrow(/between 1 and 200/);
    expect(() => parseLimit("2.5")).toThrow(/between 1 and 200/);
    expect(() => assertNoExtraArgs(["10", "extra"])).toThrow(/at most one/);
    expect(() => assertNoArgs(["extra"])).toThrow(/does not take/);
  });
});

describe("CLI opportunity output", () => {
  it("prints distinct payer and personalization target details", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const table = vi.spyOn(console, "table").mockImplementation(() => {});
    const payer = "PAYER";
    const target = "KPEZM2DSFHOOHG7RPDECCBTD6FRN2LPSSRJMMFVCFSIHGES4BXBJHPUBVQ";

    printOpportunities(
      "Personalized opportunities",
      {
        opportunities: [opportunity({ apy: 12.5 })],
        payment: {
          amountBaseUnits: "50000",
          assetId: "31566704",
          network: "algorand:mainnet",
          responseHeader: "settled",
        },
      },
      payer,
      target,
    );

    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain(`x402 payer: ${payer}`);
    expect(output).toContain(`Personalization target: ${target}`);
    expect(output).toContain("0.05 USDC");
    expect(output).toContain("Settlement: settled");
    expect(table).toHaveBeenCalledWith([
      expect.objectContaining({
        Rank: 1,
        Protocol: "tinyman",
        "APY %": "12.5",
      }),
    ]);
  });
});

describe("CLI wallet scan output", () => {
  it("prints completeness, caveats, and null totals for incomplete scans", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const table = vi.spyOn(console, "table").mockImplementation(() => {});

    printPortfolioSnapshot(
      "Wallet scan",
      portfolioSnapshot({
        complete: false,
        caveats: [
          "tinyman positions are partial: farm staking not exposed",
          "At least one aggregate position valuation is incomplete",
        ],
        protocols: [
          {
            protocol: "tinyman",
            status: "partial",
            positionCount: 1,
            message: "farm staking not exposed",
          },
          {
            protocol: "dorkfi",
            status: "ok",
            positionCount: 0,
            message: null,
          },
        ],
        totals: {
          suppliedUsd: 10,
          borrowedUsd: null,
          rewardsUsd: null,
          netUsd: null,
        },
        positions: [position()],
      }),
      "PAYER",
      [
        {
          amountBaseUnits: "5000",
          assetId: "31566704",
          network: "algorand:mainnet",
        },
      ],
      24,
    );

    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("Snapshot complete: NO");
    expect(output).toContain("tinyman positions are partial");
    expect(output).toContain("Verdict: INCOMPLETE (2 caveat(s))");
    expect(output).toContain("0.005 USDC");
    expect(table).toHaveBeenCalled();
  });
});
