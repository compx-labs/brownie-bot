import {
  mkdir,
  readdir,
  readFile,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative as relativePath } from "node:path";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";

import { reviewRunSchema, type ReviewRun } from "../../domain.js";

/** Dated review files older than this are deleted on write and list. */
export const REVIEW_HISTORY_RETENTION_DAYS = 7;
export const REVIEW_HISTORY_RETENTION_MS =
  REVIEW_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export const DEFAULT_REVIEW_LIST_LIMIT = 50;
export const MAX_REVIEW_LIST_LIMIT = 200;

export interface ReviewRunSummary {
  id: string;
  startedAt: string;
  completedAt: string;
  status: ReviewRun["status"];
  signingEnabled: boolean;
  walletAddress?: string;
  error?: string;
}

export interface ListReviewRunsOptions {
  limit?: number;
  /** Clock injection for rotate + list tests. */
  now?: Date;
}

export interface ReviewRunStore {
  getLatest(walletAddress: string): Promise<ReviewRun | undefined>;
  putLatest(run: ReviewRun, options?: { now?: Date }): Promise<string>;
  list(
    walletAddress: string,
    options?: ListReviewRunsOptions,
  ): Promise<ReviewRunSummary[]>;
  rotate(walletAddress: string, now?: Date): Promise<string[]>;
}

export interface LocalFilesystemReviewRunStoreOptions {
  rootDir: string;
  prefix?: string;
}

export interface SpacesReviewRunStoreOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix?: string;
  client?: S3Client;
}

interface ReviewHistoryIo {
  getJson(key: string): Promise<unknown>;
  listKeys(prefix: string): Promise<string[]>;
  deleteKey(key: string): Promise<void>;
  putJson(key: string, body: ReviewRun): Promise<void>;
}

export class LocalFilesystemReviewRunStore implements ReviewRunStore {
  private readonly rootDir: string;
  private readonly prefix: string;

  constructor(options: LocalFilesystemReviewRunStoreOptions) {
    this.rootDir = options.rootDir;
    this.prefix = trimSlashes(options.prefix ?? "");
  }

  async getLatest(walletAddress: string): Promise<ReviewRun | undefined> {
    return readLatestReview(this.io(), latestKey(this.prefix, walletAddress));
  }

  async putLatest(
    run: ReviewRun,
    options: { now?: Date } = {},
  ): Promise<string> {
    return persistReviewRun(
      this.io(),
      this.prefix,
      run,
      options.now ?? new Date(),
    );
  }

  async list(
    walletAddress: string,
    options: ListReviewRunsOptions = {},
  ): Promise<ReviewRunSummary[]> {
    return listReviewHistory(this.io(), this.prefix, walletAddress, options);
  }

  async rotate(walletAddress: string, now = new Date()): Promise<string[]> {
    return rotateReviewHistory(this.io(), this.prefix, walletAddress, now);
  }

  private io(): ReviewHistoryIo {
    return {
      getJson: (key) => this.getJson(key),
      listKeys: (prefix) => this.listKeys(prefix),
      deleteKey: (key) => this.deleteKey(key),
      putJson: (key, body) => this.putJson(key, body),
    };
  }

  private async putJson(key: string, body: ReviewRun): Promise<void> {
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

  private async deleteKey(key: string): Promise<void> {
    const filePath = this.resolvePath(key);
    try {
      await unlink(filePath);
    } catch (error) {
      if (!isErrnoNotFound(error)) {
        throw error;
      }
    }
    await pruneEmptyDirs(
      dirname(filePath),
      this.resolvePath(
        reviewsPrefix(this.prefix, walletAddressFromReviewKey(key)),
      ),
    );
  }

  private resolvePath(key: string): string {
    return join(
      this.rootDir,
      ...key.split("/").filter((part) => part.length > 0),
    );
  }
}

export class SpacesReviewRunStore implements ReviewRunStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(options: SpacesReviewRunStoreOptions) {
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

  async getLatest(walletAddress: string): Promise<ReviewRun | undefined> {
    return readLatestReview(this.io(), latestKey(this.prefix, walletAddress));
  }

  async putLatest(
    run: ReviewRun,
    options: { now?: Date } = {},
  ): Promise<string> {
    return persistReviewRun(
      this.io(),
      this.prefix,
      run,
      options.now ?? new Date(),
    );
  }

  async list(
    walletAddress: string,
    options: ListReviewRunsOptions = {},
  ): Promise<ReviewRunSummary[]> {
    return listReviewHistory(this.io(), this.prefix, walletAddress, options);
  }

  async rotate(walletAddress: string, now = new Date()): Promise<string[]> {
    return rotateReviewHistory(this.io(), this.prefix, walletAddress, now);
  }

  private io(): ReviewHistoryIo {
    return {
      getJson: (key) => this.getJson(key),
      listKeys: (prefix) => this.listKeys(prefix),
      deleteKey: (key) => this.deleteKey(key),
      putJson: (key, body) => this.putJson(key, body),
    };
  }

  private async putJson(key: string, body: ReviewRun): Promise<void> {
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

  private async deleteKey(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
  }
}

async function readLatestReview(
  io: Pick<ReviewHistoryIo, "getJson">,
  key: string,
): Promise<ReviewRun | undefined> {
  const payload = await io.getJson(key);
  if (payload === undefined) {
    return undefined;
  }
  const parsed = reviewRunSchema.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}

async function persistReviewRun(
  io: ReviewHistoryIo,
  prefix: string,
  run: ReviewRun,
  now: Date,
): Promise<string> {
  const walletAddress = requireWalletAddress(run);
  const dated = datedReviewKey(prefix, walletAddress, run);
  const latest = latestKey(prefix, walletAddress);
  await io.putJson(dated, run);
  await io.putJson(latest, run);
  await rotateReviewHistory(io, prefix, walletAddress, now);
  return latest;
}

async function listReviewHistory(
  io: ReviewHistoryIo,
  prefix: string,
  walletAddress: string,
  options: ListReviewRunsOptions,
): Promise<ReviewRunSummary[]> {
  const now = options.now ?? new Date();
  await rotateReviewHistory(io, prefix, walletAddress, now);
  const limit = clampReviewListLimit(options.limit);
  const keys = await listDatedReviewKeys(io, prefix, walletAddress);
  const summaries: ReviewRunSummary[] = [];
  for (const key of keys) {
    const payload = await io.getJson(key);
    if (payload === undefined) {
      continue;
    }
    const parsed = reviewRunSchema.safeParse(payload);
    if (!parsed.success) {
      continue;
    }
    summaries.push(summarizeReviewRun(parsed.data));
  }
  summaries.sort(compareReviewSummaries);
  return summaries.slice(0, limit);
}

async function rotateReviewHistory(
  io: ReviewHistoryIo,
  prefix: string,
  walletAddress: string,
  now: Date,
): Promise<string[]> {
  const keys = await listDatedReviewKeys(io, prefix, walletAddress);
  const deleted: string[] = [];
  for (const key of keys) {
    if (isExpiredReviewKey(key, now)) {
      await io.deleteKey(key);
      deleted.push(key);
    }
  }
  return deleted;
}

async function listDatedReviewKeys(
  io: Pick<ReviewHistoryIo, "listKeys">,
  prefix: string,
  walletAddress: string,
): Promise<string[]> {
  const keys = await io.listKeys(reviewsPrefix(prefix, walletAddress));
  return keys.filter((key) => isDatedReviewKey(key, prefix, walletAddress));
}

export function datedReviewKey(
  prefix: string,
  walletAddress: string,
  run: Pick<ReviewRun, "id" | "startedAt">,
): string {
  const started = new Date(run.startedAt);
  return joinKey(
    prefix,
    "wallets",
    walletAddress,
    "reviews",
    String(started.getUTCFullYear()),
    pad(started.getUTCMonth() + 1),
    pad(started.getUTCDate()),
    `${safeRunId(run.id)}.json`,
  );
}

export function latestKey(prefix: string, walletAddress: string): string {
  return joinKey(prefix, "wallets", walletAddress, "reviews", "latest.json");
}

export function summarizeReviewRun(run: ReviewRun): ReviewRunSummary {
  return {
    id: run.id,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    status: run.status,
    signingEnabled: run.signingEnabled,
    ...(run.walletAddress ? { walletAddress: run.walletAddress } : {}),
    ...(run.error ? { error: run.error } : {}),
  };
}

export function clampReviewListLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_REVIEW_LIST_LIMIT;
  }
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value) || value < 1) {
    return DEFAULT_REVIEW_LIST_LIMIT;
  }
  return Math.min(Math.floor(value), MAX_REVIEW_LIST_LIMIT);
}

export function isDatedReviewKey(
  key: string,
  prefix: string,
  walletAddress: string,
): boolean {
  const expectedPrefix = `${reviewsPrefix(prefix, walletAddress)}/`;
  if (!key.startsWith(expectedPrefix)) {
    return false;
  }
  return /^\d{4}\/\d{2}\/\d{2}\/[^/]+\.json$/.test(
    key.slice(expectedPrefix.length),
  );
}

export function isExpiredReviewKey(key: string, now: Date): boolean {
  const ms = datedReviewUtcMs(key);
  if (ms === undefined) {
    return false;
  }
  return now.getTime() - ms >= REVIEW_HISTORY_RETENTION_MS;
}

function datedReviewUtcMs(key: string): number | undefined {
  const match = key.match(/\/reviews\/(\d{4})\/(\d{2})\/(\d{2})\//);
  if (!match) {
    return undefined;
  }
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function reviewsPrefix(prefix: string, walletAddress: string): string {
  return joinKey(prefix, "wallets", walletAddress, "reviews");
}

function compareReviewSummaries(
  left: ReviewRunSummary,
  right: ReviewRunSummary,
): number {
  const byStart = right.startedAt.localeCompare(left.startedAt);
  if (byStart !== 0) {
    return byStart;
  }
  const byCompleted = right.completedAt.localeCompare(left.completedAt);
  if (byCompleted !== 0) {
    return byCompleted;
  }
  return right.id.localeCompare(left.id);
}

function requireWalletAddress(run: ReviewRun): string {
  if (!run.walletAddress) {
    throw new Error(
      "ReviewRun.walletAddress is required to persist latest run",
    );
  }
  return run.walletAddress;
}

function safeRunId(id: string): string {
  const safe = id.trim().replace(/[^A-Za-z0-9._-]+/g, "_");
  return safe.length > 0 ? safe : "run";
}

function walletAddressFromReviewKey(key: string): string {
  const match = key.match(/(?:^|\/)wallets\/([^/]+)\/reviews\//);
  return match?.[1] ?? "";
}

function joinKey(...parts: string[]): string {
  return parts
    .map((part) => trimSlashes(part))
    .filter((part) => part.length > 0)
    .join("/");
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function isErrnoNotFound(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
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

async function pruneEmptyDirs(
  startDir: string,
  stopDir: string,
): Promise<void> {
  let dir = startDir;
  while (dir.startsWith(stopDir) && dir !== stopDir) {
    try {
      const entries = await readdir(dir);
      if (entries.length > 0) {
        break;
      }
      await rmdir(dir);
    } catch (error) {
      if (!isErrnoNotFound(error)) {
        break;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
}
