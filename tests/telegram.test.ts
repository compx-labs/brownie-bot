import { describe, expect, it } from "vitest";

import {
  formatAccountingTelegramReport,
  formatTelegramReport,
} from "../src/services/telegram.js";
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

describe("formatAccountingTelegramReport", () => {
  it("reports DeFi, wallet ASA total, ALGO, and P&L", () => {
    const report = formatAccountingTelegramReport({
      id: "acc-1",
      startedAt: "2026-07-16T08:00:00.000Z",
      completedAt: "2026-07-16T08:00:01.000Z",
      status: "completed",
      snapshotKey: "wallets/W/snapshots/2026/07/16/acc-1.json",
      summary: {
        schemaVersion: 2,
        walletAddress: "W",
        asOf: "2026-07-16T08:00:00.000Z",
        latestSnapshotId: "acc-1",
        latestSnapshotKey: "wallets/W/snapshots/2026/07/16/acc-1.json",
        latestTotalValueUsd: "110.00",
        previousTotalValueUsd: "100.00",
        pnlUsd: "10.00",
        pnlAvailable: true,
        defiByProtocol: [
          { protocol: "folks", valueUsd: "80.00", positionCount: 2 },
          { protocol: "tinyman", valueUsd: "20.00", positionCount: 1 },
        ],
        defiValueUsd: "100.00",
        walletAsaValueUsd: "10.00",
        unpricedAssetIds: [],
        algoBalance: "12.5",
        minimumBalance: "0.2",
        notes: [],
        checksum: "abc",
      },
    });
    expect(report).toContain("Treasury accounting run: completed");
    expect(report).toContain("folks: $80.00 (2)");
    expect(report).toContain("Wallet tokens total: $10.00");
    expect(report).toContain("ALGO balance: 12.5");
    expect(report).toContain("Account min balance: 0.2");
    expect(report).toContain("P&L vs previous: $10.00");
  });

  it("reports no previous baseline and unpriced ASAs without failing language", () => {
    const report = formatAccountingTelegramReport({
      id: "acc-2",
      startedAt: "2026-07-16T08:00:00.000Z",
      completedAt: "2026-07-16T08:00:01.000Z",
      status: "completed",
      summary: {
        schemaVersion: 2,
        walletAddress: "W",
        asOf: "2026-07-16T08:00:00.000Z",
        latestSnapshotId: "acc-2",
        latestSnapshotKey: "key",
        latestTotalValueUsd: "5",
        previousTotalValueUsd: null,
        pnlUsd: null,
        pnlAvailable: false,
        defiByProtocol: [],
        defiValueUsd: "0",
        walletAsaValueUsd: "5",
        unpricedAssetIds: [1_164_556_102],
        algoBalance: "1",
        minimumBalance: "0.1",
        notes: [
          "No previous accounting baseline; P&L not available yet",
          "Missing USD price for asset 1164556102",
        ],
        checksum: "abc",
      },
    });
    expect(report).toContain("DeFi positions:");
    expect(report).toContain("none");
    expect(report).toContain("P&L vs previous: no previous baseline");
    expect(report).toContain("Unpriced ASAs: 1164556102");
    expect(report).not.toContain("Caveats:");
  });
});
