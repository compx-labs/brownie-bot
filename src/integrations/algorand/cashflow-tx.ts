import algosdk from "algosdk";

const ALGO_ASSET_ID = 0;
const ALGO_DECIMALS = 6;

export type CashflowTxDirection = "deposit" | "withdraw";

export interface ResolvedCashflowTransfer {
  transactionId: string;
  assetId: number;
  amountRaw: string;
  decimals: number;
  symbol: string;
  occurredAt: string;
  counterparty: string;
  sender: string;
  receiver: string;
}

export class CashflowTxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CashflowTxError";
  }
}

interface IndexerPaymentTxn {
  amount?: number | bigint | string;
  receiver?: string;
}

interface IndexerAssetTransferTxn {
  amount?: number | bigint | string;
  receiver?: string;
  /** REST kebab-case */
  "asset-id"?: number | string;
  /** algosdk v3 camelCase (may be stringified bigint) */
  assetId?: number | string | bigint;
}

/**
 * Minimal indexer transaction shape. algosdk v3 returns camelCase; raw REST
 * uses kebab-case — parsers accept both.
 */
export interface IndexerTransactionLike {
  id?: string;
  sender?: string;
  "tx-type"?: string;
  txType?: string;
  "round-time"?: number;
  roundTime?: number;
  "confirmed-round"?: number | bigint | string;
  confirmedRound?: number | bigint | string;
  "payment-transaction"?: IndexerPaymentTxn;
  paymentTransaction?: IndexerPaymentTxn;
  "asset-transfer-transaction"?: IndexerAssetTransferTxn;
  assetTransferTransaction?: IndexerAssetTransferTxn;
}

export interface IndexerLookupResponse {
  transaction?: IndexerTransactionLike;
}

export interface ParsedCashflowTransfer {
  transactionId: string;
  assetId: number;
  amountRaw: string;
  sender: string;
  receiver: string;
  roundTimeSeconds?: number;
}

export interface AssetMetadata {
  decimals: number;
  symbol: string;
}

/**
 * Infer a single ALGO payment or ASA transfer from an indexer transaction.
 * Does not validate wallet direction — callers apply deposit/withdraw checks.
 */
export function parseCashflowTransfer(
  tx: IndexerTransactionLike,
  transactionId: string,
): ParsedCashflowTransfer {
  const txType = readTxType(tx);
  const sender = tx.sender;
  if (!sender) {
    throw new CashflowTxError("Transaction is missing a sender");
  }

  if (txType === "pay") {
    const payment = tx.paymentTransaction ?? tx["payment-transaction"];
    if (!payment?.receiver) {
      throw new CashflowTxError("Payment transaction is missing a receiver");
    }
    const amountRaw = normalizeAmountRaw(payment.amount);
    if (amountRaw === "0") {
      throw new CashflowTxError("Payment amount is zero");
    }
    return {
      transactionId,
      assetId: ALGO_ASSET_ID,
      amountRaw,
      sender,
      receiver: payment.receiver,
      roundTimeSeconds: readRoundTime(tx),
    };
  }

  if (txType === "axfer") {
    const transfer =
      tx.assetTransferTransaction ?? tx["asset-transfer-transaction"];
    if (!transfer?.receiver) {
      throw new CashflowTxError("Asset transfer is missing a receiver");
    }
    const assetId = normalizeAssetId(transfer.assetId ?? transfer["asset-id"]);
    const amountRaw = normalizeAmountRaw(transfer.amount);
    if (amountRaw === "0") {
      throw new CashflowTxError(
        "Asset transfer amount is zero (opt-in/close-only transfers are not cashflows)",
      );
    }
    return {
      transactionId,
      assetId,
      amountRaw,
      sender,
      receiver: transfer.receiver,
      roundTimeSeconds: readRoundTime(tx),
    };
  }

  throw new CashflowTxError(
    `Unsupported transaction type ${JSON.stringify(txType)}; paste a payment (pay) or ASA transfer (axfer) txid`,
  );
}

export function assertCashflowDirection(
  transfer: Pick<ParsedCashflowTransfer, "sender" | "receiver">,
  walletAddress: string,
  direction: CashflowTxDirection,
): void {
  if (direction === "deposit") {
    if (transfer.receiver !== walletAddress) {
      throw new CashflowTxError(
        `Deposit requires ${walletAddress} as receiver; this tx pays ${transfer.receiver}`,
      );
    }
    return;
  }
  if (transfer.sender !== walletAddress) {
    throw new CashflowTxError(
      `Withdraw requires ${walletAddress} as sender; this tx is from ${transfer.sender}`,
    );
  }
}

export function readConfirmedRound(
  tx: IndexerTransactionLike,
): bigint | undefined {
  const raw = tx.confirmedRound ?? tx["confirmed-round"];
  if (raw === undefined || raw === null) {
    return undefined;
  }
  try {
    return BigInt(raw);
  } catch {
    return undefined;
  }
}

export interface CashflowTxResolverOptions {
  indexerUrl: string;
  algodUrl: string;
  walletAddress: string;
  indexer?: Pick<algosdk.Indexer, "lookupTransactionByID">;
  algod?: Pick<algosdk.Algodv2, "getAssetByID">;
}

export class CashflowTxResolver {
  private readonly indexer: Pick<algosdk.Indexer, "lookupTransactionByID">;
  private readonly algod: Pick<algosdk.Algodv2, "getAssetByID">;
  private readonly walletAddress: string;
  private readonly assetCache = new Map<number, AssetMetadata>();

  constructor(options: CashflowTxResolverOptions) {
    this.walletAddress = options.walletAddress;
    this.indexer =
      options.indexer ?? new algosdk.Indexer("", options.indexerUrl, "");
    this.algod = options.algod ?? new algosdk.Algodv2("", options.algodUrl, "");
    this.assetCache.set(ALGO_ASSET_ID, {
      decimals: ALGO_DECIMALS,
      symbol: "ALGO",
    });
  }

  async resolve(
    transactionId: string,
    direction: CashflowTxDirection,
  ): Promise<ResolvedCashflowTransfer> {
    const txid = transactionId.trim();
    if (!txid) {
      throw new CashflowTxError("Transaction id is required");
    }

    let response: IndexerLookupResponse;
    try {
      response = await this.indexer.lookupTransactionByID(txid).do();
    } catch (error) {
      throw new CashflowTxError(
        `Could not look up transaction ${txid}: ${errorMessage(error)}`,
      );
    }

    const tx = response.transaction;
    if (!tx) {
      throw new CashflowTxError(`Transaction ${txid} was not found`);
    }
    const confirmed = readConfirmedRound(tx);
    if (confirmed === undefined || confirmed === 0n) {
      throw new CashflowTxError(`Transaction ${txid} is not confirmed yet`);
    }

    const parsed = parseCashflowTransfer(tx, txid);
    assertCashflowDirection(parsed, this.walletAddress, direction);
    const meta = await this.ensureAssetMeta(parsed.assetId);

    return {
      transactionId: parsed.transactionId,
      assetId: parsed.assetId,
      amountRaw: parsed.amountRaw,
      decimals: meta.decimals,
      symbol: meta.symbol,
      sender: parsed.sender,
      receiver: parsed.receiver,
      counterparty: direction === "deposit" ? parsed.sender : parsed.receiver,
      occurredAt: occurredAtFromRoundTime(parsed.roundTimeSeconds),
    };
  }

  private async ensureAssetMeta(assetId: number): Promise<AssetMetadata> {
    const cached = this.assetCache.get(assetId);
    if (cached) {
      return cached;
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
    } catch (error) {
      throw new CashflowTxError(
        `Could not load asset ${assetId} metadata: ${errorMessage(error)}`,
      );
    }
  }
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
  throw new CashflowTxError("Asset transfer is missing a valid asset id");
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
      throw new CashflowTxError(`Invalid transfer amount: ${amount}`);
    }
    return String(amount);
  }
  if (!/^[0-9]+$/.test(amount)) {
    throw new CashflowTxError(`Invalid transfer amount: ${amount}`);
  }
  return amount.replace(/^0+(?=\d)/, "") || "0";
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
