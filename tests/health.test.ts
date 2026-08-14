import { describe, expect, it, vi } from "vitest";

import {
  algodHealthUrl,
  buildHealthReport,
  probeCanixDependency,
  probeHttpDependency,
  zsProxyHealthzUrl,
} from "../src/services/health.js";
import type { AccountingRun, ReviewRun } from "../src/domain.js";

function review(overrides: Partial<ReviewRun> = {}): ReviewRun {
  return {
    id: "review-1",
    startedAt: "2026-07-24T10:00:00.000Z",
    completedAt: "2026-07-24T10:00:01.000Z",
    status: "no-op",
    mode: "autonomous",
    signingEnabled: false,
    opportunities: [],
    ...overrides,
  };
}

function accounting(overrides: Partial<AccountingRun> = {}): AccountingRun {
  return {
    id: "acct-1",
    startedAt: "2026-07-24T09:00:00.000Z",
    completedAt: "2026-07-24T09:00:01.000Z",
    status: "completed",
    ...overrides,
  };
}

describe("buildHealthReport", () => {
  const base = {
    signingEnabled: false,
    telegramConfigured: false,
    accountingStorage: "local" as const,
    folksEscrowStorage: "local" as const,
    busy: false,
    now: new Date("2026-07-24T12:00:00.000Z"),
  };

  it("is degraded when no review has completed", () => {
    const report = buildHealthReport(base);
    expect(report.status).toBe("degraded");
    expect(report.latestReview).toBeNull();
    expect(report.warnings).toContain("No treasury review has completed yet");
  });

  it("is ok with a fresh successful review", () => {
    const report = buildHealthReport({
      ...base,
      latestReview: review(),
      latestAccounting: accounting(),
    });
    expect(report.status).toBe("ok");
    expect(report.paused).toBe(false);
    expect(report.warnings).toEqual([]);
    expect(report.latestReview).toMatchObject({
      id: "review-1",
      status: "no-op",
      failed: false,
      ageSeconds: 7_199,
    });
  });

  it("flags paused trading as degraded", () => {
    const report = buildHealthReport({
      ...base,
      paused: true,
      latestReview: review(),
      latestAccounting: accounting(),
    });
    expect(report.status).toBe("degraded");
    expect(report.paused).toBe(true);
    expect(report.warnings).toContain("Trading paused (plan-only)");
  });

  it("flags failed and stale reviews", () => {
    const report = buildHealthReport({
      ...base,
      staleReviewHours: 1,
      latestReview: review({
        status: "failed",
        completedAt: "2026-07-24T08:00:00.000Z",
        error:
          "504 <!DOCTYPE html><html><title>504 Gateway Timeout</title><h3>connection to nauvoo.belt.algo.xyz</h3></html>",
      }),
    });
    expect(report.status).toBe("degraded");
    expect(report.latestReview?.failed).toBe(true);
    expect(report.latestReview?.error).toBe(
      "ZeroSignal gateway timeout (504); could not reach nauvoo.belt.algo.xyz",
    );
    expect(report.warnings.some((warning) => warning.includes("stale"))).toBe(
      true,
    );
    expect(
      report.warnings.some((warning) =>
        warning.includes("ZeroSignal gateway timeout"),
      ),
    ).toBe(true);
  });

  it("includes dependency warnings when probes fail", () => {
    const report = buildHealthReport({
      ...base,
      latestReview: review(),
      deps: {
        zsProxy: { ok: false, latencyMs: 12, error: "HTTP 503" },
        algod: { ok: true, latencyMs: 40 },
        canix: { ok: true, latencyMs: 80 },
      },
    });
    expect(report.status).toBe("degraded");
    expect(report.deps?.zsProxy.ok).toBe(false);
    expect(report.warnings).toContain("ZeroSignal proxy unreachable: HTTP 503"); // pragma: allowlist secret
  });

  it("passes through daily spend used and remaining", () => {
    const report = buildHealthReport({
      ...base,
      latestReview: review(),
      latestAccounting: accounting(),
      spend: {
        dayUtc: "2026-08-14",
        timezone: "UTC",
        canix: {
          usedUsdc: "0.12",
          capUsdc: "5",
          remainingUsdc: "4.88",
          uncapped: false,
        },
        zs: {
          usedUsdc: "0",
          capUsdc: null,
          remainingUsdc: null,
          uncapped: true,
        },
      },
    });
    expect(report.status).toBe("ok");
    expect(report.spend?.canix.remainingUsdc).toBe("4.88");
    expect(report.spend?.zs.uncapped).toBe(true);
  });
});

describe("dependency URL helpers", () => {
  it("maps OpenAI base URL to zs-proxy healthz", () => {
    expect(zsProxyHealthzUrl("http://127.0.0.1:8080/v1")).toBe(
      "http://127.0.0.1:8080/healthz",
    );
    expect(zsProxyHealthzUrl("http://127.0.0.1:8080/v1/")).toBe(
      "http://127.0.0.1:8080/healthz",
    );
  });

  it("maps algod root to /health", () => {
    expect(algodHealthUrl("https://mainnet-api.algonode.cloud")).toBe(
      "https://mainnet-api.algonode.cloud/health",
    );
  });
});

describe("probes", () => {
  it("probeHttpDependency reports ok for 200 responses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await expect(
      probeHttpDependency("http://example.test/healthz", { fetchImpl }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("probeHttpDependency reports HTTP failures", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 504 });
    await expect(
      probeHttpDependency("http://example.test/healthz", { fetchImpl }),
    ).resolves.toEqual({
      ok: false,
      latencyMs: expect.any(Number) as number,
      error: "HTTP 504",
    });
  });

  it("probeCanixDependency wraps timeouts and errors", async () => {
    await expect(
      probeCanixDependency(
        () => new Promise((resolve) => setTimeout(resolve, 50)),
        { timeoutMs: 1 },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/timed out/i) as string,
    });
  });
});
