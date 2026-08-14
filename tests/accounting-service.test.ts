import { describe, expect, it, vi } from "vitest";

import type {
  AccountingCashflow,
  AccountingSnapshot,
  AccountingSummary,
  PublicPnl,
} from "../src/domain.js";
import type { AccountingStore } from "../src/integrations/storage/accounting-store.js";
import {
  AccountingService,
  CashflowAlreadyRecordedError,
  computeCashflowAdjustment,
  toPublicPnl,
} from "../src/services/accounting.js";
import { RunCoordinator } from "../src/services/run-coordinator.js";
import { portfolioSnapshot } from "./fixtures.js";

function memoryStore(cashflows: AccountingCashflow[] = []): AccountingStore & {
  snapshots: AccountingSnapshot[];
  summaries: AccountingSummary[];
  cashflows: AccountingCashflow[];
  publicPnls: PublicPnl[];
  failPublicPnlWith?: Error;
} {
  const snapshots: AccountingSnapshot[] = [];
  const summaries: AccountingSummary[] = [];
  const publicPnls: PublicPnl[] = [];
  const store: AccountingStore & {
    snapshots: AccountingSnapshot[];
    summaries: AccountingSummary[];
    cashflows: AccountingCashflow[];
    publicPnls: PublicPnl[];
    failPublicPnlWith?: Error;
  } = {
    snapshots,
    summaries,
    cashflows,
    publicPnls,
    putSnapshot(snapshot) {
      snapshots.push(snapshot);
      return Promise.resolve(
        `wallets/${snapshot.walletAddress}/snapshots/${snapshot.id}.json`,
      );
    },
    putCashflow(cashflow) {
      cashflows.push(cashflow);
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
    putPublicPnl(payload) {
      if (store.failPublicPnlWith) {
        return Promise.reject(store.failPublicPnlWith);
      }
      publicPnls.push(payload);
      return Promise.resolve("public/pnl.json");
    },
    getInception() {
      return Promise.resolve(undefined);
    },
    putInception() {
      return Promise.resolve("inception");
    },
    getInceptionReview() {
      return Promise.resolve(undefined);
    },
    putInceptionReview() {
      return Promise.resolve("inception-review");
    },
    listCashflows(_wallet, fromInclusive, toExclusive) {
      const from = new Date(fromInclusive).getTime();
      const to = new Date(toExclusive).getTime();
      return Promise.resolve(
        cashflows.filter((cashflow) => {
          const occurred = new Date(cashflow.occurredAt).getTime();
          return occurred >= from && occurred < to;
        }),
      );
    },
    listSnapshots() {
      return Promise.resolve(snapshots);
    },
    listSnapshotsBetween() {
      return Promise.resolve(snapshots);
    },
    getCashflowByEventId(_wallet, eventId) {
      return Promise.resolve(
        cashflows.find((cashflow) => cashflow.eventId === eventId),
      );
    },
  };
  return store;
}

describe("computeCashflowAdjustment", () => {
  it("nets deposits against withdrawals", () => {
    const result = computeCashflowAdjustment([
      {
        schemaVersion: 1,
        eventId: "d1",
        walletAddress: "WALLET",
        type: "external_deposit",
        amountUsd: "100.00",
        occurredAt: "2026-07-15T09:00:00.000Z",
        recordedAt: "2026-07-15T09:00:00.000Z",
        checksum: "a",
      },
      {
        schemaVersion: 1,
        eventId: "w1",
        walletAddress: "WALLET",
        type: "external_withdrawal",
        amountUsd: "25.00",
        occurredAt: "2026-07-15T10:00:00.000Z",
        recordedAt: "2026-07-15T10:00:00.000Z",
        checksum: "b",
      },
      {
        schemaVersion: 1,
        eventId: "p1",
        walletAddress: "WALLET",
        type: "profit_share_withdrawal",
        amountUsd: "5.00",
        occurredAt: "2026-07-15T11:00:00.000Z",
        recordedAt: "2026-07-15T11:00:00.000Z",
        checksum: "c",
      },
    ]);
    expect(result.depositCount).toBe(1);
    expect(result.withdrawalCount).toBe(2);
    expect(result.depositsUsd.toFixed(2)).toBe("100.00");
    expect(result.withdrawalsUsd.toFixed(2)).toBe("30.00");
    expect(result.netExternalCashflowUsd.toFixed(2)).toBe("70.00");
  });
});

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
                compatibleExitShapeKeys: [],
                compatibleManageShapeKeys: [],
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
    expect(run.summary?.notes.some((note) => note.includes("tinyman"))).toBe(
      false,
    );
    expect(store.snapshots).toHaveLength(1);
    expect(store.publicPnls).toHaveLength(1);
    expect(store.publicPnls[0]).toMatchObject({
      schemaVersion: 2,
      walletAddress: "WALLET",
      navUsd: "4.00",
      pnlAvailable: false,
    });
    expect(store.publicPnls[0]?.windows.all.available).toBe(false);
    expect(store.publicPnls[0]).not.toHaveProperty("notes");
    expect(store.publicPnls[0]).not.toHaveProperty("checksum");
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
    expect(run.summary?.navDeltaUsd).toBe("1.00");
    expect(run.summary?.netExternalCashflowUsd).toBe("0.00");
  });

  it("adjusts P&L for deposits and withdrawals in the window", async () => {
    const store = memoryStore([
      {
        schemaVersion: 1,
        eventId: "dep-1",
        walletAddress: "WALLET",
        type: "external_deposit",
        amountUsd: "10.00",
        occurredAt: "2026-07-15T12:00:00.000Z",
        recordedAt: "2026-07-15T12:00:00.000Z",
        checksum: "dep",
      },
    ]);
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
    const service = new AccountingService(
      {
        read: vi.fn().mockResolvedValue({
          snapshot: portfolioSnapshot({
            liquidBalances: [
              {
                assetId: 31_566_704,
                amountRaw: "13000000",
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
      { sendAccounting: vi.fn().mockResolvedValue(undefined) },
      new RunCoordinator(),
      {},
      { walletAddress: "WALLET", maxSourceAgeHours: 24 },
    );

    // NAV 13 − previous 2 = +11 raw; deposit 10 → economic P&L = 1
    const run = await service.run("wait");
    expect(run.summary?.navDeltaUsd).toBe("11.00");
    expect(run.summary?.netExternalCashflowUsd).toBe("10.00");
    expect(run.summary?.pnlUsd).toBe("1.00");
    expect(
      run.summary?.notes.some((note) => note.includes("P&L adjusted")),
    ).toBe(true);
  });

  it("records cashflows from resolved transactions and is idempotent", async () => {
    const store = memoryStore();
    const resolver = {
      resolve: vi.fn().mockResolvedValue({
        transactionId: "TXDEPOSIT",
        assetId: 31_566_704,
        amountRaw: "1000000",
        decimals: 6,
        symbol: "USDC",
        occurredAt: "2026-07-15T12:00:00.000Z",
        counterparty: "COUNTERPARTY",
        sender: "COUNTERPARTY",
        receiver: "WALLET",
      }),
    };
    const service = new AccountingService(
      { read: vi.fn() },
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
      { sendAccounting: vi.fn() },
      new RunCoordinator(),
      {},
      { walletAddress: "WALLET", maxSourceAgeHours: 24 },
      resolver as never,
    );

    const first = await service.recordCashflowFromTx({
      type: "external_deposit",
      transactionId: "TXDEPOSIT",
    });
    expect(first.cashflow.amountUsd).toBe("1.00");
    expect(first.amountLabel).toBe("1 USDC");
    expect(store.cashflows).toHaveLength(1);

    await expect(
      service.recordCashflowFromTx({
        type: "external_deposit",
        transactionId: "TXDEPOSIT",
      }),
    ).rejects.toBeInstanceOf(CashflowAlreadyRecordedError);
  });

  it("completes when public PnL publish fails", async () => {
    const store = memoryStore();
    store.failPublicPnlWith = new Error("spaces unavailable");
    const notifier = { sendAccounting: vi.fn().mockResolvedValue(undefined) };
    const service = new AccountingService(
      {
        read: vi.fn().mockResolvedValue({
          snapshot: portfolioSnapshot({
            liquidBalances: [
              {
                assetId: 31_566_704,
                amountRaw: "1000000",
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
      { walletAddress: "WALLET", maxSourceAgeHours: 24 },
    );

    const run = await service.run("wait");
    expect(run.status).toBe("completed");
    expect(store.publicPnls).toHaveLength(0);
    expect(
      run.summary?.notes.some((note) =>
        note.includes("Public PnL write failed"),
      ),
    ).toBe(true);
    expect(notifier.sendAccounting).toHaveBeenCalledOnce();
  });
});

describe("toPublicPnl", () => {
  it("redacts internal summary fields", () => {
    const publicPnl = toPublicPnl({
      schemaVersion: 2,
      walletAddress: "WALLET",
      asOf: "2026-07-16T08:00:00.000Z",
      latestSnapshotId: "secret-id",
      latestSnapshotKey: "wallets/WALLET/state/latest.json",
      latestTotalValueUsd: "10.00",
      previousTotalValueUsd: "8.00",
      pnlUsd: "2.00",
      pnlAvailable: true,
      navDeltaUsd: "2.00",
      netExternalCashflowUsd: "0",
      defiByProtocol: [
        { protocol: "folks", valueUsd: "5.00", positionCount: 1 },
      ],
      defiValueUsd: "5.00",
      walletAsaValueUsd: "5.00",
      unpricedAssetIds: [99],
      algoBalance: "1",
      minimumBalance: "0.1",
      notes: ["internal"],
      checksum: "abc",
    });

    expect(publicPnl).toEqual({
      schemaVersion: 2,
      walletAddress: "WALLET",
      asOf: "2026-07-16T08:00:00.000Z",
      navUsd: "10.00",
      previousNavUsd: "8.00",
      pnlUsd: "2.00",
      pnlAvailable: true,
      navDeltaUsd: "2.00",
      netExternalCashflowUsd: "0",
      defiByProtocol: [
        { protocol: "folks", valueUsd: "5.00", positionCount: 1 },
      ],
      defiValueUsd: "5.00",
      walletAsaValueUsd: "5.00",
      algoBalance: "1",
      windows: {
        "7d": expect.objectContaining({
          id: "7d",
          available: false,
        }) as PublicPnl["windows"]["7d"],
        "30d": expect.objectContaining({
          id: "30d",
          available: false,
        }) as PublicPnl["windows"]["30d"],
        all: expect.objectContaining({
          id: "all",
          available: false,
        }) as PublicPnl["windows"]["all"],
      },
      navSeries: [],
    });
    expect(publicPnl).not.toHaveProperty("notes");
    expect(publicPnl).not.toHaveProperty("checksum");
    expect(publicPnl).not.toHaveProperty("latestSnapshotKey");
    expect(publicPnl).not.toHaveProperty("unpricedAssetIds");
    expect(publicPnl).not.toHaveProperty("minimumBalance");
  });
});
