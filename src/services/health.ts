import type { AccountingRun, ReviewRun } from "../domain.js";
import { sanitizeErrorMessage, sanitizeErrorText } from "../util/errors.js";

const DEFAULT_STALE_REVIEW_HOURS = 36;
const DEFAULT_STALE_ACCOUNTING_HOURS = 36;
const DEFAULT_DEP_TIMEOUT_MS = 2_500;

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
  deps?: {
    zsProxy: HealthDependencyCheck;
    algod: HealthDependencyCheck;
    canix: HealthDependencyCheck;
  };
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
  deps?: HealthReport["deps"];
  now?: Date;
  staleReviewHours?: number;
  staleAccountingHours?: number;
}

export function buildHealthReport(input: BuildHealthReportInput): HealthReport {
  const now = input.now ?? new Date();
  const staleReviewHours =
    input.staleReviewHours ?? DEFAULT_STALE_REVIEW_HOURS;
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
    ...(input.deps ? { deps: input.deps } : {}),
    warnings,
  };
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
