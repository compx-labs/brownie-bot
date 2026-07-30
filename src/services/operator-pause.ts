import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type OperatorPauseSource = "telegram" | "boot";

export interface OperatorPauseState {
  paused: boolean;
  updatedAt: string | null;
  source: OperatorPauseSource | null;
}

interface PersistedPauseFile {
  paused: boolean;
  updatedAt: string;
  source?: OperatorPauseSource;
}

export interface OperatorPauseStoreOptions {
  rootDir: string;
  walletAddress: string;
  /** Same key prefix convention as local review/accounting stores. */
  prefix?: string;
}

/**
 * Runtime trading kill-switch: when paused, treasury reviews stay plan-only.
 * Durable under ACCOUNTING_DATA_DIR so container restarts do not silently resume.
 */
export class OperatorPauseStore {
  private paused = false;
  private updatedAt: string | null = null;
  private source: OperatorPauseSource | null = null;
  private readonly filePath: string;

  constructor(options: OperatorPauseStoreOptions) {
    const prefix = trimSlashes(options.prefix ?? "");
    const key = joinKey(
      prefix,
      "wallets",
      options.walletAddress,
      "operator-pause.json",
    );
    this.filePath = join(
      options.rootDir,
      ...key.split("/").filter((part) => part.length > 0),
    );
  }

  isPaused(): boolean {
    return this.paused;
  }

  getState(): OperatorPauseState {
    return {
      paused: this.paused,
      updatedAt: this.updatedAt,
      source: this.source,
    };
  }

  /** Load durable state on boot. Missing file = not paused. */
  async hydrate(): Promise<OperatorPauseState> {
    try {
      const text = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(text) as PersistedPauseFile;
      if (typeof parsed.paused === "boolean") {
        this.paused = parsed.paused;
        this.updatedAt =
          typeof parsed.updatedAt === "string" ? parsed.updatedAt : null;
        this.source = parsed.source ?? "boot";
      }
    } catch (error) {
      if (!isErrnoNotFound(error)) {
        console.error(
          `[operator-pause] Failed to load ${this.filePath}: ${errorMessage(error)}`,
        );
      }
    }
    return this.getState();
  }

  async pause(source: OperatorPauseSource = "telegram"): Promise<OperatorPauseState> {
    this.paused = true;
    this.updatedAt = new Date().toISOString();
    this.source = source;
    await this.persist();
    return this.getState();
  }

  async resume(
    source: OperatorPauseSource = "telegram",
  ): Promise<OperatorPauseState> {
    this.paused = false;
    this.updatedAt = new Date().toISOString();
    this.source = source;
    await this.persist();
    return this.getState();
  }

  private async persist(): Promise<void> {
    const body: PersistedPauseFile = {
      paused: this.paused,
      updatedAt: this.updatedAt ?? new Date().toISOString(),
      ...(this.source ? { source: this.source } : {}),
    };
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    } catch (error) {
      console.error(
        `[operator-pause] Failed to persist ${this.filePath}: ${errorMessage(error)}`,
      );
    }
  }
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
