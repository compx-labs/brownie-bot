import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DailySpendStore,
  formatDailySpendLines,
  utcDayKey,
} from "../src/services/daily-spend.js";

const wallet = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ";

describe("utcDayKey", () => {
  it("uses the UTC calendar date", () => {
    expect(utcDayKey(new Date("2026-08-14T23:59:59.000Z"))).toBe("2026-08-14");
    expect(utcDayKey(new Date("2026-08-15T00:00:00.000Z"))).toBe("2026-08-15");
  });
});

describe("DailySpendStore", () => {
  let rootDir: string;
  let now = new Date("2026-08-14T12:00:00.000Z");

  afterEach(async () => {
    vi.restoreAllMocks();
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  async function createStore(
    overrides: Partial<ConstructorParameters<typeof DailySpendStore>[0]> = {},
  ): Promise<DailySpendStore> {
    rootDir = await mkdtemp(join(tmpdir(), "daily-spend-"));
    now = new Date("2026-08-14T12:00:00.000Z");
    return new DailySpendStore({
      rootDir,
      walletAddress: wallet,
      prefix: "brownie-bot",
      canixCapBaseUnits: 5_000_000n,
      zsCapUsdc: 5,
      now: () => now,
      ...overrides,
    });
  }

  function expectedPath(): string {
    return join(rootDir, "brownie-bot", "wallets", wallet, "daily-spend.json");
  }

  it("starts at zero used with remaining equal to caps", async () => {
    const store = await createStore();
    await store.hydrate();
    expect(store.getReport()).toMatchObject({
      dayUtc: "2026-08-14",
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
    });
  });

  it("persists Canix and inference charges and hydrates them", async () => {
    const store = await createStore();
    await store.hydrate();
    await store.recordCanix(120_000n);
    await store.recordZsUsdc("0.0042");

    const raw = JSON.parse(await readFile(expectedPath(), "utf8")) as {
      dayUtc: string;
      canixBaseUnits: string;
      zsUsdc: string;
    };
    expect(raw).toMatchObject({
      dayUtc: "2026-08-14",
      canixBaseUnits: "120000",
      zsUsdc: "0.0042",
    });

    const reloaded = new DailySpendStore({
      rootDir,
      walletAddress: wallet,
      prefix: "brownie-bot",
      canixCapBaseUnits: 5_000_000n,
      zsCapUsdc: 5,
      now: () => now,
    });
    const report = await reloaded.hydrate();
    expect(report.canix.usedUsdc).toBe("0.12");
    expect(report.canix.remainingUsdc).toBe("4.88");
    expect(report.zs.usedUsdc).toBe("0.0042");
    expect(report.zs.remainingUsdc).toBe("4.9958");
  });

  it("rolls over both counters at the UTC day boundary", async () => {
    const store = await createStore();
    await store.hydrate();
    await store.recordCanix(50_000n);
    await store.recordZsUsdc("0.01");
    expect(store.getReport().canix.usedUsdc).toBe("0.05");

    now = new Date("2026-08-15T00:00:00.000Z");
    const report = store.getReport();
    expect(report.dayUtc).toBe("2026-08-15");
    expect(report.canix.usedUsdc).toBe("0");
    expect(report.canix.remainingUsdc).toBe("5");
    expect(report.zs.usedUsdc).toBe("0");
    expect(report.zs.remainingUsdc).toBe("5");
    expect(store.usedCanixBaseUnits()).toBe(0n);
  });

  it("hydrates a previous UTC day as a fresh zero day", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "daily-spend-"));
    const dir = join(rootDir, "brownie-bot", "wallets", wallet);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "daily-spend.json"),
      `${JSON.stringify({
        dayUtc: "2026-08-13",
        canixBaseUnits: "999000",
        zsUsdc: "1.25",
        updatedAt: "2026-08-13T22:00:00.000Z",
      })}\n`,
      "utf8",
    );

    now = new Date("2026-08-14T00:00:00.000Z");
    const store = new DailySpendStore({
      rootDir,
      walletAddress: wallet,
      prefix: "brownie-bot",
      canixCapBaseUnits: 5_000_000n,
      zsCapUsdc: 5,
      now: () => now,
    });
    const report = await store.hydrate();
    expect(report.dayUtc).toBe("2026-08-14");
    expect(report.canix.usedUsdc).toBe("0");
    expect(report.zs.usedUsdc).toBe("0");
  });

  it("skips missing, empty, invalid, and zero inference amounts", async () => {
    const store = await createStore();
    await store.hydrate();
    await store.recordZsUsdc(undefined);
    await store.recordZsUsdc("");
    await store.recordZsUsdc("  ");
    await store.recordZsUsdc("not-a-number");
    await store.recordZsUsdc("-0.01");
    await store.recordZsUsdc("0");
    expect(store.getReport().zs.usedUsdc).toBe("0");
  });

  it("shows uncapped when caps are zero or omitted", async () => {
    const store = await createStore({
      canixCapBaseUnits: 0n,
      zsCapUsdc: 0,
    });
    await store.hydrate();
    await store.recordCanix(1_000n);
    await store.recordZsUsdc("0.5");
    const report = store.getReport();
    expect(report.canix).toMatchObject({
      usedUsdc: "0.001",
      capUsdc: null,
      remainingUsdc: null,
      uncapped: true,
    });
    expect(report.zs).toMatchObject({
      usedUsdc: "0.5",
      capUsdc: null,
      remainingUsdc: null,
      uncapped: true,
    });
    expect(formatDailySpendLines(report)).toEqual([
      "Canix x402 today (UTC): $0.001 used, uncapped",
      "ZS today (UTC): $0.5 used, uncapped",
    ]);
  });

  it("floors remaining at zero when used exceeds the cap", async () => {
    const store = await createStore({
      canixCapBaseUnits: 10_000n,
      zsCapUsdc: 1,
    });
    await store.recordCanix(25_000n);
    await store.recordZsUsdc("1.5");
    expect(store.getReport().canix.remainingUsdc).toBe("0");
    expect(store.getReport().zs.remainingUsdc).toBe("0");
  });

  it("formats capped remaining lines for Telegram /status", async () => {
    const store = await createStore();
    await store.recordCanix(120_000n);
    await store.recordZsUsdc("0.0042");
    expect(formatDailySpendLines(store.getReport())).toEqual([
      "Canix x402 today (UTC): $0.12 used, $4.88 remaining",
      "ZS today (UTC): $0.0042 used, $4.9958 remaining",
    ]);
  });

  it("ignores corrupt files and stays at zero", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "daily-spend-"));
    const dir = join(rootDir, "brownie-bot", "wallets", wallet);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "daily-spend.json"), "{not-json", "utf8");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const store = new DailySpendStore({
      rootDir,
      walletAddress: wallet,
      prefix: "brownie-bot",
      now: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    await store.hydrate();
    expect(store.getReport().canix.usedUsdc).toBe("0");
    expect(errorSpy).toHaveBeenCalled();
  });
});
