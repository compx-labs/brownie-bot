import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative as relativePath } from "node:path";

import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";

import {
  accountingCashflowSchema,
  accountingInceptionSchema,
  accountingSnapshotSchema,
  accountingSummarySchema,
  inceptionReviewSchema,
  type AccountingCashflow,
  type AccountingInception,
  type AccountingSnapshot,
  type AccountingSummary,
  type InceptionReview,
  type PublicPnl,
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
  /** Fixed public PnL artifact at `{prefix}/public/pnl.json`. */
  putPublicPnl(payload: PublicPnl): Promise<string>;
  getInception(walletAddress: string): Promise<AccountingInception | undefined>;
  putInception(inception: AccountingInception): Promise<string>;
  getInceptionReview(
    walletAddress: string,
  ): Promise<InceptionReview | undefined>;
  putInceptionReview(review: InceptionReview): Promise<string>;
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
  listSnapshotsBetween(
    walletAddress: string,
    fromInclusive: string,
    toInclusive: string,
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

export interface LocalFilesystemAccountingStoreOptions {
  /** Absolute or relative root directory for accounting JSON. */
  rootDir: string;
  prefix?: string;
}

/**
 * File-backed AccountingStore with the same key layout as Spaces.
 * Used when DigitalOcean Spaces is not configured.
 */
export class LocalFilesystemAccountingStore implements AccountingStore {
  private readonly rootDir: string;
  private readonly prefix: string;

  constructor(options: LocalFilesystemAccountingStoreOptions) {
    this.rootDir = options.rootDir;
    this.prefix = trimSlashes(options.prefix ?? "");
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

  async putPublicPnl(payload: PublicPnl): Promise<string> {
    const key = publicPnlKey(this.prefix);
    await this.putMutableJson(key, payload);
    return key;
  }

  async getInception(
    walletAddress: string,
  ): Promise<AccountingInception | undefined> {
    const key = inceptionKey(this.prefix, walletAddress);
    const payload = await this.getJson(key);
    if (payload === undefined) {
      return undefined;
    }
    const parsed = accountingInceptionSchema.safeParse(payload);
    return parsed.success ? parsed.data : undefined;
  }

  async putInception(inception: AccountingInception): Promise<string> {
    const key = inceptionKey(this.prefix, inception.walletAddress);
    await this.putMutableJson(key, inception);
    return key;
  }

  async getInceptionReview(
    walletAddress: string,
  ): Promise<InceptionReview | undefined> {
    const key = inceptionReviewKey(this.prefix, walletAddress);
    const payload = await this.getJson(key);
    if (payload === undefined) {
      return undefined;
    }
    const parsed = inceptionReviewSchema.safeParse(payload);
    return parsed.success ? parsed.data : undefined;
  }

  async putInceptionReview(review: InceptionReview): Promise<string> {
    const key = inceptionReviewKey(this.prefix, review.walletAddress);
    await this.putMutableJson(key, review);
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

  async listSnapshotsBetween(
    walletAddress: string,
    fromInclusive: string,
    toInclusive: string,
  ): Promise<AccountingSnapshot[]> {
    return listSnapshotsBetweenImpl(
      (year, month) => this.listSnapshots(walletAddress, year, month),
      fromInclusive,
      toInclusive,
    );
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
    body:
      | AccountingSnapshot
      | AccountingCashflow
      | AccountingSummary
      | AccountingInception
      | InceptionReview
      | PublicPnl,
  ): Promise<void> {
    const filePath = this.resolvePath(key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(body), "utf8");
  }

  private async getJson(key: string): Promise<unknown> {
    try {
      const text = await readFile(this.resolvePath(key), "utf8");
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (isErrnoNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private async listKeys(prefix: string): Promise<string[]> {
    const directory = this.resolvePath(prefix);
    const keys: string[] = [];
    await walkJsonFiles(directory, (absolutePath) => {
      const relative = relativePath(this.rootDir, absolutePath)
        .split(/[/\\]/)
        .join("/");
      keys.push(relative);
    });
    const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
    return keys.filter(
      (key) => key === prefix || key.startsWith(normalizedPrefix),
    );
  }

  private resolvePath(key: string): string {
    return join(
      this.rootDir,
      ...key.split("/").filter((part) => part.length > 0),
    );
  }
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

  async putPublicPnl(payload: PublicPnl): Promise<string> {
    const key = publicPnlKey(this.prefix);
    await this.putMutableJson(key, payload, {
      acl: "public-read",
      cacheControl: "public, max-age=60",
    });
    return key;
  }

  async getInception(
    walletAddress: string,
  ): Promise<AccountingInception | undefined> {
    const key = inceptionKey(this.prefix, walletAddress);
    const payload = await this.getJson(key);
    if (payload === undefined) {
      return undefined;
    }
    const parsed = accountingInceptionSchema.safeParse(payload);
    return parsed.success ? parsed.data : undefined;
  }

  async putInception(inception: AccountingInception): Promise<string> {
    const key = inceptionKey(this.prefix, inception.walletAddress);
    await this.putMutableJson(key, inception);
    return key;
  }

  async getInceptionReview(
    walletAddress: string,
  ): Promise<InceptionReview | undefined> {
    const key = inceptionReviewKey(this.prefix, walletAddress);
    const payload = await this.getJson(key);
    if (payload === undefined) {
      return undefined;
    }
    const parsed = inceptionReviewSchema.safeParse(payload);
    return parsed.success ? parsed.data : undefined;
  }

  async putInceptionReview(review: InceptionReview): Promise<string> {
    const key = inceptionReviewKey(this.prefix, review.walletAddress);
    await this.putMutableJson(key, review);
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

  async listSnapshotsBetween(
    walletAddress: string,
    fromInclusive: string,
    toInclusive: string,
  ): Promise<AccountingSnapshot[]> {
    return listSnapshotsBetweenImpl(
      (year, month) => this.listSnapshots(walletAddress, year, month),
      fromInclusive,
      toInclusive,
    );
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
    body:
      | AccountingSnapshot
      | AccountingCashflow
      | AccountingSummary
      | AccountingInception
      | InceptionReview
      | PublicPnl,
    options?: { acl?: "public-read"; cacheControl?: string },
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(body),
        ContentType: "application/json",
        CacheControl: options?.cacheControl ?? "no-store",
        ...(options?.acl ? { ACL: options.acl } : {}),
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

function publicPnlKey(prefix: string): string {
  return joinKey(prefix, "public", "pnl.json");
}

function inceptionKey(prefix: string, walletAddress: string): string {
  return joinKey(prefix, "wallets", walletAddress, "state", "inception.json");
}

function inceptionReviewKey(prefix: string, walletAddress: string): string {
  return joinKey(
    prefix,
    "wallets",
    walletAddress,
    "state",
    "inception-review.json",
  );
}

/** Walk year/month buckets between two ISO timestamps and filter by asOf. */
export async function listSnapshotsBetweenImpl(
  listMonth: (
    year: number,
    month: number,
  ) => Promise<AccountingSnapshot[]>,
  fromInclusive: string,
  toInclusive: string,
): Promise<AccountingSnapshot[]> {
  const from = new Date(fromInclusive);
  const to = new Date(toInclusive);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error("Invalid snapshot range timestamps");
  }
  const snapshots: AccountingSnapshot[] = [];
  let year = from.getUTCFullYear();
  let month = from.getUTCMonth() + 1;
  const endYear = to.getUTCFullYear();
  const endMonth = to.getUTCMonth() + 1;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    const monthSnapshots = await listMonth(year, month);
    for (const snapshot of monthSnapshots) {
      const asOf = new Date(snapshot.asOf).getTime();
      if (asOf >= from.getTime() && asOf <= to.getTime()) {
        snapshots.push(snapshot);
      }
    }
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return snapshots.sort((left, right) => left.asOf.localeCompare(right.asOf));
}

/** Greatest snapshot with asOf ≤ target and a known totalValueUsd. */
export function pickSnapshotAtOrBefore(
  snapshots: AccountingSnapshot[],
  targetAsOf: string,
): AccountingSnapshot | undefined {
  const target = new Date(targetAsOf).getTime();
  let best: AccountingSnapshot | undefined;
  for (const snapshot of snapshots) {
    if (snapshot.totalValueUsd === null) {
      continue;
    }
    const asOf = new Date(snapshot.asOf).getTime();
    if (asOf > target) {
      continue;
    }
    if (!best || snapshot.asOf > best.asOf) {
      best = snapshot;
    }
  }
  return best;
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

function isErrnoNotFound(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

async function walkJsonFiles(
  directory: string,
  onFile: (absolutePath: string) => void,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isErrnoNotFound(error)) {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkJsonFiles(absolutePath, onFile);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".json")) {
      const info = await stat(absolutePath);
      if (info.isFile()) {
        onFile(absolutePath);
      }
    }
  }
}
