import { describe, expect, it } from "vitest";

import { formatTelegramReport } from "../src/services/telegram.js";
import { portfolioPlan, portfolioSnapshot } from "./fixtures.js";

describe("formatTelegramReport", () => {
  it("formats autonomous plan and payment details", () => {
    const report = formatTelegramReport({
      id: "run-1",
      startedAt: "2026-07-13T09:00:00.000Z",
      completedAt: "2026-07-13T09:00:01.000Z",
      status: "no-op",
      mode: "autonomous",
      signingEnabled: false,
      walletAddress:
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ",
      snapshot: portfolioSnapshot(),
      plan: portfolioPlan({
        confidence: 0.85,
        risks: ["Yield is variable."],
      }),
      opportunities: [],
      payments: [
        {
          amountBaseUnits: "50000",
          assetId: "31566704",
          network: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
          responseHeader: "settled",
        },
      ],
    });

    expect(report).toContain("Treasury portfolio run: no-op");
    expect(report).toContain("Mode: autonomous");
    expect(report).toContain("Signing: disabled");
    expect(report).toContain("Plan confidence: 85%");
    expect(report).toContain("50000 USDC base units");
  });
});
