import { describe, expect, it } from "vitest";

import type { AccountingCashflow, AccountingSnapshot } from "../src/domain.js";
import {
  buildPnlWindows,
  buildWeeklyNavSeries,
  computeWindowPnl,
} from "../src/services/pnl-windows.js";
import { money } from "../src/services/money.js";

function cashflow(
  partial: Partial<AccountingCashflow> &
    Pick<AccountingCashflow, "eventId" | "type" | "amountUsd" | "occurredAt">,
): AccountingCashflow {
  return {
    schemaVersion: 1,
    walletAddress: "WALLET",
    recordedAt: partial.occurredAt,
    checksum: partial.eventId,
    ...partial,
  };
}

function snapshot(asOf: string, totalValueUsd: string): AccountingSnapshot {
  return {
    schemaVersion: 2,
    id: asOf,
    walletAddress: "WALLET",
    asOf,
    fetchedAt: asOf,
    defiByProtocol: [],
    defiValueUsd: "0",
    walletAsaValueUsd: totalValueUsd,
    unpricedAssetIds: [],
    algoBalance: "0",
    algoBalanceRaw: "0",
    minimumBalance: "0",
    minimumBalanceRaw: "0",
    totalValueUsd,
    notes: [],
    prices: [],
    checksum: asOf,
  };
}

describe("computeWindowPnl", () => {
  it("applies cashflow-aware PnL over an arbitrary window", () => {
    const result = computeWindowPnl({
      id: "7d",
      endNavUsd: money("130"),
      endAsOf: "2026-08-06T00:00:00.000Z",
      startNavUsd: money("100"),
      startAsOf: "2026-07-30T00:00:00.000Z",
      cashflows: [
        cashflow({
          eventId: "d1",
          type: "external_deposit",
          amountUsd: "20.00",
          occurredAt: "2026-08-01T00:00:00.000Z",
        }),
      ],
    });
    expect(result.available).toBe(true);
    expect(result.navDeltaUsd).toBe("30.00");
    expect(result.pnlUsd).toBe("10.00");
    expect(result.netExternalCashflowUsd).toBe("20.00");
  });

  it("marks windows unavailable without a start NAV", () => {
    const result = computeWindowPnl({
      id: "30d",
      endNavUsd: money("100"),
      endAsOf: "2026-08-06T00:00:00.000Z",
      startNavUsd: null,
      startAsOf: null,
      cashflows: [],
      unavailableReason: "No snapshot",
    });
    expect(result.available).toBe(false);
    expect(result.reason).toBe("No snapshot");
  });
});

describe("buildPnlWindows", () => {
  it("requires inception for all-time and snapshots for rolling windows", async () => {
    const windows = await buildPnlWindows({
      endAsOf: "2026-08-06T12:00:00.000Z",
      endNavUsd: money("200"),
      inception: undefined,
      snapshots: [snapshot("2026-08-05T12:00:00.000Z", "190")],
      listCashflows: () => Promise.resolve([]),
    });
    expect(windows.all.available).toBe(false);
    expect(windows["7d"].available).toBe(false);
    expect(windows["30d"].available).toBe(false);
  });

  it("computes all-time from inception and 7d from nearest snapshot", async () => {
    const cashflows: AccountingCashflow[] = [
      cashflow({
        eventId: "d1",
        type: "external_deposit",
        amountUsd: "50.00",
        occurredAt: "2026-07-20T00:00:00.000Z",
      }),
    ];
    const windows = await buildPnlWindows({
      endAsOf: "2026-08-06T12:00:00.000Z",
      endNavUsd: money("200"),
      inception: {
        schemaVersion: 1,
        walletAddress: "WALLET",
        asOf: "2026-07-16T21:21:50.000Z",
        navUsd: "100.00",
        minRound: 63_163_056,
        recordedAt: "2026-08-06T12:00:00.000Z",
        reviewChecksum: "abc",
      },
      snapshots: [
        snapshot("2026-07-30T12:00:00.000Z", "150"),
        snapshot("2026-08-01T12:00:00.000Z", "160"),
      ],
      listCashflows: (from, to) =>
        Promise.resolve(
          cashflows.filter((item) => {
            const t = new Date(item.occurredAt).getTime();
            return t >= new Date(from).getTime() && t < new Date(to).getTime();
          }),
        ),
    });
    expect(windows.all.available).toBe(true);
    expect(windows.all.pnlUsd).toBe("50.00");
    expect(windows["7d"].available).toBe(true);
    expect(windows["7d"].navStartUsd).toBe("150.00");
  });
});

describe("buildWeeklyNavSeries", () => {
  it("keeps one point per ISO week", () => {
    const series = buildWeeklyNavSeries(
      [
        snapshot("2026-07-01T00:00:00.000Z", "10"),
        snapshot("2026-07-02T00:00:00.000Z", "11"),
        snapshot("2026-07-08T00:00:00.000Z", "12"),
      ],
      { asOf: "2026-07-09T00:00:00.000Z", navUsd: "13" },
    );
    expect(series.length).toBeGreaterThanOrEqual(2);
    expect(series.at(-1)?.navUsd).toBe("13");
  });
});
