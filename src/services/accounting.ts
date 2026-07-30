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
import {
  CashflowTxError,
  type CashflowTxDirection,
  type CashflowTxResolver,
  type ResolvedCashflowTransfer,
} from "../integrations/algorand/cashflow-tx.js";
import type { Canix402Client } from "../integrations/canix402/client.js";
import {
  canonicalChecksum,
  type AccountingStore,
} from "../integrations/storage/accounting-store.js";
import type { CoordinatorMode, RunCoordinator } from "./run-coordinator.js";
import { RunCoordinatorBusyError } from "./run-coordinator.js";
import type { AccountingNotifier } from "./telegram.js";
import {
  formatBaseUnits,
  formatMoney,
  formatUsd,
  money,
  moneyOrNull,
  subtractMoney,
  type Money,
} from "./money.js";
import {
  collectRepriceAssetIds,
  repricePositionsFromTokenPrices,
} from "./position-pricing.js";
import { sanitizeErrorMessage } from "../util/errors.js";

const ALGO_ASSET_ID = 0;
const ALGO_DECIMALS = 6;

export class AccountingRunInProgressError extends Error {
  constructor() {
    super("An accounting run is already in progress");
    this.name = "AccountingRunInProgressError";
  }
}

export class CashflowAlreadyRecordedError extends Error {
  readonly cashflow: AccountingCashflow;

  constructor(cashflow: AccountingCashflow) {
    super(`Cashflow ${cashflow.eventId} is already recorded`);
    this.name = "CashflowAlreadyRecordedError";
    this.cashflow = cashflow;
  }
}

export interface AccountingState {
  latest?: AccountingRun;
}

export interface AccountingServiceOptions {
  walletAddress: string;
  maxSourceAgeHours: number;
}

export interface RecordCashflowFromTxResult {
  cashflow: AccountingCashflow;
  transfer: ResolvedCashflowTransfer;
  amountLabel: string;
  alreadyRecorded: boolean;
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
    private readonly cashflowTxResolver?: CashflowTxResolver,
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

  /**
   * Resolve an on-chain pay/axfer by txid, price to USD, and record as an
   * external deposit or withdrawal. `eventId` is the transaction id.
   */
  async recordCashflowFromTx(input: {
    type: "external_deposit" | "external_withdrawal";
    transactionId: string;
  }): Promise<RecordCashflowFromTxResult> {
    if (!this.cashflowTxResolver) {
      throw new CashflowTxError(
        "Cashflow transaction lookup is not configured",
      );
    }
    const txid = input.transactionId.trim();
    if (!txid) {
      throw new CashflowTxError("Transaction id is required");
    }

    const existing = await this.store.getCashflowByEventId(
      this.options.walletAddress,
      txid,
    );
    if (existing) {
      throw new CashflowAlreadyRecordedError(existing);
    }

    const direction: CashflowTxDirection =
      input.type === "external_deposit" ? "deposit" : "withdraw";
    const transfer = await this.cashflowTxResolver.resolve(txid, direction);
    const prices = await this.canix.getTokenPrices([transfer.assetId]);
    const price = prices.find((entry) => entry.assetId === transfer.assetId);
    if (!price || price.priceUsd === null) {
      throw new CashflowTxError(
        `No USD price available for ${transfer.symbol} (asset ${transfer.assetId})`,
      );
    }

    const tokenAmount = money(transfer.amountRaw).div(
      money(10).pow(transfer.decimals),
    );
    const amountUsd = formatUsd(tokenAmount.times(money(price.priceUsd)));
    const amountLabel = `${formatBaseUnits(transfer.amountRaw, transfer.decimals)} ${transfer.symbol}`;
    const partyLabel =
      input.type === "external_deposit" ? "from" : "to";
    const notes = `${amountLabel} (asset ${transfer.assetId}) ${partyLabel} ${transfer.counterparty}`;

    const cashflow = await this.recordCashflow({
      eventId: txid,
      type: input.type,
      amountUsd,
      occurredAt: transfer.occurredAt,
      transactionId: txid,
      notes,
    });

    return {
      cashflow,
      transfer,
      amountLabel,
      alreadyRecorded: false,
    };
  }

  private async execute(id: string, startedAt: string): Promise<AccountingRun> {
    const previous = await this.store.getLatestSummary(
      this.options.walletAddress,
    );
    const { snapshot: portfolio } = await this.portfolioReader.read();
    const walletAsas = standardWalletAsas(portfolio.liquidBalances);
    const priceAssetIds = [
      ...new Set([
        ...walletAsas.map((balance) => balance.assetId),
        ...collectRepriceAssetIds(portfolio.positions),
      ]),
    ];
    const prices =
      priceAssetIds.length === 0
        ? []
        : await this.canix.getTokenPrices(priceAssetIds);
    const { positions, notes: repriceNotes } = repricePositionsFromTokenPrices(
      portfolio.positions,
      prices,
    );
    const pricedAsas = priceWalletAsas(
      walletAsas,
      prices,
      this.options.maxSourceAgeHours,
    );
    const defiByProtocol = buildDefiByProtocol(positions);
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
      ...repriceNotes,
      ...defiNotes(positions, defiByProtocol),
    ];
    if (!previous) {
      notes.push("No previous accounting baseline; P&L not available yet");
    }

    const asOf = new Date().toISOString();
    const previousTotal = moneyOrNull(previous?.latestTotalValueUsd);
    const navDeltaUsd = subtractMoney(totalValueUsd, previousTotal);

    let cashflows: AccountingCashflow[] = [];
    let netExternalCashflowUsd: Money | null = null;
    let pnlUsd = navDeltaUsd;
    if (previous && navDeltaUsd !== null && totalValueUsd !== null) {
      cashflows = await this.store.listCashflows(
        this.options.walletAddress,
        cashflowWindowFrom(previous.asOf),
        cashflowWindowTo(asOf),
      );
      const adjustment = computeCashflowAdjustment(cashflows);
      netExternalCashflowUsd = adjustment.netExternalCashflowUsd;
      pnlUsd = navDeltaUsd.minus(adjustment.depositsUsd).plus(adjustment.withdrawalsUsd);
      if (cashflows.length > 0) {
        notes.push(
          `P&L adjusted for ${adjustment.depositCount} deposit(s) (−$${formatUsd(adjustment.depositsUsd)}) and ${adjustment.withdrawalCount} withdrawal(s) (+$${formatUsd(adjustment.withdrawalsUsd)})`,
        );
      }
    }

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
      navDeltaUsd: moneyToString(navDeltaUsd),
      netExternalCashflowUsd: moneyToString(netExternalCashflowUsd),
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

/**
 * Store listCashflows uses [fromInclusive, toExclusive).
 * Map plan window (previous.asOf, asOf] onto that API.
 */
export function cashflowWindowFrom(previousAsOf: string): string {
  return new Date(new Date(previousAsOf).getTime() + 1).toISOString();
}

export function cashflowWindowTo(asOf: string): string {
  return new Date(new Date(asOf).getTime() + 1).toISOString();
}

export function computeCashflowAdjustment(cashflows: AccountingCashflow[]): {
  depositsUsd: Money;
  withdrawalsUsd: Money;
  netExternalCashflowUsd: Money;
  depositCount: number;
  withdrawalCount: number;
} {
  let depositsUsd = money(0);
  let withdrawalsUsd = money(0);
  let depositCount = 0;
  let withdrawalCount = 0;
  for (const cashflow of cashflows) {
    const amount = money(cashflow.amountUsd).abs();
    if (cashflow.type === "external_deposit") {
      depositsUsd = depositsUsd.plus(amount);
      depositCount += 1;
    } else {
      withdrawalsUsd = withdrawalsUsd.plus(amount);
      withdrawalCount += 1;
    }
  }
  return {
    depositsUsd,
    withdrawalsUsd,
    // Positive = net capital in (deposits − withdrawals) for report clarity.
    netExternalCashflowUsd: depositsUsd.minus(withdrawalsUsd),
    depositCount,
    withdrawalCount,
  };
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
  return sanitizeErrorMessage(error);
}
