import { randomUUID } from "node:crypto";

import type {
  AccountingCashflow,
  AccountingRun,
  AccountingSnapshot,
  AccountingSummary,
  AssetPrice,
  LiquidBalance,
  Position,
  ProtocolValue,
} from "../domain.js";
import type { PortfolioReader } from "../integrations/algorand/portfolio.js";
import type { Canix402Client } from "../integrations/canix402/client.js";
import {
  canonicalChecksum,
  type AccountingStore,
} from "../integrations/storage/accounting-store.js";
import type { CoordinatorMode, RunCoordinator } from "./run-coordinator.js";
import { RunCoordinatorBusyError } from "./run-coordinator.js";
import type { AccountingNotifier } from "./telegram.js";
import {
  formatMoney,
  formatUsd,
  money,
  moneyOrNull,
  subtractMoney,
  type Money,
} from "./money.js";

const ALGO_ASSET_ID = 0;
const ALGO_DECIMALS = 6;

export class AccountingRunInProgressError extends Error {
  constructor() {
    super("An accounting run is already in progress");
    this.name = "AccountingRunInProgressError";
  }
}

export interface AccountingState {
  latest?: AccountingRun;
}

export interface AccountingServiceOptions {
  walletAddress: string;
  maxSourceAgeHours: number;
}

export class AccountingService {
  private running = false;

  constructor(
    private readonly portfolioReader: PortfolioReader,
    private readonly canix: Pick<Canix402Client, "getTokenPrices">,
    private readonly store: AccountingStore,
    private readonly notifier: AccountingNotifier,
    private readonly coordinator: RunCoordinator,
    private readonly state: AccountingState,
    private readonly options: AccountingServiceOptions,
  ) {}

  async run(mode: CoordinatorMode = "wait"): Promise<AccountingRun> {
    if (this.running) {
      throw new AccountingRunInProgressError();
    }
    this.running = true;
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    let result: AccountingRun;

    try {
      result = await this.coordinator.runExclusive(
        () => this.execute(id, startedAt),
        mode,
      );
    } catch (error) {
      if (error instanceof RunCoordinatorBusyError) {
        result = {
          id,
          startedAt,
          completedAt: new Date().toISOString(),
          status: "busy",
          error: error.message,
        };
      } else {
        result = {
          id,
          startedAt,
          completedAt: new Date().toISOString(),
          status: "failed",
          error: safeErrorMessage(error),
        };
      }
    } finally {
      this.running = false;
    }

    try {
      await this.notifier.sendAccounting(result);
    } catch (error) {
      result.notificationError = safeErrorMessage(error);
    }
    this.state.latest = result;
    return result;
  }

  async recordCashflow(
    input: Omit<
      AccountingCashflow,
      "schemaVersion" | "checksum" | "recordedAt" | "walletAddress"
    > & {
      walletAddress?: string;
    },
  ): Promise<AccountingCashflow> {
    const walletAddress = input.walletAddress ?? this.options.walletAddress;
    const recordedAt = new Date().toISOString();
    const withoutChecksum = {
      schemaVersion: 1 as const,
      eventId: input.eventId,
      walletAddress,
      type: input.type,
      amountUsd: formatUsd(money(input.amountUsd).abs()),
      occurredAt: input.occurredAt,
      recordedAt,
      transactionId: input.transactionId,
      reference: input.reference,
      notes: input.notes,
    };
    const cashflow: AccountingCashflow = {
      ...withoutChecksum,
      checksum: canonicalChecksum(withoutChecksum),
    };
    await this.store.putCashflow(cashflow);
    return cashflow;
  }

  private async execute(id: string, startedAt: string): Promise<AccountingRun> {
    const previous = await this.store.getLatestSummary(
      this.options.walletAddress,
    );
    const { snapshot: portfolio } = await this.portfolioReader.read();
    const walletAsas = standardWalletAsas(portfolio.liquidBalances);
    const prices =
      walletAsas.length === 0
        ? []
        : await this.canix.getTokenPrices(
            walletAsas.map((balance) => balance.assetId),
          );
    const pricedAsas = priceWalletAsas(
      walletAsas,
      prices,
      this.options.maxSourceAgeHours,
    );
    const defiByProtocol = buildDefiByProtocol(portfolio.positions);
    const defiValueUsd = sumProtocolValues(defiByProtocol);
    const walletAsaValueUsd = pricedAsas.walletAsaValueUsd;
    const totalValueUsd = combineKnownTotals(defiValueUsd, walletAsaValueUsd);
    const algo = readAlgoBalance(portfolio.liquidBalances);
    const minimumBalanceRaw =
      portfolio.minimumBalanceRaw ??
      (algo.spendableAmountRaw === undefined
        ? "0"
        : (
            BigInt(algo.amountRaw) - BigInt(algo.spendableAmountRaw)
          ).toString());

    const notes = [
      ...pricedAsas.notes,
      ...defiNotes(portfolio.positions, defiByProtocol),
    ];
    if (!previous) {
      notes.push("No previous accounting baseline; P&L not available yet");
    }

    const asOf = new Date().toISOString();
    const snapshotBody = {
      schemaVersion: 2 as const,
      id,
      walletAddress: this.options.walletAddress,
      asOf,
      fetchedAt: portfolio.fetchedAt,
      defiByProtocol,
      defiValueUsd: moneyToString(defiValueUsd),
      walletAsaValueUsd: moneyToString(walletAsaValueUsd),
      unpricedAssetIds: pricedAsas.unpricedAssetIds,
      algoBalance: formatAlgoAmount(algo.amountRaw),
      algoBalanceRaw: algo.amountRaw,
      minimumBalance: formatAlgoAmount(minimumBalanceRaw),
      minimumBalanceRaw,
      totalValueUsd: moneyToString(totalValueUsd),
      notes,
      prices: annotatePriceStaleness(prices, this.options.maxSourceAgeHours),
    };
    const snapshot: AccountingSnapshot = {
      ...snapshotBody,
      checksum: canonicalChecksum(snapshotBody),
    };

    const previousTotal = moneyOrNull(previous?.latestTotalValueUsd);
    const pnlUsd = subtractMoney(totalValueUsd, previousTotal);
    const summaryBody = {
      schemaVersion: 2 as const,
      walletAddress: this.options.walletAddress,
      asOf,
      latestSnapshotId: id,
      latestSnapshotKey: "",
      latestTotalValueUsd: moneyToString(totalValueUsd),
      previousTotalValueUsd: moneyToString(previousTotal),
      pnlUsd: moneyToString(pnlUsd),
      pnlAvailable: previousTotal !== null && totalValueUsd !== null,
      defiByProtocol,
      defiValueUsd: moneyToString(defiValueUsd),
      walletAsaValueUsd: moneyToString(walletAsaValueUsd),
      unpricedAssetIds: pricedAsas.unpricedAssetIds,
      algoBalance: snapshot.algoBalance,
      minimumBalance: snapshot.minimumBalance,
      notes,
    };

    const snapshotKey = await this.store.putSnapshot(snapshot);
    const summaryWithKey: AccountingSummary = {
      ...summaryBody,
      latestSnapshotKey: snapshotKey,
      checksum: "",
    };
    summaryWithKey.checksum = canonicalChecksum(summaryWithKey);

    try {
      await this.store.putLatestSummary(summaryWithKey);
      await this.store.putMonthlySummary(summaryWithKey, asOf.slice(0, 7));
    } catch (error) {
      summaryWithKey.notes = [
        ...summaryWithKey.notes,
        `Derived state write failed: ${safeErrorMessage(error)}`,
      ];
      summaryWithKey.checksum = canonicalChecksum(summaryWithKey);
    }

    return {
      id,
      startedAt,
      completedAt: new Date().toISOString(),
      status: "completed",
      snapshot,
      summary: summaryWithKey,
      snapshotKey,
    };
  }
}

/** Liquid wallet balances to USD-price, including ALGO. */
export function standardWalletAsas(balances: LiquidBalance[]): LiquidBalance[] {
  return balances;
}

export function buildDefiByProtocol(positions: Position[]): ProtocolValue[] {
  const byProtocol = new Map<
    string,
    { total: Money; count: number; valued: number }
  >();

  for (const position of positions) {
    const entry = byProtocol.get(position.protocol) ?? {
      total: money(0),
      count: 0,
      valued: 0,
    };
    entry.count += 1;
    if (position.usdValue !== null) {
      const signed =
        position.positionType === "debt"
          ? money(position.usdValue).negated()
          : money(position.usdValue);
      entry.total = entry.total.plus(signed);
      entry.valued += 1;
    }
    byProtocol.set(position.protocol, entry);
  }

  return [...byProtocol.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([protocol, entry]) => ({
      protocol,
      valueUsd:
        entry.valued === 0 && entry.count > 0
          ? null
          : moneyToString(entry.total),
      positionCount: entry.count,
    }));
}

export function sumProtocolValues(protocols: ProtocolValue[]): Money | null {
  if (protocols.length === 0) {
    return money(0);
  }
  const values = protocols.map((entry) => moneyOrNull(entry.valueUsd));
  const known = values.filter((value): value is Money => value !== null);
  if (known.length === 0) {
    return null;
  }
  return known.reduce((sum, value) => sum.plus(value), money(0));
}

export function combineKnownTotals(
  defiValueUsd: Money | null,
  walletAsaValueUsd: Money | null,
): Money | null {
  if (defiValueUsd === null && walletAsaValueUsd === null) {
    return null;
  }
  return (defiValueUsd ?? money(0)).plus(walletAsaValueUsd ?? money(0));
}

export function priceWalletAsas(
  balances: LiquidBalance[],
  prices: AssetPrice[],
  maxSourceAgeHours: number,
): {
  walletAsaValueUsd: Money | null;
  unpricedAssetIds: number[];
  notes: string[];
} {
  const notes: string[] = [];
  const unpricedAssetIds: number[] = [];
  const priceByAsset = new Map(
    annotatePriceStaleness(prices, maxSourceAgeHours).map((price) => [
      price.assetId,
      price,
    ]),
  );
  const values: Array<Money | null> = [];

  for (const balance of balances) {
    const price = priceByAsset.get(balance.assetId);
    if (!price || price.priceUsd === null) {
      unpricedAssetIds.push(balance.assetId);
      notes.push(`Missing USD price for asset ${balance.assetId}`);
      values.push(null);
      continue;
    }
    if (price.stale) {
      notes.push(`Stale USD price for asset ${balance.assetId}`);
    }
    const decimals = balance.decimals ?? 0;
    const amount = money(balance.amountRaw).div(money(10).pow(decimals));
    values.push(amount.times(money(price.priceUsd)));
  }

  const priced = values.filter((value): value is Money => value !== null);
  const walletAsaValueUsd =
    priced.length === 0 && unpricedAssetIds.length > 0
      ? null
      : priced.length === 0
        ? money(0)
        : priced.reduce((sum, value) => sum.plus(value), money(0));

  return { walletAsaValueUsd, unpricedAssetIds, notes };
}

function defiNotes(
  positions: Position[],
  defiByProtocol: ProtocolValue[],
): string[] {
  const notes: string[] = [];
  if (positions.length === 0) {
    notes.push("No DeFi positions");
    return notes;
  }
  for (const position of positions) {
    if (position.usdValue === null) {
      notes.push(`Missing USD valuation for position ${position.positionId}`);
    }
  }
  for (const entry of defiByProtocol) {
    if (entry.valueUsd === null) {
      notes.push(`Incomplete USD total for protocol ${entry.protocol}`);
    }
  }
  return notes;
}

function readAlgoBalance(balances: LiquidBalance[]): LiquidBalance {
  return (
    balances.find((balance) => balance.assetId === ALGO_ASSET_ID) ?? {
      assetId: ALGO_ASSET_ID,
      amountRaw: "0",
      spendableAmountRaw: "0",
      decimals: ALGO_DECIMALS,
      symbol: "ALGO",
    }
  );
}

function formatAlgoAmount(amountRaw: string): string {
  return formatMoney(money(amountRaw).div(money(10).pow(ALGO_DECIMALS)));
}

function annotatePriceStaleness(
  prices: AssetPrice[],
  maxSourceAgeHours: number,
): AssetPrice[] {
  const oldestAllowed = Date.now() - maxSourceAgeHours * 3_600_000;
  return prices.map((price) => ({
    ...price,
    stale: new Date(price.fetchedAt).getTime() < oldestAllowed,
  }));
}

function moneyToString(value: Money | null): string | null {
  return value === null ? null : formatUsd(value);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
