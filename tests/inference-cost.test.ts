import { describe, expect, it } from "vitest";

import {
  formatInferenceCostLine,
  parseInferenceCostFromHeaders,
  summarizeInferenceCosts,
} from "../src/services/inference-cost.js";

describe("inference-cost", () => {
  it("parses X-Zs-Inference-Amount from Headers", () => {
    const headers = new Headers({
      "X-Zs-Inference-Amount": "0.0042",
      "X-Zs-Other": "meta",
      "Content-Type": "application/json",
    });
    expect(parseInferenceCostFromHeaders(headers)).toEqual({
      amountUsdc: "0.0042",
      headers: {
        "x-zs-inference-amount": "0.0042",
        "x-zs-other": "meta",
      },
    });
  });

  it("sums charges across requests", () => {
    const summary = summarizeInferenceCosts([
      {
        amountUsdc: "0.01",
        headers: { "x-zs-inference-amount": "0.01" },
      },
      {
        amountUsdc: "0.0025",
        headers: { "x-zs-inference-amount": "0.0025" },
      },
    ]);
    expect(summary).toEqual({
      totalUsdc: "0.0125",
      requestCount: 2,
      charges: expect.any(Array),
    });
    expect(formatInferenceCostLine(summary)).toBe(
      "ZeroSignal inference: 2 request(s), $0.0125 USDC",
    );
  });

  it("returns undefined when the amount header is missing", () => {
    expect(
      parseInferenceCostFromHeaders(new Headers({ "x-zs-other": "1" })),
    ).toBeUndefined();
    expect(summarizeInferenceCosts([])).toBeUndefined();
    expect(formatInferenceCostLine(undefined)).toBeUndefined();
  });
});
