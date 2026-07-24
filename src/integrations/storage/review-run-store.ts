import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";

import { reviewRunSchema, type ReviewRun } from "../../domain.js";

export interface ReviewRunStore {
  getLatest(walletAddress: string): Promise<ReviewRun | undefined>;
  putLatest(run: ReviewRun): Promise<string>;
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

export class LocalFilesystemReviewRunStore implements ReviewRunStore {
  private readonly rootDir: string;
  private readonly prefix: string;

  constructor(options: LocalFilesystemReviewRunStoreOptions) {
    this.rootDir = options.rootDir;
    this.prefix = trimSlashes(options.prefix ?? "");
  }

  async getLatest(walletAddress: string): Promise<ReviewRun | undefined> {
    const payload = await this.getJson(latestKey(this.prefix, walletAddress));
    if (payload === undefined) {
      return undefined;
    }
    const parsed = reviewRunSchema.safeParse(payload);
    return parsed.success ? parsed.data : undefined;
  }

  async putLatest(run: ReviewRun): Promise<string> {
    const walletAddress = requireWalletAddress(run);
    const key = latestKey(this.prefix, walletAddress);
    const filePath = this.resolvePath(key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(run), "utf8");
    return key;
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
    const payload = await this.getJson(latestKey(this.prefix, walletAddress));
    if (payload === undefined) {
      return undefined;
    }
    const parsed = reviewRunSchema.safeParse(payload);
    return parsed.success ? parsed.data : undefined;
  }

  async putLatest(run: ReviewRun): Promise<string> {
    const walletAddress = requireWalletAddress(run);
    const key = latestKey(this.prefix, walletAddress);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(run),
        ContentType: "application/json",
        CacheControl: "no-store",
      }),
    );
    return key;
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
}

function latestKey(prefix: string, walletAddress: string): string {
  return joinKey(prefix, "wallets", walletAddress, "reviews", "latest.json");
}

function requireWalletAddress(run: ReviewRun): string {
  if (!run.walletAddress) {
    throw new Error(
      "ReviewRun.walletAddress is required to persist latest run",
    );
  }
  return run.walletAddress;
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
