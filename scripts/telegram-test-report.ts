import {
  isTelegramConfigured,
  loadConfig,
  requireTelegramCredentials,
} from "../src/config.js";
import { TelegramNotifier } from "../src/services/telegram.js";
import {
  opportunity,
  portfolioPlan,
  portfolioSnapshot,
} from "../tests/fixtures.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (!isTelegramConfigured(config)) {
    console.error("Telegram is not configured in .env");
    process.exit(1);
  }

  const { botToken, chatId } = requireTelegramCredentials(config);
  const notifier = new TelegramNotifier(botToken, chatId);
  const now = new Date().toISOString();

  await notifier.send({
    id: `test-rich-${Date.now()}`,
    startedAt: now,
    completedAt: now,
    status: "validated-dry-run",
    mode: "autonomous",
    signingEnabled: false,
    walletAddress: config.BOT_WALLET,
    snapshot: portfolioSnapshot(),
    plan: portfolioPlan({
      confidence: 0.87,
      projectedNetBenefitUsd: 4.25,
      summary:
        "Test rich Telegram report: sample *formatting*, _italics_, and `code`.",
      risks: [
        "This is a test message — no funds moved.",
        "Smart contract risk *exists*.",
      ],
      actions: [
        {
          id: "a1",
          type: "open",
          protocol: "folks",
          opportunityId: "opp-1",
          positionId: null,
          amountRaw: "1000000",
          fromAssetId: 31566704,
          toAssetId: null,
          targetWeightPct: 20,
          executionShapeKey: "folks.supply",
          executionInput: {},
          authorizedSpends: [{ assetId: 31566704, amountRaw: "1000000" }],
          rationale: "Sample Folks supply action for formatting.",
          dependencies: [],
        },
      ],
    }),
    policy: {
      approved: true,
      violations: [],
      warnings: ["Target position 36% exceeds guidance of 35% (test note)"],
      metrics: {
        maxPositionPct: 36,
        maxProtocolPct: 40,
        liquidReservePct: 25,
        turnoverPct: 5,
      },
    },
    executions: [
      {
        actionId: "a1",
        status: "validated-dry-run",
        transactionId:
          "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
      },
    ],
    opportunities: [opportunity()],
    payments: [
      {
        amountBaseUnits: "5000",
        assetId: "31566704",
        network: "algorand:mainnet",
      },
    ],
    inferenceCost: {
      totalUsdc: "0.0042",
      requestCount: 1,
      charges: [],
    },
  });
  console.log("Sent test review rich report to Telegram.");

  await notifier.sendAccounting({
    id: `test-acc-${Date.now()}`,
    startedAt: now,
    completedAt: now,
    status: "completed",
    snapshotKey: "wallets/TEST/snapshots/2026/07/23/test.json",
    summary: {
      schemaVersion: 2,
      walletAddress: "TEST",
      asOf: now,
      latestSnapshotId: "test",
      latestSnapshotKey: "wallets/TEST/snapshots/2026/07/23/test.json",
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
      unpricedAssetIds: [42],
      algoBalance: "12.5",
      minimumBalance: "0.2",
      notes: ["Test accounting rich report — ignore P&L."],
      checksum: "test",
    },
  });
  console.log("Sent test accounting rich report to Telegram.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
