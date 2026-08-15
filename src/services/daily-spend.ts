import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  formatBaseUnits,
  formatMoney,
  money,
  moneyOrNull,
  type Money,
} from "./money.js";

const USDC_DECIMALS = 6;

export interface DailySpendLane {
  usedUsdc: string;
  /** Null when no cap is configured (display as uncapped). */
  capUsdc: string | null;
  /** Null when uncapped. Never negative. */
  remainingUsdc: string | null;
  uncapped: boolean;
}

export interface DailySpendReport {
  dayUtc: string;
  timezone: "UTC";
  canix: DailySpendLane;
  zs: DailySpendLane;
}

interface PersistedDailySpendFile {
  dayUtc: string;
  canixBaseUnits: string;
  zsUsdc: string;
  updatedAt: string;
}

export interface DailySpendStoreOptions {
  rootDir: string;
  walletAddress: string;
  /** Same key prefix convention as local review/accounting stores. */
  prefix?: string;
  /**
   * Canix x402 daily cap in USDC base units. Null or 0 = uncapped (visibility).
   * Enforcement still lives in the payment builder.
   */
  canixCapBaseUnits?: bigint | null;
  /**
   * Inference daily cap in USDC (decimal). Null or 0 = uncapped (visibility).
   * The bot does not enforce this; zs-proxy spend.daily_cap_usdc does.
   */
  zsCapUsdc?: string | number | null;
  /** Test seam; production uses the real clock. Days are UTC calendar dates. */
  now?: () => Date;
}

/**
 * Durable UTC daily Canix x402 + inference spend counters.
 * Visibility only — does not change trading policy.
 */
export class DailySpendStore {
  private dayUtc: string;
  private canixBaseUnits = 0n;
  private zsUsdc: Money = money(0);
  private updatedAt: string | null = null;
  private readonly filePath: string;
  private readonly canixCapBaseUnits: bigint | null;
  private readonly zsCapUsdc: Money | null;
  private readonly clock: () => Date;

  constructor(options: DailySpendStoreOptions) {
    const prefix = trimSlashes(options.prefix ?? "");
    const key = joinKey(
      prefix,
      "wallets",
      options.walletAddress,
      "daily-spend.json",
    );
    this.filePath = join(
      options.rootDir,
      ...key.split("/").filter((part) => part.length > 0),
    );
    this.clock = options.now ?? (() => new Date());
    this.dayUtc = utcDayKey(this.clock());
    this.canixCapBaseUnits = normalizeCapBaseUnits(options.canixCapBaseUnits);
    this.zsCapUsdc = normalizeCapUsdc(options.zsCapUsdc);
  }

  /** Load durable counters on boot. Missing file = zero used today. */
  async hydrate(): Promise<DailySpendReport> {
    try {
      const text = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(text) as PersistedDailySpendFile;
      if (typeof parsed.dayUtc === "string" && parsed.dayUtc.length >= 10) {
        this.dayUtc = parsed.dayUtc.slice(0, 10);
        this.canixBaseUnits = parseBaseUnits(parsed.canixBaseUnits);
        this.zsUsdc = parseUsdc(parsed.zsUsdc);
        this.updatedAt =
          typeof parsed.updatedAt === "string" ? parsed.updatedAt : null;
      }
    } catch (error) {
      if (!isErrnoNotFound(error)) {
        console.error(
          `[daily-spend] Failed to load ${this.filePath}: ${errorMessage(error)}`,
        );
      }
    }
    this.rolloverIfNeeded(this.clock());
    return this.getReport();
  }

  usedCanixBaseUnits(now = this.clock()): bigint {
    this.rolloverIfNeeded(now);
    return this.canixBaseUnits;
  }

  async recordCanix(
    amountBaseUnits: bigint,
    now = this.clock(),
  ): Promise<void> {
    if (amountBaseUnits <= 0n) {
      return;
    }
    this.rolloverIfNeeded(now);
    this.canixBaseUnits += amountBaseUnits;
    this.updatedAt = now.toISOString();
    await this.persist();
  }

  /**
   * Record an inference charge from zs-proxy `X-Zs-*` headers. Invalid / empty
   * amounts are skipped (missing-header fallback — never invent a price).
   */
  async recordZsUsdc(
    amountUsdc: string | undefined,
    now = this.clock(),
  ): Promise<void> {
    const parsed = parseChargeAmount(amountUsdc);
    if (parsed === null) {
      return;
    }
    this.rolloverIfNeeded(now);
    this.zsUsdc = this.zsUsdc.plus(parsed);
    this.updatedAt = now.toISOString();
    await this.persist();
  }

  getReport(now = this.clock()): DailySpendReport {
    this.rolloverIfNeeded(now);
    return {
      dayUtc: this.dayUtc,
      timezone: "UTC",
      canix: toLane(
        baseUnitsToUsdc(this.canixBaseUnits),
        this.canixCapBaseUnits === null
          ? null
          : baseUnitsToUsdc(this.canixCapBaseUnits),
      ),
      zs: toLane(this.zsUsdc, this.zsCapUsdc),
    };
  }

  private rolloverIfNeeded(now: Date): void {
    const today = utcDayKey(now);
    if (today === this.dayUtc) {
      return;
    }
    this.dayUtc = today;
    this.canixBaseUnits = 0n;
    this.zsUsdc = money(0);
    this.updatedAt = now.toISOString();
  }

  private async persist(): Promise<void> {
    const body: PersistedDailySpendFile = {
      dayUtc: this.dayUtc,
      canixBaseUnits: this.canixBaseUnits.toString(),
      zsUsdc: formatMoney(this.zsUsdc),
      updatedAt: this.updatedAt ?? this.clock().toISOString(),
    };
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(
        this.filePath,
        `${JSON.stringify(body, null, 2)}\n`,
        "utf8",
      );
    } catch (error) {
      console.error(
        `[daily-spend] Failed to persist ${this.filePath}: ${errorMessage(error)}`,
      );
    }
  }
}

/** UTC calendar day `YYYY-MM-DD` (same convention as the x402 payment builder). */
export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function formatSpendLaneLine(
  label: string,
  lane: DailySpendLane,
): string {
  const used = `$${lane.usedUsdc} used`;
  const remaining =
    lane.uncapped || lane.remainingUsdc === null
      ? "uncapped"
      : `$${lane.remainingUsdc} remaining`;
  return `${label} today (UTC): ${used}, ${remaining}`;
}

export function formatDailySpendLines(report: DailySpendReport): string[] {
  return [
    formatSpendLaneLine("Canix x402", report.canix),
    formatSpendLaneLine("ZS", report.zs),
  ];
}

function toLane(used: Money, cap: Money | null): DailySpendLane {
  if (cap === null) {
    return {
      usedUsdc: formatMoney(used),
      capUsdc: null,
      remainingUsdc: null,
      uncapped: true,
    };
  }
  const remaining = cap.minus(used);
  return {
    usedUsdc: formatMoney(used),
    capUsdc: formatMoney(cap),
    remainingUsdc: formatMoney(remaining.isNegative() ? money(0) : remaining),
    uncapped: false,
  };
}

function baseUnitsToUsdc(amount: bigint): Money {
  return money(formatBaseUnits(amount.toString(), USDC_DECIMALS));
}

function parseBaseUnits(value: unknown): bigint {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    return 0n;
  }
  return BigInt(value);
}

function parseUsdc(value: unknown): Money {
  if (typeof value !== "string") {
    return money(0);
  }
  const parsed = moneyOrNull(value);
  if (parsed === null || parsed.isNegative()) {
    return money(0);
  }
  return parsed;
}

function parseChargeAmount(amountUsdc: string | undefined): Money | null {
  if (amountUsdc === undefined || amountUsdc.trim() === "") {
    return null;
  }
  try {
    const parsed = moneyOrNull(amountUsdc.trim());
    if (parsed === null || parsed.isNegative() || parsed.isZero()) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function normalizeCapBaseUnits(
  value: bigint | null | undefined,
): bigint | null {
  if (value === undefined || value === null || value <= 0n) {
    return null;
  }
  return value;
}

function normalizeCapUsdc(
  value: string | number | null | undefined,
): Money | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const parsed = moneyOrNull(value);
  if (parsed === null || parsed.isNegative() || parsed.isZero()) {
    return null;
  }
  return parsed;
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
