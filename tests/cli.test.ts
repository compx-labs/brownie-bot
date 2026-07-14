import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertNoExtraArgs,
  parseLimit,
  printOpportunities,
} from "../src/cli/shared.js";
import { opportunity } from "./fixtures.js";

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
