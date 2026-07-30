import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { OperatorPauseStore } from "../src/services/operator-pause.js";

describe("OperatorPauseStore", () => {
  const wallet = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ";
  let rootDir: string;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createStore(prefix = "brownie-bot"): Promise<OperatorPauseStore> {
    rootDir = await mkdtemp(join(tmpdir(), "operator-pause-"));
    return new OperatorPauseStore({
      rootDir,
      walletAddress: wallet,
      prefix,
    });
  }

  function expectedPath(prefix = "brownie-bot"): string {
    return join(rootDir, prefix, "wallets", wallet, "operator-pause.json");
  }

  it("starts unpaused when no file exists", async () => {
    const store = await createStore();
    await expect(store.hydrate()).resolves.toMatchObject({
      paused: false,
      updatedAt: null,
      source: null,
    });
    expect(store.isPaused()).toBe(false);
  });

  it("pauses and resumes with durable persistence", async () => {
    const store = await createStore();
    await store.hydrate();

    const paused = await store.pause("telegram");
    expect(paused.paused).toBe(true);
    expect(paused.source).toBe("telegram");
    expect(paused.updatedAt).toMatch(/^\d{4}-/);
    expect(store.isPaused()).toBe(true);

    const raw = JSON.parse(await readFile(expectedPath(), "utf8")) as {
      paused: boolean;
      source: string;
    };
    expect(raw).toMatchObject({ paused: true, source: "telegram" });

    const resumed = await store.resume("telegram");
    expect(resumed.paused).toBe(false);
    expect(store.isPaused()).toBe(false);
    const after = JSON.parse(await readFile(expectedPath(), "utf8")) as {
      paused: boolean;
    };
    expect(after.paused).toBe(false);
  });

  it("hydrates paused state from disk on boot", async () => {
    const store = await createStore();
    await store.pause("telegram");

    const reloaded = new OperatorPauseStore({
      rootDir,
      walletAddress: wallet,
      prefix: "brownie-bot",
    });
    await expect(reloaded.hydrate()).resolves.toMatchObject({
      paused: true,
      source: "telegram",
    });
    expect(reloaded.isPaused()).toBe(true);
  });

  it("is idempotent for pause and resume", async () => {
    const store = await createStore();
    await store.pause();
    const again = await store.pause();
    expect(again.paused).toBe(true);

    await store.resume();
    const still = await store.resume();
    expect(still.paused).toBe(false);
  });

  it("ignores corrupt files and stays unpaused", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "operator-pause-"));
    const path = join(
      rootDir,
      "brownie-bot",
      "wallets",
      wallet,
      "operator-pause.json",
    );
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(rootDir, "brownie-bot", "wallets", wallet), {
      recursive: true,
    });
    await writeFile(path, "{not-json", "utf8");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const store = new OperatorPauseStore({
      rootDir,
      walletAddress: wallet,
      prefix: "brownie-bot",
    });
    await store.hydrate();
    expect(store.isPaused()).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
  });
});
