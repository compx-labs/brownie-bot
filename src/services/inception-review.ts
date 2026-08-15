import algosdk from "algosdk";

import type {
  AccountingInception,
  AssetPrice,
  InceptionReview,
  InceptionReviewRow,
} from "../domain.js";
import {
  CashflowTxError,
  parseCashflowTransfer,
  readConfirmedRound,
  type AssetMetadata,
  type IndexerTransactionLike,
} from "../integrations/algorand/cashflow-tx.js";
import {
  canonicalChecksum,
  type AccountingStore,
} from "../integrations/storage/accounting-store.js";
import type { Canix402Client } from "../integrations/canix402/client.js";
import type { AccountingService } from "./accounting.js";
import { formatBaseUnits, formatUsd, money } from "./money.js";

/** CompX treasury tracking start (operator-provided). */
export const DEFAULT_INCEPTION_MIN_ROUND = 63_163_056;
/** 2026-07-16T22:21:50+01:00 */
export const DEFAULT_INCEPTION_AS_OF = "2026-07-16T21:21:50.000Z";

const ALGO_ASSET_ID = 0;
const ALGO_DECIMALS = 6;

const PRICE_NOTE =
  "USD amounts use current CompX/Canix token prices at review time, not historical prices at each round. DeFi positions open at minRound are not included in proposed inception NAV (liquid balances only).";

type IndexerTx = IndexerTransactionLike & {
  group?: string;
  "inner-txns"?: IndexerTransactionLike[];
  innerTxns?: IndexerTransactionLike[];
};

export interface InceptionReviewServiceOptions {
  walletAddress: string;
  indexerUrl: string;
  algodUrl: string;
  indexer?: algosdk.Indexer;
  algod?: algosdk.Algodv2;
}

export class InceptionReviewService {
  private readonly walletAddress: string;
  private readonly indexer: algosdk.Indexer;
  private readonly algod: algosdk.Algodv2;
  private readonly assetCache = new Map<number, AssetMetadata>();

  constructor(
    private readonly store: AccountingStore,
    private readonly canix: Pick<Canix402Client, "getTokenPrices">,
    private readonly accounting: Pick<AccountingService, "recordCashflow">,
    options: InceptionReviewServiceOptions,
  ) {
    this.walletAddress = options.walletAddress;
    this.indexer =
      options.indexer ?? new algosdk.Indexer("", options.indexerUrl, "");
    this.algod = options.algod ?? new algosdk.Algodv2("", options.algodUrl, "");
    this.assetCache.set(ALGO_ASSET_ID, {
      decimals: ALGO_DECIMALS,
      symbol: "ALGO",
    });
  }

  async buildReview(input: {
    minRound?: number;
    asOf?: string;
  }): Promise<InceptionReview> {
    const minRound = input.minRound ?? DEFAULT_INCEPTION_MIN_ROUND;
    const asOf = input.asOf ?? DEFAULT_INCEPTION_AS_OF;
    const txs = await this.listAccountTransactions(minRound);
    const groupHasAppl = buildGroupApplSet(txs);

    const draftRows: Omit<
      InceptionReviewRow,
      "amountUsd" | "symbol" | "decimals" | "amountLabel"
    >[] = [];

    for (const tx of txs) {
      const txid = tx.id;
      if (!txid) {
        continue;
      }
      const confirmed = readConfirmedRound(tx);
      if (confirmed === undefined || confirmed < BigInt(minRound)) {
        continue;
      }
      const txType = readTxType(tx);
      const groupId =
        typeof tx.group === "string" && tx.group.length > 0 ? tx.group : null;

      if (txType !== "pay" && txType !== "axfer") {
        continue;
      }

      try {
        const parsed = parseCashflowTransfer(tx, txid);
        const involvesWallet =
          parsed.sender === this.walletAddress ||
          parsed.receiver === this.walletAddress;
        if (!involvesWallet) {
          continue;
        }

        const direction =
          parsed.receiver === this.walletAddress ? "deposit" : "withdraw";
        const counterparty =
          direction === "deposit" ? parsed.sender : parsed.receiver;

        let classification: InceptionReviewRow["classification"];
        let flagReason: string | undefined;
        if (groupId && groupHasAppl.has(groupId)) {
          classification = "flagged";
          flagReason = "Atomic group includes an application call (appl)";
        } else if (
          parsed.sender === this.walletAddress &&
          parsed.receiver === this.walletAddress
        ) {
          classification = "ignored";
          flagReason = "Self-transfer";
        } else {
          classification =
            direction === "deposit"
              ? "external_deposit"
              : "external_withdrawal";
        }

        draftRows.push({
          transactionId: txid,
          confirmedRound: Number(confirmed),
          occurredAt: occurredAtFromRoundTime(parsed.roundTimeSeconds),
          txType: txType ?? "unknown",
          assetId: parsed.assetId,
          amountRaw: parsed.amountRaw,
          sender: parsed.sender,
          receiver: parsed.receiver,
          counterparty,
          groupId,
          classification,
          flagReason,
        });
      } catch (error) {
        if (
          error instanceof CashflowTxError &&
          /zero|opt-in/i.test(error.message)
        ) {
          draftRows.push({
            transactionId: txid,
            confirmedRound: Number(confirmed),
            occurredAt: occurredAtFromRoundTime(readRoundTime(tx)),
            txType: txType ?? "unknown",
            assetId: 0,
            amountRaw: "0",
            sender: tx.sender ?? "",
            receiver: "",
            counterparty: "",
            groupId,
            classification: "ignored",
            flagReason: error.message,
          });
        }
      }
    }

    const assetIds = [
      ...new Set([
        ALGO_ASSET_ID,
        ...draftRows.map((row) => row.assetId).filter((id) => id > 0),
      ]),
    ];
    const prices =
      assetIds.length === 0 ? [] : await this.canix.getTokenPrices(assetIds);
    const priceByAsset = new Map(prices.map((p) => [p.assetId, p] as const));

    const rows: InceptionReviewRow[] = [];
    for (const draft of draftRows) {
      const meta = await this.ensureAssetMeta(draft.assetId);
      const amountUsd = priceAmountUsd(
        draft.amountRaw,
        meta.decimals,
        priceByAsset.get(draft.assetId),
      );
      rows.push({
        ...draft,
        symbol: meta.symbol,
        decimals: meta.decimals,
        amountLabel: `${formatBaseUnits(draft.amountRaw, meta.decimals)} ${meta.symbol}`,
        amountUsd,
      });
    }

    rows.sort((left, right) => {
      if (left.confirmedRound !== right.confirmedRound) {
        return left.confirmedRound - right.confirmedRound;
      }
      return left.transactionId.localeCompare(right.transactionId);
    });

    let proposedDeposits = money(0);
    let proposedWithdrawals = money(0);
    for (const row of rows) {
      if (row.amountUsd === null) {
        continue;
      }
      if (row.classification === "external_deposit") {
        proposedDeposits = proposedDeposits.plus(money(row.amountUsd));
      } else if (row.classification === "external_withdrawal") {
        proposedWithdrawals = proposedWithdrawals.plus(money(row.amountUsd));
      }
    }

    const proposedInceptionNavUsd = await this.proposeInceptionNav(
      minRound,
      priceByAsset,
    );

    const withoutChecksum = {
      schemaVersion: 1 as const,
      walletAddress: this.walletAddress,
      minRound,
      asOf,
      generatedAt: new Date().toISOString(),
      proposedInceptionNavUsd,
      proposedDepositsUsd: formatUsd(proposedDeposits),
      proposedWithdrawalsUsd: formatUsd(proposedWithdrawals),
      priceNote: PRICE_NOTE,
      rows,
    };

    const review: InceptionReview = {
      ...withoutChecksum,
      checksum: canonicalChecksum(withoutChecksum),
    };
    await this.store.putInceptionReview(review);
    return review;
  }

  async commitReview(input: {
    review: InceptionReview;
    inceptionNavUsd?: string;
    force?: boolean;
  }): Promise<{
    inception: AccountingInception;
    recordedCashflows: number;
    skippedCashflows: number;
  }> {
    const existing = await this.store.getInception(this.walletAddress);
    if (existing && !input.force) {
      throw new Error(
        `Inception already set (asOf ${existing.asOf}, nav ${existing.navUsd}). Pass --force to overwrite.`,
      );
    }

    let recordedCashflows = 0;
    let skippedCashflows = 0;
    for (const row of input.review.rows) {
      const type =
        row.commitAs ??
        (row.classification === "external_deposit" ||
        row.classification === "external_withdrawal"
          ? row.classification
          : undefined);
      if (!type) {
        continue;
      }
      if (row.amountUsd === null) {
        throw new Error(
          `Cannot commit ${row.transactionId}: missing USD amount`,
        );
      }
      const existing = await this.store.getCashflowByEventId(
        this.walletAddress,
        row.transactionId,
      );
      if (existing) {
        skippedCashflows += 1;
        continue;
      }
      await this.accounting.recordCashflow({
        eventId: row.transactionId,
        type,
        amountUsd: row.amountUsd,
        occurredAt: row.occurredAt,
        transactionId: row.transactionId,
        notes: `${row.amountLabel} ${type === "external_deposit" ? "from" : "to"} ${row.counterparty} (inception review)`,
      });
      recordedCashflows += 1;
    }

    const navUsd =
      input.inceptionNavUsd ?? input.review.proposedInceptionNavUsd ?? null;
    if (navUsd === null) {
      throw new Error(
        "No inception NAV available; pass --inception-nav <usd> or ensure account balances at minRound can be priced",
      );
    }

    const inception: AccountingInception = {
      schemaVersion: 1,
      walletAddress: this.walletAddress,
      asOf: input.review.asOf,
      navUsd: formatUsd(money(navUsd)),
      minRound: input.review.minRound,
      recordedAt: new Date().toISOString(),
      reviewChecksum: input.review.checksum,
      notes: [
        PRICE_NOTE,
        `Committed ${recordedCashflows} cashflow(s); skipped ${skippedCashflows} already recorded`,
      ],
    };
    await this.store.putInception(inception);
    return { inception, recordedCashflows, skippedCashflows };
  }

  private async listAccountTransactions(
    minRound: number,
  ): Promise<IndexerTx[]> {
    const collected: IndexerTx[] = [];
    let nextToken: string | undefined;
    do {
      let query = this.indexer
        .lookupAccountTransactions(this.walletAddress)
        .minRound(minRound)
        .limit(1000);
      if (nextToken) {
        query = query.nextToken(nextToken);
      }
      const response = (await query.do()) as {
        transactions?: IndexerTx[];
        "next-token"?: string;
        nextToken?: string;
      };
      for (const tx of response.transactions ?? []) {
        collected.push(tx);
      }
      nextToken = response.nextToken ?? response["next-token"];
    } while (nextToken);
    return collected;
  }

  private async proposeInceptionNav(
    minRound: number,
    priceByAsset: Map<number, AssetPrice>,
  ): Promise<string | null> {
    try {
      const response = (await this.indexer
        .lookupAccountByID(this.walletAddress)
        .round(minRound)
        .do()) as {
        account?: {
          amount?: number | bigint | string;
          assets?: Array<{
            "asset-id"?: number | string;
            assetId?: number | string;
            amount?: number | bigint | string;
          }>;
        };
      };
      const account = response.account;
      if (!account) {
        return null;
      }

      let total = money(0);
      let pricedAny = false;
      const algoRaw = normalizeAmountRaw(account.amount);
      const algoPrice = priceByAsset.get(ALGO_ASSET_ID)?.priceUsd;
      if (algoPrice) {
        total = total.plus(
          money(algoRaw)
            .div(money(10).pow(ALGO_DECIMALS))
            .times(money(algoPrice)),
        );
        pricedAny = true;
      }

      for (const asset of account.assets ?? []) {
        const assetId = normalizeAssetId(asset.assetId ?? asset["asset-id"]);
        const amountRaw = normalizeAmountRaw(asset.amount);
        if (amountRaw === "0") {
          continue;
        }
        const meta = await this.ensureAssetMeta(assetId);
        const priceUsd = priceByAsset.get(assetId)?.priceUsd;
        if (!priceUsd) {
          // Try fetching price for this asset alone
          const prices = await this.canix.getTokenPrices([assetId]);
          const found = prices.find((p) => p.assetId === assetId)?.priceUsd;
          if (!found) {
            continue;
          }
          total = total.plus(
            money(amountRaw)
              .div(money(10).pow(meta.decimals))
              .times(money(found)),
          );
          pricedAny = true;
          continue;
        }
        total = total.plus(
          money(amountRaw)
            .div(money(10).pow(meta.decimals))
            .times(money(priceUsd)),
        );
        pricedAny = true;
      }

      return pricedAny ? formatUsd(total) : null;
    } catch {
      return null;
    }
  }

  private async ensureAssetMeta(assetId: number): Promise<AssetMetadata> {
    const cached = this.assetCache.get(assetId);
    if (cached) {
      return cached;
    }
    if (assetId === ALGO_ASSET_ID) {
      return { decimals: ALGO_DECIMALS, symbol: "ALGO" };
    }
    try {
      const info = (await this.algod.getAssetByID(assetId).do()) as {
        params?: {
          decimals?: number;
          "unit-name"?: string;
          unitName?: string;
          name?: string;
        };
      };
      const decimals = info.params?.decimals;
      if (typeof decimals !== "number" || !Number.isInteger(decimals)) {
        throw new Error("missing decimals");
      }
      const symbol =
        info.params?.unitName?.trim() ||
        info.params?.["unit-name"]?.trim() ||
        info.params?.name?.trim() ||
        `ASA ${assetId}`;
      const meta = { decimals, symbol };
      this.assetCache.set(assetId, meta);
      return meta;
    } catch {
      const fallback = { decimals: 0, symbol: `ASA ${assetId}` };
      this.assetCache.set(assetId, fallback);
      return fallback;
    }
  }
}

function buildGroupApplSet(txs: IndexerTx[]): Set<string> {
  const groupsWithAppl = new Set<string>();
  for (const tx of txs) {
    const groupId =
      typeof tx.group === "string" && tx.group.length > 0 ? tx.group : null;
    if (!groupId) {
      continue;
    }
    if (readTxType(tx) === "appl" || hasInnerAppl(tx)) {
      groupsWithAppl.add(groupId);
    }
  }
  return groupsWithAppl;
}

function hasInnerAppl(tx: IndexerTx): boolean {
  const inners = tx.innerTxns ?? tx["inner-txns"] ?? [];
  for (const inner of inners) {
    if (readTxType(inner) === "appl") {
      return true;
    }
    if (hasInnerAppl(inner)) {
      return true;
    }
  }
  return false;
}

function readTxType(tx: IndexerTransactionLike): string | undefined {
  return tx.txType ?? tx["tx-type"];
}

function readRoundTime(tx: IndexerTransactionLike): number | undefined {
  const value = tx.roundTime ?? tx["round-time"];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function occurredAtFromRoundTime(roundTimeSeconds: number | undefined): string {
  if (
    typeof roundTimeSeconds === "number" &&
    Number.isFinite(roundTimeSeconds) &&
    roundTimeSeconds > 0
  ) {
    return new Date(roundTimeSeconds * 1_000).toISOString();
  }
  return new Date().toISOString();
}

function priceAmountUsd(
  amountRaw: string,
  decimals: number,
  price: AssetPrice | undefined,
): string | null {
  if (!price?.priceUsd) {
    return null;
  }
  try {
    const tokenAmount = money(amountRaw).div(money(10).pow(decimals));
    return formatUsd(tokenAmount.times(money(price.priceUsd)));
  } catch {
    return null;
  }
}

function normalizeAssetId(raw: number | string | bigint | undefined): number {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) {
    return raw;
  }
  if (
    typeof raw === "bigint" &&
    raw >= 0n &&
    raw <= BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return Number(raw);
  }
  if (typeof raw === "string" && /^[0-9]+$/.test(raw)) {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }
  throw new Error("Invalid asset id");
}

function normalizeAmountRaw(
  amount: number | bigint | string | undefined,
): string {
  if (amount === undefined || amount === null) {
    return "0";
  }
  if (typeof amount === "bigint") {
    return amount.toString();
  }
  if (typeof amount === "number") {
    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount < 0) {
      return "0";
    }
    return String(amount);
  }
  if (!/^[0-9]+$/.test(amount)) {
    return "0";
  }
  return amount.replace(/^0+(?=\d)/, "") || "0";
}
