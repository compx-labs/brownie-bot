import algosdk from "algosdk";
import { afterEach, describe, expect, it } from "vitest";

import { createApp, type AppContext } from "../src/app.js";
import { loadConfig } from "../src/config.js";

describe("backend routes", () => {
  let context: AppContext | undefined;
  const account = algosdk.generateAccount();
  const environment = {
    NODE_ENV: "test",
    BOT_WALLET: account.addr.toString(),
    WALLET_MNEMONIC: algosdk.secretKeyToMnemonic(account.sk),
  };

  afterEach(async () => {
    await context?.app.close();
    context = undefined;
  });

  it("reports safe configuration state without optional integrations", async () => {
    context = await createApp(loadConfig(environment));
    const response = await context.app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "degraded",
      mode: "autonomous",
      signingEnabled: false,
      walletConfigured: true,
      telegramConfigured: false,
      accountingEnabled: true,
      accountingStorage: "local",
      folksEscrowStorage: "local",
      busy: false,
      latestReview: null,
      latestAccounting: null,
      warnings: ["No treasury review has completed yet"],
      spend: {
        timezone: "UTC",
        canix: {
          usedUsdc: "0",
          capUsdc: "5",
          remainingUsdc: "5",
          uncapped: false,
        },
        zs: {
          usedUsdc: "0",
          capUsdc: "5",
          remainingUsdc: "5",
          uncapped: false,
        },
      },
    });
    expect(response.json()).not.toHaveProperty("deps");

    const runs = await context.app.inject({
      method: "GET",
      url: "/runs",
    });
    expect(runs.statusCode).toBe(200);
    expect(runs.json()).toEqual({ retentionDays: 7, runs: [] });
  });

  it("includes last review summary on /health after hydrate", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const rootDir = await mkdtemp(join(tmpdir(), "brownie-app-health-"));
    try {
      const { LocalFilesystemReviewRunStore } =
        await import("../src/integrations/storage/review-run-store.js");
      const { portfolioPlan, portfolioSnapshot } =
        await import("./fixtures.js");
      const store = new LocalFilesystemReviewRunStore({
        rootDir,
        prefix: "brownie-bot",
      });
      const wallet = account.addr.toString();
      await store.putLatest({
        id: "persisted-run",
        startedAt: "2026-07-13T09:00:00.000Z",
        completedAt: "2026-07-13T09:00:01.000Z",
        status: "no-op",
        mode: "autonomous",
        signingEnabled: false,
        walletAddress: wallet,
        snapshot: portfolioSnapshot({ address: wallet }),
        plan: portfolioPlan(),
        opportunities: [],
      });

      context = await createApp(
        loadConfig({
          ...environment,
          ACCOUNTING_DATA_DIR: rootDir,
          DO_SPACES_PREFIX: "brownie-bot",
        }),
      );
      const response = await context.app.inject({
        method: "GET",
        url: "/health",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        latestReview: {
          id: "persisted-run",
          status: "no-op",
          failed: false,
          ageSeconds: expect.any(Number) as number,
        },
      });
    } finally {
      await context?.app.close();
      context = undefined;
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("reports Telegram and Spaces when configured", async () => {
    context = await createApp(
      loadConfig({
        ...environment,
        TELEGRAM_BOT_TOKEN: "test-token",
        TELEGRAM_CHAT_ID: "test-chat",
        DO_SPACES_ENDPOINT: "https://nyc3.digitaloceanspaces.com",
        DO_SPACES_BUCKET: "bucket",
        DO_SPACES_KEY: "key",
        DO_SPACES_SECRET: "secret",
      }),
    );
    const response = await context.app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.json()).toMatchObject({
      telegramConfigured: true,
      accountingStorage: "spaces",
    });
  });

  it("does not expose an unprotected manual trigger", async () => {
    context = await createApp(loadConfig(environment));
    const response = await context.app.inject({
      method: "POST",
      url: "/runs",
    });
    expect(response.statusCode).toBe(404);
  });

  it("lists dated review summaries on GET /runs without full payloads", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const rootDir = await mkdtemp(join(tmpdir(), "brownie-app-runs-"));
    try {
      const { LocalFilesystemReviewRunStore } =
        await import("../src/integrations/storage/review-run-store.js");
      const { portfolioPlan, portfolioSnapshot } =
        await import("./fixtures.js");
      const store = new LocalFilesystemReviewRunStore({
        rootDir,
        prefix: "brownie-bot",
      });
      const wallet = account.addr.toString();
      const now = new Date();
      const olderStarted = new Date(now.getTime() - 36 * 60 * 60 * 1000);
      const newerStarted = new Date(now.getTime() - 60 * 60 * 1000);
      await store.putLatest(
        {
          id: "older-run",
          startedAt: olderStarted.toISOString(),
          completedAt: new Date(olderStarted.getTime() + 1000).toISOString(),
          status: "no-op",
          mode: "autonomous",
          signingEnabled: false,
          walletAddress: wallet,
          snapshot: portfolioSnapshot({ address: wallet }),
          plan: portfolioPlan(),
          opportunities: [],
          payments: [],
        },
        { now },
      );
      await store.putLatest(
        {
          id: "newer-run",
          startedAt: newerStarted.toISOString(),
          completedAt: new Date(newerStarted.getTime() + 1000).toISOString(),
          status: "failed",
          mode: "autonomous",
          signingEnabled: false,
          walletAddress: wallet,
          snapshot: portfolioSnapshot({ address: wallet }),
          plan: portfolioPlan(),
          opportunities: [],
          payments: [],
          error: "agent timeout",
        },
        { now },
      );

      context = await createApp(
        loadConfig({
          ...environment,
          ACCOUNTING_DATA_DIR: rootDir,
          DO_SPACES_PREFIX: "brownie-bot",
        }),
      );
      const emptyLimit = await context.app.inject({
        method: "GET",
        url: "/runs?limit=1",
      });
      expect(emptyLimit.statusCode).toBe(200);
      expect(emptyLimit.json()).toMatchObject({
        retentionDays: 7,
        runs: [
          {
            id: "newer-run",
            status: "failed",
            error: "agent timeout",
          },
        ],
      });
      const limitedPayload = JSON.stringify(emptyLimit.json());
      expect(limitedPayload).not.toContain('"snapshot"');
      expect(limitedPayload).not.toContain('"plan"');
      expect(limitedPayload).not.toContain('"opportunities"');

      const all = await context.app.inject({ method: "GET", url: "/runs" });
      expect(all.json()).toMatchObject({
        runs: [{ id: "newer-run" }, { id: "older-run" }],
      });
    } finally {
      await context?.app.close();
      context = undefined;
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("hydrates /runs/latest from persisted review store on boot", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const rootDir = await mkdtemp(join(tmpdir(), "brownie-app-review-"));
    try {
      const { LocalFilesystemReviewRunStore } =
        await import("../src/integrations/storage/review-run-store.js");
      const { portfolioPlan, portfolioSnapshot } =
        await import("./fixtures.js");
      const store = new LocalFilesystemReviewRunStore({
        rootDir,
        prefix: "brownie-bot",
      });
      const wallet = account.addr.toString();
      await store.putLatest({
        id: "persisted-run",
        startedAt: "2026-07-13T09:00:00.000Z",
        completedAt: "2026-07-13T09:00:01.000Z",
        status: "no-op",
        mode: "autonomous",
        signingEnabled: false,
        walletAddress: wallet,
        snapshot: portfolioSnapshot({ address: wallet }),
        plan: portfolioPlan(),
        opportunities: [],
        payments: [],
      });

      context = await createApp(
        loadConfig({
          ...environment,
          ACCOUNTING_DATA_DIR: rootDir,
          DO_SPACES_PREFIX: "brownie-bot",
        }),
      );
      const response = await context.app.inject({
        method: "GET",
        url: "/runs/latest",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id: "persisted-run",
        status: "no-op",
      });
    } finally {
      await context?.app.close();
      context = undefined;
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("allows a separate x402 payer only while execution signing is disabled", async () => {
    const differentTreasury = algosdk.generateAccount().addr.toString();
    context = await createApp(
      loadConfig({ ...environment, BOT_WALLET: differentTreasury }),
    );
    await context.app.ready();
    expect(context).toBeDefined();
    await context.app.close();
    context = undefined;

    await expect(
      createApp(
        loadConfig({
          ...environment,
          BOT_WALLET: differentTreasury,
          ENABLE_TRANSACTION_SIGNING: "true",
        }),
      ),
    ).rejects.toThrow(/BOT_WALLET must match WALLET_MNEMONIC/);
  });
});
