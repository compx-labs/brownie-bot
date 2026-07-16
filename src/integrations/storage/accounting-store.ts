import { createHash } from "node:crypto";

import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";

import {
  accountingCashflowSchema,
  accountingSnapshotSchema,
  accountingSummarySchema,
  type AccountingCashflow,
  type AccountingSnapshot,
  type AccountingSummary,
} from "../../domain.js";

export interface AccountingStore {
  putSnapshot(snapshot: AccountingSnapshot): Promise<string>;
  putCashflow(cashflow: AccountingCashflow): Promise<string>;
  getLatestSummary(
    walletAddress: string,
  ): Promise<AccountingSummary | undefined>;
  putLatestSummary(summary: AccountingSummary): Promise<string>;
  getMonthlySummary(
    walletAddress: string,
    yearMonth: string,
  ): Promise<AccountingSummary | undefined>;
  putMonthlySummary(
    summary: AccountingSummary,
    yearMonth: string,
  ): Promise<string>;
  listCashflows(
    walletAddress: string,
    fromInclusive: string,
    toExclusive: string,
  ): Promise<AccountingCashflow[]>;
  listSnapshots(
    walletAddress: string,
    year: number,
    month: number,
  ): Promise<AccountingSnapshot[]>;
  getCashflowByEventId(
    walletAddress: string,
    eventId: string,
  ): Promise<AccountingCashflow | undefined>;
}

export interface SpacesAccountingStoreOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix?: string;
  client?: S3Client;
}

export class SpacesAccountingStore implements AccountingStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(options: SpacesAccountingStoreOptions) {
    this.bucket = options.bucket;
    this.prefix = trimSlashes(options.prefix ?? "");
    this.client =
      options.client ??
      new S3Client({
        endpoint: options.endpoint,
        region: options.region,
        forcePathStyle: false,
        credentials: {
          accessKeyId: options.accessKeyId,
          secretAccessKey: options.secretAccessKey,
        },
      } satisfies S3ClientConfig);
  }

  async putSnapshot(snapshot: AccountingSnapshot): Promise<string> {
    const asOf = new Date(snapshot.asOf);
    const key = joinKey(
      this.prefix,
      "wallets",
      snapshot.walletAddress,
      "snapshots",
      String(asOf.getUTCFullYear()),
      pad(asOf.getUTCMonth() + 1),
      pad(asOf.getUTCDate()),
      `${snapshot.id}.json`,
    );
    await this.putImmutableJson(key, snapshot);
    return key;
  }

  async putCashflow(cashflow: AccountingCashflow): Promise<string> {
    const occurredAt = new Date(cashflow.occurredAt);
    const key = joinKey(
      this.prefix,
      "wallets",
      cashflow.walletAddress,
      "cashflows",
      String(occurredAt.getUTCFullYear()),
      pad(occurredAt.getUTCMonth() + 1),
      `${cashflow.eventId}.json`,
    );
    const existing = await this.getJson(key);
    if (existing !== undefined) {
      const parsed = accountingCashflowSchema.parse(existing);
      if (parsed.checksum !== cashflow.checksum) {
        throw new Error(
          `Conflicting cashflow already exists for event ${cashflow.eventId}`,
        );
      }
      return key;
    }
    await this.putImmutableJson(key, cashflow);
    return key;
  }

  async getCashflowByEventId(
    walletAddress: string,
    eventId: string,
  ): Promise<AccountingCashflow | undefined> {
    const prefix = joinKey(this.prefix, "wallets", walletAddress, "cashflows");
    const keys = await this.listKeys(prefix);
    const match = keys.find((key) => key.endsWith(`/${eventId}.json`));
    if (!match) {
      return undefined;
    }
    const payload = await this.getJson(match);
    return payload === undefined
      ? undefined
      : accountingCashflowSchema.parse(payload);
  }

  async getLatestSummary(
    walletAddress: string,
  ): Promise<AccountingSummary | undefined> {
    const key = joinKey(
      this.prefix,
      "wallets",
      walletAddress,
      "state",
      "latest.json",
    );
    const payload = await this.getJson(key);
    if (payload === undefined) {
      return undefined;
    }
    const parsed = accountingSummarySchema.safeParse(payload);
    return parsed.success ? parsed.data : undefined;
  }

  async putLatestSummary(summary: AccountingSummary): Promise<string> {
    const key = joinKey(
      this.prefix,
      "wallets",
      summary.walletAddress,
      "state",
      "latest.json",
    );
    await this.putMutableJson(key, summary);
    return key;
  }

  async getMonthlySummary(
    walletAddress: string,
    yearMonth: string,
  ): Promise<AccountingSummary | undefined> {
    const key = joinKey(
      this.prefix,
      "wallets",
      walletAddress,
      "state",
      "monthly",
      `${yearMonth}.json`,
    );
    const payload = await this.getJson(key);
    if (payload === undefined) {
      return undefined;
    }
    const parsed = accountingSummarySchema.safeParse(payload);
    return parsed.success ? parsed.data : undefined;
  }

  async putMonthlySummary(
    summary: AccountingSummary,
    yearMonth: string,
  ): Promise<string> {
    const key = joinKey(
      this.prefix,
      "wallets",
      summary.walletAddress,
      "state",
      "monthly",
      `${yearMonth}.json`,
    );
    await this.putMutableJson(key, summary);
    return key;
  }

  async listCashflows(
    walletAddress: string,
    fromInclusive: string,
    toExclusive: string,
  ): Promise<AccountingCashflow[]> {
    const prefix = joinKey(this.prefix, "wallets", walletAddress, "cashflows");
    const keys = await this.listKeys(prefix);
    const from = new Date(fromInclusive).getTime();
    const to = new Date(toExclusive).getTime();
    const cashflows: AccountingCashflow[] = [];
    for (const key of keys) {
      const payload = await this.getJson(key);
      if (payload === undefined) {
        continue;
      }
      const cashflow = accountingCashflowSchema.parse(payload);
      const occurred = new Date(cashflow.occurredAt).getTime();
      if (occurred >= from && occurred < to) {
        cashflows.push(cashflow);
      }
    }
    return cashflows.sort((left, right) =>
      left.occurredAt.localeCompare(right.occurredAt),
    );
  }

  async listSnapshots(
    walletAddress: string,
    year: number,
    month: number,
  ): Promise<AccountingSnapshot[]> {
    const prefix = joinKey(
      this.prefix,
      "wallets",
      walletAddress,
      "snapshots",
      String(year),
      pad(month),
    );
    const keys = await this.listKeys(prefix);
    const snapshots: AccountingSnapshot[] = [];
    for (const key of keys) {
      const payload = await this.getJson(key);
      if (payload === undefined) {
        continue;
      }
      const parsed = accountingSnapshotSchema.safeParse(payload);
      if (parsed.success) {
        snapshots.push(parsed.data);
      }
    }
    return snapshots.sort((left, right) => left.asOf.localeCompare(right.asOf));
  }

  private async putImmutableJson(
    key: string,
    body: AccountingSnapshot | AccountingCashflow,
  ): Promise<void> {
    const existing = await this.getJson(key);
    if (existing !== undefined) {
      throw new Error(`Immutable accounting object already exists at ${key}`);
    }
    await this.putMutableJson(key, body);
  }

  private async putMutableJson(
    key: string,
    body: AccountingSnapshot | AccountingCashflow | AccountingSummary,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(body),
        ContentType: "application/json",
        CacheControl: "no-store",
      }),
    );
  }

  private async getJson(key: string): Promise<unknown> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      const text = await response.Body?.transformToString();
      if (!text) {
        return undefined;
      }
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix.endsWith("/") ? prefix : `${prefix}/`,
          ContinuationToken: continuationToken,
        }),
      );
      for (const item of response.Contents ?? []) {
        if (item.Key) {
          keys.push(item.Key);
        }
      }
      continuationToken = response.IsTruncated
        ? response.NextContinuationToken
        : undefined;
    } while (continuationToken);
    return keys;
  }
}

export function canonicalChecksum(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (key === "checksum") {
        continue;
      }
      sorted[key] = sortValue(record[key]);
    }
    return sorted;
  }
  return value;
}

function joinKey(...parts: string[]): string {
  return parts
    .map(trimSlashes)
    .filter((part) => part.length > 0)
    .join("/");
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as Record<string, unknown>;
  return (
    record.name === "NoSuchKey" ||
    record.Code === "NoSuchKey" ||
    (record.$metadata !== undefined &&
      typeof record.$metadata === "object" &&
      (record.$metadata as { httpStatusCode?: number }).httpStatusCode === 404)
  );
}
