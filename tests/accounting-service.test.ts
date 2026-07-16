import { describe, expect, it, vi } from "vitest";

import type { AccountingSnapshot, AccountingSummary } from "../src/domain.js";
import type { AccountingStore } from "../src/integrations/storage/accounting-store.js";
import { AccountingService } from "../src/services/accounting.js";
import { RunCoordinator } from "../src/services/run-coordinator.js";
import { portfolioSnapshot } from "./fixtures.js";

function memoryStore(): AccountingStore & {
  snapshots: AccountingSnapshot[];
  summaries: AccountingSummary[];
} {
  const snapshots: AccountingSnapshot[] = [];
  const summaries: AccountingSummary[] = [];
  return {
    snapshots,
    summaries,
    putSnapshot(snapshot) {
      snapshots.push(snapshot);
      return Promise.resolve(
        `wallets/${snapshot.walletAddress}/snapshots/${snapshot.id}.json`,
      );
    },
    putCashflow() {
      return Promise.resolve("cashflow");
    },
    getLatestSummary() {
      return Promise.resolve(summaries.at(-1));
    },
    putLatestSummary(summary) {
      summaries.push(summary);
      return Promise.resolve("latest");
    },
    getMonthlySummary() {
      return Promise.resolve(undefined);
    },
    putMonthlySummary(summary) {
      summaries.push(summary);
      return Promise.resolve("monthly");
    },
    listCashflows() {
      return Promise.resolve([]);
    },
    listSnapshots() {
      return Promise.resolve(snapshots);
    },
    getCashflowByEventId() {
      return Promise.resolve(undefined);
    },
  };
}

describe("AccountingService", () => {
  it("completes a first snapshot without a previous baseline", async () => {
    const store = memoryStore();
    const notifier = { sendAccounting: vi.fn().mockResolvedValue(undefined) };
    const service = new AccountingService(
      {
        read: vi.fn().mockResolvedValue({
          snapshot: portfolioSnapshot({
            liquidBalances: [
              {
                assetId: 0,
                amountRaw: "5000000",
                spendableAmountRaw: "4900000",
                decimals: 6,
                symbol: "ALGO",
              },
              {
                assetId: 31_566_704,
                amountRaw: "1000000",
                decimals: 6,
                symbol: "USDC",
              },
            ],
            minimumBalanceRaw: "100000",
            positions: [
              {
                protocol: "folks",
                positionType: "supplied",
                positionId: "supplied-1",
                opportunityId: null,
                assetId: 31_566_704,
                assetSymbol: "USDC",
                amountRaw: "2000000",
                amount: "2",
                usdValue: 2,
              },
            ],
            protocols: [
              {
                protocol: "tinyman",
                status: "partial",
                positionCount: 0,
                message: "Tinyman farm staking not exposed",
              },
            ],
            caveats: ["tinyman positions are partial"],
            complete: false,
          }),
          payments: [],
        }),
      },
      {
        getTokenPrices: vi.fn().mockResolvedValue([
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
        ]),
      },
      store,
      notifier,
      new RunCoordinator(),
      {},
      {
        walletAddress: "WALLET",
        maxSourceAgeHours: 24,
      },
    );

    const run = await service.run("wait");
    expect(run.status).toBe("completed");
    expect(run.summary?.latestTotalValueUsd).toBe("4.00");
    expect(run.summary?.walletAsaValueUsd).toBe("2.00");
    expect(run.summary?.defiByProtocol).toEqual([
      { protocol: "folks", valueUsd: "2.00", positionCount: 1 },
    ]);
    expect(run.summary?.algoBalance).toBe("5");
    expect(run.summary?.minimumBalance).toBe("0.1");
    expect(run.summary?.pnlAvailable).toBe(false);
    expect(run.summary?.notes.some((note) => note.includes("previous"))).toBe(
      true,
    );
    expect(
      run.summary?.notes.some((note) => note.includes("tinyman")),
    ).toBe(false);
    expect(store.snapshots).toHaveLength(1);
    expect(notifier.sendAccounting).toHaveBeenCalledOnce();
  });

  it("reports P&L against the previous summary", async () => {
    const store = memoryStore();
    store.summaries.push({
      schemaVersion: 2,
      walletAddress: "WALLET",
      asOf: "2026-07-15T08:00:00.000Z",
      latestSnapshotId: "prev",
      latestSnapshotKey: "prev",
      latestTotalValueUsd: "2",
      previousTotalValueUsd: null,
      pnlUsd: null,
      pnlAvailable: false,
      defiByProtocol: [],
      defiValueUsd: "0",
      walletAsaValueUsd: "2",
      unpricedAssetIds: [],
      algoBalance: "1",
      minimumBalance: "0.1",
      notes: [],
      checksum: "prev",
    });
    const notifier = { sendAccounting: vi.fn().mockResolvedValue(undefined) };
    const service = new AccountingService(
      {
        read: vi.fn().mockResolvedValue({
          snapshot: portfolioSnapshot({
            liquidBalances: [
              {
                assetId: 31_566_704,
                amountRaw: "3000000",
                decimals: 6,
                symbol: "USDC",
              },
            ],
            positions: [],
          }),
          payments: [],
        }),
      },
      {
        getTokenPrices: vi.fn().mockResolvedValue([
          {
            assetId: 31_566_704,
            priceUsd: "1",
            source: "compx",
            fetchedAt: new Date().toISOString(),
            stale: false,
          },
        ]),
      },
      store,
      notifier,
      new RunCoordinator(),
      {},
      {
        walletAddress: "WALLET",
        maxSourceAgeHours: 24,
      },
    );

    const run = await service.run("wait");
    expect(run.status).toBe("completed");
    expect(run.summary?.pnlAvailable).toBe(true);
    expect(run.summary?.pnlUsd).toBe("1.00");
  });
});
