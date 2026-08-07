import type {
  AccountingCashflow,
  AccountingInception,
  AccountingSnapshot,
  NavSeriesPoint,
  PnlWindow,
  PnlWindowId,
} from "../domain.js";
import { pickSnapshotAtOrBefore } from "../integrations/storage/accounting-store.js";
import {
  formatUsd,
  money,
  moneyOrNull,
  subtractMoney,
  type Money,
} from "./money.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const WEEKLY_SERIES_MAX = 52;

export interface WindowPnlInput {
  id: PnlWindowId;
  endNavUsd: Money | null;
  endAsOf: string;
  startNavUsd: Money | null;
  startAsOf: string | null;
  cashflows: AccountingCashflow[];
  unavailableReason?: string;
}

export function computeWindowPnl(input: WindowPnlInput): PnlWindow {
  if (input.endNavUsd === null) {
    return unavailableWindow(input.id, "Current NAV is unknown");
  }
  if (input.startNavUsd === null || input.startAsOf === null) {
    return unavailableWindow(
      input.id,
      input.unavailableReason ?? "No baseline NAV for this window",
    );
  }

  const navDeltaUsd = subtractMoney(input.endNavUsd, input.startNavUsd);
  if (navDeltaUsd === null) {
    return unavailableWindow(input.id, "Could not compute NAV delta");
  }

  const adjustment = adjustForCashflows(input.cashflows);
  const pnlUsd = navDeltaUsd
    .minus(adjustment.depositsUsd)
    .plus(adjustment.withdrawalsUsd);

  return {
    id: input.id,
    available: true,
    startAsOf: input.startAsOf,
    navStartUsd: formatUsd(input.startNavUsd),
    pnlUsd: formatUsd(pnlUsd),
    navDeltaUsd: formatUsd(navDeltaUsd),
    netExternalCashflowUsd: formatUsd(adjustment.netExternalCashflowUsd),
  };
}

export function unavailableWindow(id: PnlWindowId, reason: string): PnlWindow {
  return {
    id,
    available: false,
    startAsOf: null,
    navStartUsd: null,
    pnlUsd: null,
    navDeltaUsd: null,
    netExternalCashflowUsd: null,
    reason,
  };
}

function adjustForCashflows(cashflows: AccountingCashflow[]): {
  depositsUsd: Money;
  withdrawalsUsd: Money;
  netExternalCashflowUsd: Money;
} {
  let depositsUsd = money(0);
  let withdrawalsUsd = money(0);
  for (const cashflow of cashflows) {
    const amount = money(cashflow.amountUsd).abs();
    if (cashflow.type === "external_deposit") {
      depositsUsd = depositsUsd.plus(amount);
    } else {
      withdrawalsUsd = withdrawalsUsd.plus(amount);
    }
  }
  return {
    depositsUsd,
    withdrawalsUsd,
    netExternalCashflowUsd: depositsUsd.minus(withdrawalsUsd),
  };
}

/** Store listCashflows uses [fromInclusive, toExclusive). */
function cashflowWindowFrom(previousAsOf: string): string {
  return new Date(new Date(previousAsOf).getTime() + 1).toISOString();
}

function cashflowWindowTo(asOf: string): string {
  return new Date(new Date(asOf).getTime() + 1).toISOString();
}

export interface BuildWindowsParams {
  endAsOf: string;
  endNavUsd: Money | null;
  inception: AccountingInception | undefined;
  snapshots: AccountingSnapshot[];
  listCashflows: (
    fromInclusive: string,
    toExclusive: string,
  ) => Promise<AccountingCashflow[]>;
}

export async function buildPnlWindows(params: BuildWindowsParams): Promise<{
  "7d": PnlWindow;
  "30d": PnlWindow;
  all: PnlWindow;
}> {
  const endNav = params.endNavUsd;

  const window7d = await buildRollingWindow({
    id: "7d",
    days: 7,
    endAsOf: params.endAsOf,
    endNavUsd: endNav,
    snapshots: params.snapshots,
    listCashflows: params.listCashflows,
  });
  const window30d = await buildRollingWindow({
    id: "30d",
    days: 30,
    endAsOf: params.endAsOf,
    endNavUsd: endNav,
    snapshots: params.snapshots,
    listCashflows: params.listCashflows,
  });

  let all: PnlWindow;
  if (!params.inception) {
    all = unavailableWindow("all", "Inception baseline not set");
  } else {
    const cashflows = await params.listCashflows(
      cashflowWindowFrom(params.inception.asOf),
      cashflowWindowTo(params.endAsOf),
    );
    all = computeWindowPnl({
      id: "all",
      endNavUsd: endNav,
      endAsOf: params.endAsOf,
      startNavUsd: moneyOrNull(params.inception.navUsd),
      startAsOf: params.inception.asOf,
      cashflows,
    });
  }

  return { "7d": window7d, "30d": window30d, all };
}

async function buildRollingWindow(input: {
  id: "7d" | "30d";
  days: number;
  endAsOf: string;
  endNavUsd: Money | null;
  snapshots: AccountingSnapshot[];
  listCashflows: (
    fromInclusive: string,
    toExclusive: string,
  ) => Promise<AccountingCashflow[]>;
}): Promise<PnlWindow> {
  const targetAsOf = new Date(
    new Date(input.endAsOf).getTime() - input.days * MS_PER_DAY,
  ).toISOString();
  const startSnapshot = pickSnapshotAtOrBefore(input.snapshots, targetAsOf);
  if (!startSnapshot || startSnapshot.totalValueUsd === null) {
    return unavailableWindow(
      input.id,
      `No snapshot at or before ${targetAsOf}`,
    );
  }
  const cashflows = await input.listCashflows(
    cashflowWindowFrom(startSnapshot.asOf),
    cashflowWindowTo(input.endAsOf),
  );
  return computeWindowPnl({
    id: input.id,
    endNavUsd: input.endNavUsd,
    endAsOf: input.endAsOf,
    startNavUsd: money(startSnapshot.totalValueUsd),
    startAsOf: startSnapshot.asOf,
    cashflows,
  });
}

/** One NAV point per ISO week (UTC), keeping the latest snapshot in each week. */
export function buildWeeklyNavSeries(
  snapshots: AccountingSnapshot[],
  current?: { asOf: string; navUsd: string | null },
  maxPoints = WEEKLY_SERIES_MAX,
): NavSeriesPoint[] {
  const byWeek = new Map<string, NavSeriesPoint>();
  for (const snapshot of snapshots) {
    if (snapshot.totalValueUsd === null) {
      continue;
    }
    const weekKey = isoWeekKey(snapshot.asOf);
    const existing = byWeek.get(weekKey);
    if (!existing || snapshot.asOf >= existing.asOf) {
      byWeek.set(weekKey, {
        asOf: snapshot.asOf,
        navUsd: snapshot.totalValueUsd,
      });
    }
  }
  if (current?.navUsd !== null && current?.navUsd !== undefined) {
    const weekKey = isoWeekKey(current.asOf);
    byWeek.set(weekKey, { asOf: current.asOf, navUsd: current.navUsd });
  }
  return [...byWeek.values()]
    .sort((left, right) => left.asOf.localeCompare(right.asOf))
    .slice(-maxPoints);
}

function isoWeekKey(asOf: string): string {
  const date = new Date(asOf);
  const utc = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((utc.getTime() - yearStart.getTime()) / MS_PER_DAY + 1) / 7,
  );
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
