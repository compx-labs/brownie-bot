import { describe, expect, it, vi } from "vitest";

import {
  algodAccountUrl,
  algodHealthUrl,
  buildHealthReport,
  HEALTH_USDC_ASSET_ID,
  probeCanixDependency,
  probeHttpDependency,
  probeWalletBalances,
  shouldProbeWalletBalances,
  walletBalanceWarnings,
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

  it("flags low spendable ALGO and USDC against configured floors", () => {
    const report = buildHealthReport({
      ...base,
      latestReview: review(),
      latestAccounting: accounting(),
      wallet: {
        ok: true,
        latencyMs: 20,
        algoSpendable: "0.25",
        usdc: "0.1",
        usdcOptedIn: true,
        usdcFrozen: false,
        floors: { algo: "1", usdc: "1" },
      },
    });
    expect(report.status).toBe("degraded");
    expect(report.paused).toBe(false);
    expect(report.wallet?.algoSpendable).toBe("0.25");
    expect(report.warnings).toEqual([
      "Low ALGO: 0.25 spendable (floor 1)",
      "Low USDC: 0.1 (floor 1)",
    ]);
  });

  it("warns when USDC is not opted in or frozen", () => {
    const missing = buildHealthReport({
      ...base,
      latestReview: review(),
      latestAccounting: accounting(),
      wallet: {
        ok: true,
        latencyMs: 15,
        algoSpendable: "2",
        usdc: "0",
        usdcOptedIn: false,
        usdcFrozen: false,
        floors: { algo: "1", usdc: "1" },
      },
    });
    expect(missing.warnings).toEqual([
      `USDC ASA ${HEALTH_USDC_ASSET_ID} not opted in (floor 1)`,
    ]);

    const frozen = buildHealthReport({
      ...base,
      latestReview: review(),
      latestAccounting: accounting(),
      wallet: {
        ok: true,
        latencyMs: 15,
        algoSpendable: "2",
        usdc: "0",
        usdcOptedIn: true,
        usdcFrozen: true,
        floors: { algo: "1", usdc: "1" },
      },
    });
    expect(frozen.warnings).toEqual(["USDC is frozen (cannot spend)"]);
  });

  it("does not warn when balances meet floors or floors are disabled", () => {
    const funded = buildHealthReport({
      ...base,
      latestReview: review(),
      latestAccounting: accounting(),
      wallet: {
        ok: true,
        latencyMs: 18,
        algoSpendable: "1",
        usdc: "1",
        usdcOptedIn: true,
        usdcFrozen: false,
        floors: { algo: "1", usdc: "1" },
      },
    });
    expect(funded.status).toBe("ok");
    expect(funded.warnings).toEqual([]);

    expect(
      walletBalanceWarnings({
        ok: true,
        latencyMs: 1,
        algoSpendable: "0",
        usdc: "0",
        usdcOptedIn: false,
        usdcFrozen: false,
        floors: { algo: "0", usdc: "0" },
      }),
    ).toEqual([]);
  });

  it("classifies wallet probe HTML failures without dumping the body", () => {
    const report = buildHealthReport({
      ...base,
      latestReview: review(),
      latestAccounting: accounting(),
      wallet: {
        ok: false,
        latencyMs: 30,
        error:
          "Algod gateway timeout (504); could not reach mainnet-api.algonode.cloud",
        algoSpendable: "0",
        usdc: "0",
        usdcOptedIn: false,
        usdcFrozen: false,
        floors: { algo: "1", usdc: "1" },
      },
    });
    expect(report.status).toBe("degraded");
    expect(report.warnings).toEqual([
      "Wallet balance check failed: Algod gateway timeout (504); could not reach mainnet-api.algonode.cloud",
    ]);
    expect(report.warnings.join(" ")).not.toMatch(/<!DOCTYPE|html>/i);
  });

  it("skips wallet probe-failure warning when Algod is already unreachable", () => {
    const report = buildHealthReport({
      ...base,
      latestReview: review(),
      latestAccounting: accounting(),
      deps: {
        zsProxy: { ok: true, latencyMs: 10 },
        algod: { ok: false, latencyMs: 40, error: "HTTP 504" },
        canix: { ok: true, latencyMs: 80 },
      },
      wallet: {
        ok: false,
        latencyMs: 41,
        error: "HTTP 504",
        algoSpendable: "0",
        usdc: "0",
        usdcOptedIn: false,
        usdcFrozen: false,
        floors: { algo: "1", usdc: "1" },
      },
    });
    expect(report.warnings).toEqual(["Algod unreachable: HTTP 504"]);
  });

  it("omits wallet from the report when it was not probed", () => {
    const report = buildHealthReport({
      ...base,
      latestReview: review(),
      latestAccounting: accounting(),
    });
    expect(report).not.toHaveProperty("wallet");
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

  it("maps algod root to account lookup", () => {
    expect(
      algodAccountUrl(
        "https://mainnet-api.algonode.cloud",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ",
      ),
    ).toBe(
      "https://mainnet-api.algonode.cloud/v2/accounts/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ",
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

  it("probeWalletBalances reads spendable ALGO and USDC from one account call", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          amount: 1_250_000,
          "min-balance": 200_000,
          assets: [
            {
              "asset-id": HEALTH_USDC_ASSET_ID,
              amount: 250_000,
              "is-frozen": false,
            },
          ],
        }),
    });
    await expect(
      probeWalletBalances(
        "https://mainnet-api.algonode.cloud",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ",
        {
          floors: { algo: 1, usdc: 1 },
          fetchImpl,
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      algoSpendable: "1.05",
      usdc: "0.25",
      usdcOptedIn: true,
      usdcFrozen: false,
      floors: { algo: "1", usdc: "1" },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("probeWalletBalances sanitizes HTML Algod failures", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 504,
      text: () =>
        Promise.resolve(
          "<!DOCTYPE html><html><title>504 Gateway Timeout</title><h3>connection to mainnet-api.algonode.cloud</h3></html>",
        ),
    });
    const result = await probeWalletBalances(
      "https://mainnet-api.algonode.cloud",
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ",
      {
        floors: { algo: 1, usdc: 1 },
        fetchImpl,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      "Algod gateway timeout (504); could not reach mainnet-api.algonode.cloud",
    );
    expect(result.error).not.toMatch(/<!DOCTYPE|html>/i);
  });
});

describe("shouldProbeWalletBalances", () => {
  it("skips the extra Algod account call when both floors are 0", () => {
    expect(shouldProbeWalletBalances({ algo: 0, usdc: 0 })).toBe(false);
    expect(shouldProbeWalletBalances({ algo: 1, usdc: 0 })).toBe(true);
    expect(shouldProbeWalletBalances({ algo: 0, usdc: 0.5 })).toBe(true);
  });
});
