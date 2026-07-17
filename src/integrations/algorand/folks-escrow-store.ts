import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { z } from "zod";

const escrowRecordSchema = z.object({
  walletAddress: z.string().min(1),
  poolAppId: z.number().int().positive(),
  depositsAppId: z.number().int().positive().optional(),
  escrowAddress: z.string().min(58).max(58),
  escrowPrivateKeyBase64: z.string().min(1),
  updatedAt: z.iso.datetime(),
});

export type FolksEscrowRecord = z.infer<typeof escrowRecordSchema>;

export interface FolksEscrowStore {
  get(
    walletAddress: string,
    poolAppId: number,
  ): Promise<FolksEscrowRecord | undefined>;
  save(record: Omit<FolksEscrowRecord, "updatedAt">): Promise<FolksEscrowRecord>;
}

export class LocalFolksEscrowStore implements FolksEscrowStore {
  constructor(private readonly rootDir: string) {}

  async get(
    walletAddress: string,
    poolAppId: number,
  ): Promise<FolksEscrowRecord | undefined> {
    try {
      const raw = await readFile(this.filePath(walletAddress, poolAppId), "utf8");
      return escrowRecordSchema.parse(JSON.parse(raw));
    } catch (error) {
      if (isErrnoNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async save(
    record: Omit<FolksEscrowRecord, "updatedAt">,
  ): Promise<FolksEscrowRecord> {
    const stored: FolksEscrowRecord = {
      ...record,
      updatedAt: new Date().toISOString(),
    };
    escrowRecordSchema.parse(stored);
    await mkdir(this.rootDir, { recursive: true });
    await writeFile(
      this.filePath(record.walletAddress, record.poolAppId),
      `${JSON.stringify(stored, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    return stored;
  }

  private filePath(walletAddress: string, poolAppId: number): string {
    const safeWallet = walletAddress.replace(/[^A-Z0-9]/gi, "_");
    return path.join(this.rootDir, `${safeWallet}-${poolAppId}.json`);
  }
}

export interface SpacesFolksEscrowStoreOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix?: string;
  client?: S3Client;
}

/** Durable Folks escrow records in DigitalOcean Spaces (same bucket/prefix as accounting). */
export class SpacesFolksEscrowStore implements FolksEscrowStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(options: SpacesFolksEscrowStoreOptions) {
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

  async get(
    walletAddress: string,
    poolAppId: number,
  ): Promise<FolksEscrowRecord | undefined> {
    const payload = await this.getJson(this.objectKey(walletAddress, poolAppId));
    if (payload === undefined) {
      return undefined;
    }
    return escrowRecordSchema.parse(payload);
  }

  async save(
    record: Omit<FolksEscrowRecord, "updatedAt">,
  ): Promise<FolksEscrowRecord> {
    const stored: FolksEscrowRecord = {
      ...record,
      updatedAt: new Date().toISOString(),
    };
    escrowRecordSchema.parse(stored);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.objectKey(record.walletAddress, record.poolAppId),
        Body: JSON.stringify(stored),
        ContentType: "application/json",
        CacheControl: "no-store",
      }),
    );
    return stored;
  }

  private objectKey(walletAddress: string, poolAppId: number): string {
    return joinKey(
      this.prefix,
      "wallets",
      walletAddress,
      "folks-escrows",
      `${poolAppId}.json`,
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
      if (isS3NotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }
}

export class MemoryFolksEscrowStore implements FolksEscrowStore {
  private readonly records = new Map<string, FolksEscrowRecord>();

  async get(
    walletAddress: string,
    poolAppId: number,
  ): Promise<FolksEscrowRecord | undefined> {
    return this.records.get(key(walletAddress, poolAppId));
  }

  async save(
    record: Omit<FolksEscrowRecord, "updatedAt">,
  ): Promise<FolksEscrowRecord> {
    const stored: FolksEscrowRecord = {
      ...record,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(key(record.walletAddress, record.poolAppId), stored);
    return stored;
  }
}

function key(walletAddress: string, poolAppId: number): string {
  return `${walletAddress}:${poolAppId}`;
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

function isErrnoNotFound(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT",
  );
}

function isS3NotFound(error: unknown): boolean {
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
