import type { AccountingRun, ReviewRun } from "../domain.js";
import type { DailySpendReport } from "./daily-spend.js";
import { formatBaseUnits, money } from "./money.js";
import { sanitizeErrorMessage, sanitizeErrorText } from "../util/errors.js";

const DEFAULT_STALE_REVIEW_HOURS = 36;
const DEFAULT_STALE_ACCOUNTING_HOURS = 36;
const DEFAULT_DEP_TIMEOUT_MS = 2_500;
const ALGO_DECIMALS = 6;
const USDC_DECIMALS = 6;
/** Mainnet USDC ASA used for Canix x402 and zs-proxy spend. */
export const HEALTH_USDC_ASSET_ID = 31_566_704;

export type HealthStatus = "ok" | "degraded";

export interface HealthDependencyCheck {
  ok: boolean;
  latencyMs: number | null;
  error?: string;
}

export interface HealthRunSummary {
  id: string;
  status: string;
  completedAt: string;
  ageSeconds: number | null;
  failed: boolean;
  error?: string;
}

export interface HealthWalletFloors {
  /** Token units (ALGO). `0` disables the ALGO floor. */
  algo: number;
  /** Token units (USDC). `0` disables the USDC floor. */
  usdc: number;
}

export interface HealthWalletBalances {
  ok: boolean;
  latencyMs: number | null;
  error?: string;
  /** Spendable ALGO in token units (amount − min-balance). */
  algoSpendable: string;
  /** USDC holding in token units (`0` when not opted in). */
  usdc: string;
  usdcOptedIn: boolean;
  usdcFrozen: boolean;
  floors: {
    algo: string;
    usdc: string;
  };
}

export interface HealthReport {
  status: HealthStatus;
  mode: "autonomous";
  signingEnabled: boolean;
  paused: boolean;
  walletConfigured: boolean;
  telegramConfigured: boolean;
  accountingEnabled: boolean;
  accountingStorage: "spaces" | "local";
  folksEscrowStorage: "spaces" | "local";
  busy: boolean;
  latestReview: HealthRunSummary | null;
  latestAccounting: HealthRunSummary | null;
  /** UTC daily Canix x402 + zs-proxy used/remaining (visibility only). */
  spend?: DailySpendReport;
  deps?: {
    zsProxy: HealthDependencyCheck;
    algod: HealthDependencyCheck;
    canix: HealthDependencyCheck;
  };
  /** Live Algod wallet balances vs floors (`?deps=1` / Telegram `/status`). */
  wallet?: HealthWalletBalances;
  warnings: string[];
}

export interface BuildHealthReportInput {
  signingEnabled: boolean;
  paused?: boolean;
  telegramConfigured: boolean;
  accountingStorage: "spaces" | "local";
  folksEscrowStorage: "spaces" | "local";
  busy: boolean;
  latestReview?: ReviewRun;
  latestAccounting?: AccountingRun;
  spend?: DailySpendReport;
  deps?: HealthReport["deps"];
  wallet?: HealthWalletBalances;
  now?: Date;
  staleReviewHours?: number;
  staleAccountingHours?: number;
}

export function buildHealthReport(input: BuildHealthReportInput): HealthReport {
  const now = input.now ?? new Date();
  const staleReviewHours = input.staleReviewHours ?? DEFAULT_STALE_REVIEW_HOURS;
  const staleAccountingHours =
    input.staleAccountingHours ?? DEFAULT_STALE_ACCOUNTING_HOURS;
  const paused = input.paused ?? false;
  const warnings: string[] = [];

  if (paused) {
    warnings.push("Trading paused (plan-only)");
  }

  const latestReview = summarizeReview(input.latestReview, now);
  const latestAccounting = summarizeAccounting(input.latestAccounting, now);

  if (!latestReview) {
    warnings.push("No treasury review has completed yet");
  } else {
    if (latestReview.failed) {
      warnings.push(
        latestReview.error
          ? `Latest review failed: ${latestReview.error}`
          : "Latest review failed",
      );
    }
    if (
      latestReview.ageSeconds !== null &&
      latestReview.ageSeconds > staleReviewHours * 3_600
    ) {
      warnings.push(
        `Latest review is stale (${formatAge(latestReview.ageSeconds)}; threshold ${staleReviewHours}h)`,
      );
    }
  }

  if (latestAccounting?.failed) {
    warnings.push(
      latestAccounting.error
        ? `Latest accounting failed: ${latestAccounting.error}`
        : "Latest accounting failed",
    );
  } else if (
    latestAccounting?.ageSeconds !== null &&
    latestAccounting !== null &&
    latestAccounting.ageSeconds > staleAccountingHours * 3_600
  ) {
    warnings.push(
      `Latest accounting is stale (${formatAge(latestAccounting.ageSeconds)}; threshold ${staleAccountingHours}h)`,
    );
  }

  if (input.deps) {
    if (!input.deps.zsProxy.ok) {
      warnings.push(
        input.deps.zsProxy.error
          ? `ZeroSignal proxy unreachable: ${input.deps.zsProxy.error}`
          : "ZeroSignal proxy unreachable",
      );
    }
    if (!input.deps.algod.ok) {
      warnings.push(
        input.deps.algod.error
          ? `Algod unreachable: ${input.deps.algod.error}`
          : "Algod unreachable",
      );
    }
    if (!input.deps.canix.ok) {
      warnings.push(
        input.deps.canix.error
          ? `Canix unreachable: ${input.deps.canix.error}`
          : "Canix unreachable",
      );
    }
  }

  if (input.wallet) {
    const algodDown = input.deps?.algod.ok === false;
    warnings.push(
      ...walletBalanceWarnings(input.wallet, { skipProbeFailure: algodDown }),
    );
  }

  const status: HealthStatus = warnings.length > 0 ? "degraded" : "ok";

  return {
    status,
    mode: "autonomous",
    signingEnabled: input.signingEnabled,
    paused,
    walletConfigured: true,
    telegramConfigured: input.telegramConfigured,
    accountingEnabled: true,
    accountingStorage: input.accountingStorage,
    folksEscrowStorage: input.folksEscrowStorage,
    busy: input.busy,
    latestReview,
    latestAccounting,
    ...(input.spend ? { spend: input.spend } : {}),
    ...(input.deps ? { deps: input.deps } : {}),
    ...(input.wallet ? { wallet: input.wallet } : {}),
    warnings,
  };
}

/** True when at least one floor is enabled (skip the extra Algod account call otherwise). */
export function shouldProbeWalletBalances(floors: HealthWalletFloors): boolean {
  return floors.algo > 0 || floors.usdc > 0;
}

export function formatWalletFloor(value: number): string {
  return money(value).toFixed();
}

/**
 * Advisory low-balance messages. Does not pause trading.
 * Probe failures are omitted when `skipProbeFailure` is set (Algod already flagged).
 */
export function walletBalanceWarnings(
  wallet: HealthWalletBalances,
  options?: { skipProbeFailure?: boolean },
): string[] {
  if (!wallet.ok) {
    if (options?.skipProbeFailure) {
      return [];
    }
    return [
      wallet.error
        ? `Wallet balance check failed: ${wallet.error}`
        : "Wallet balance check failed",
    ];
  }

  const warnings: string[] = [];
  const algoFloor = money(wallet.floors.algo);
  const usdcFloor = money(wallet.floors.usdc);

  if (algoFloor.gt(0) && money(wallet.algoSpendable).lt(algoFloor)) {
    warnings.push(
      `Low ALGO: ${wallet.algoSpendable} spendable (floor ${wallet.floors.algo})`,
    );
  }

  if (usdcFloor.gt(0)) {
    if (!wallet.usdcOptedIn) {
      warnings.push(
        `USDC ASA ${HEALTH_USDC_ASSET_ID} not opted in (floor ${wallet.floors.usdc})`,
      );
    } else if (wallet.usdcFrozen) {
      warnings.push("USDC is frozen (cannot spend)");
    } else if (money(wallet.usdc).lt(usdcFloor)) {
      warnings.push(`Low USDC: ${wallet.usdc} (floor ${wallet.floors.usdc})`);
    }
  }

  return warnings;
}

export function zsProxyHealthzUrl(openaiBaseUrl: string): string {
  const url = new URL(openaiBaseUrl);
  const trimmedPath = url.pathname.replace(/\/+$/, "");
  url.pathname = trimmedPath.replace(/\/v1$/, "") || "/";
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  url.pathname = `${url.pathname}healthz`.replace(/\/{2,}/g, "/");
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function algodHealthUrl(algodUrl: string): string {
  const url = new URL(algodUrl);
  const trimmedPath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${trimmedPath}/health`.replace(/\/{2,}/g, "/");
  if (!url.pathname.startsWith("/")) {
    url.pathname = `/${url.pathname}`;
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function algodAccountUrl(algodUrl: string, address: string): string {
  const url = new URL(algodUrl);
  const trimmedPath = url.pathname.replace(/\/+$/, "");
  const encoded = encodeURIComponent(address);
  url.pathname = `${trimmedPath}/v2/accounts/${encoded}`.replace(
    /\/{2,}/g,
    "/",
  );
  if (!url.pathname.startsWith("/")) {
    url.pathname = `/${url.pathname}`;
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function probeWalletBalances(
  algodUrl: string,
  address: string,
  options: {
    floors: HealthWalletFloors;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  },
): Promise<HealthWalletBalances> {
  const floors = {
    algo: formatWalletFloor(options.floors.algo),
    usdc: formatWalletFloor(options.floors.usdc),
  };
  const timeoutMs = options.timeoutMs ?? DEFAULT_DEP_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(algodAccountUrl(algodUrl, address), {
      method: "GET",
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      const body = await readBodyPreview(response);
      return {
        ok: false,
        latencyMs,
        error: sanitizeErrorText(
          body ? `HTTP ${response.status} ${body}` : `HTTP ${response.status}`,
          { maxLength: 160, status: response.status },
        ),
        algoSpendable: "0",
        usdc: "0",
        usdcOptedIn: false,
        usdcFrozen: false,
        floors,
      };
    }
    const payload = (await response.json()) as AlgodAccountResponse;
    return {
      ok: true,
      latencyMs,
      ...parseAccountBalances(payload),
      floors,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: sanitizeErrorMessage(error, { maxLength: 160 }),
      algoSpendable: "0",
      usdc: "0",
      usdcOptedIn: false,
      usdcFrozen: false,
      floors,
    };
  } finally {
    clearTimeout(timer);
  }
}

interface AlgodAccountResponse {
  amount?: number | string;
  "min-balance"?: number | string;
  assets?: Array<{
    "asset-id"?: number | string;
    amount?: number | string;
    "is-frozen"?: boolean;
  }>;
}

function parseAccountBalances(
  payload: AlgodAccountResponse,
): Pick<
  HealthWalletBalances,
  "algoSpendable" | "usdc" | "usdcOptedIn" | "usdcFrozen"
> {
  const amount = asBigInt(payload.amount);
  const minimum = asBigInt(payload["min-balance"]);
  const spendable = amount > minimum ? amount - minimum : 0n;
  const holding = (payload.assets ?? []).find(
    (asset) => asBigInt(asset["asset-id"]) === BigInt(HEALTH_USDC_ASSET_ID),
  );
  const usdcOptedIn = holding !== undefined;
  const usdcFrozen = holding?.["is-frozen"] === true;
  const usdcRaw =
    holding !== undefined && !usdcFrozen ? asBigInt(holding.amount) : 0n;
  return {
    algoSpendable: formatBaseUnits(spendable.toString(), ALGO_DECIMALS),
    usdc: formatBaseUnits(usdcRaw.toString(), USDC_DECIMALS),
    usdcOptedIn,
    usdcFrozen,
  };
}

function asBigInt(value: unknown): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  return 0n;
}

async function readBodyPreview(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.trim().slice(0, 400);
  } catch {
    return "";
  }
}

export async function probeHttpDependency(
  url: string,
  options?: { timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<HealthDependencyCheck> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_DEP_TIMEOUT_MS;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      return {
        ok: false,
        latencyMs,
        error: `HTTP ${response.status}`,
      };
    }
    return { ok: true, latencyMs };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: sanitizeErrorMessage(error, { maxLength: 160 }),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeCanixDependency(
  check: () => Promise<unknown>,
  options?: { timeoutMs?: number },
): Promise<HealthDependencyCheck> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_DEP_TIMEOUT_MS;
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      check(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: sanitizeErrorMessage(error, { maxLength: 160 }),
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function summarizeReview(
  run: ReviewRun | undefined,
  now: Date,
): HealthRunSummary | null {
  if (!run) {
    return null;
  }
  return {
    id: run.id,
    status: run.status,
    completedAt: run.completedAt,
    ageSeconds: ageSeconds(run.completedAt, now),
    failed: run.status === "failed",
    ...(run.error
      ? { error: sanitizeErrorText(run.error, { maxLength: 200 }) }
      : {}),
  };
}

function summarizeAccounting(
  run: AccountingRun | undefined,
  now: Date,
): HealthRunSummary | null {
  if (!run) {
    return null;
  }
  return {
    id: run.id,
    status: run.status,
    completedAt: run.completedAt,
    ageSeconds: ageSeconds(run.completedAt, now),
    failed: run.status === "failed",
    ...(run.error
      ? { error: sanitizeErrorText(run.error, { maxLength: 200 }) }
      : {}),
  };
}

function ageSeconds(completedAt: string, now: Date): number | null {
  const completedMs = Date.parse(completedAt);
  if (!Number.isFinite(completedMs)) {
    return null;
  }
  return Math.max(0, Math.floor((now.getTime() - completedMs) / 1_000));
}

function formatAge(ageSeconds: number): string {
  if (ageSeconds < 60) {
    return `${ageSeconds}s`;
  }
  if (ageSeconds < 3_600) {
    return `${Math.floor(ageSeconds / 60)}m`;
  }
  const hours = Math.floor(ageSeconds / 3_600);
  const minutes = Math.floor((ageSeconds % 3_600) / 60);
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}
