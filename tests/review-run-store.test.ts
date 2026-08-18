import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ReviewRun } from "../src/domain.js";
import {
  clampReviewListLimit,
  datedReviewKey,
  DEFAULT_REVIEW_LIST_LIMIT,
  LocalFilesystemReviewRunStore,
  MAX_REVIEW_LIST_LIMIT,
  REVIEW_HISTORY_RETENTION_DAYS,
  SpacesReviewRunStore,
  summarizeReviewRun,
} from "../src/integrations/storage/review-run-store.js";
import { portfolioPlan, portfolioSnapshot } from "./fixtures.js";

function sampleRun(overrides: Partial<ReviewRun> = {}): ReviewRun {
  return {
    id: "run-1",
    startedAt: "2026-08-17T09:00:00.000Z",
    completedAt: "2026-08-17T09:00:01.000Z",
    status: "validated-dry-run",
    mode: "autonomous",
    signingEnabled: false,
    walletAddress: "WALLETADDR",
    snapshot: portfolioSnapshot({ address: "WALLETADDR" }),
    plan: portfolioPlan(),
    opportunities: [],
    payments: [],
    ...overrides,
  };
}

function createMemoryS3() {
  const objects = new Map<string, string>();
  return {
    objects,
    client: {
      send: vi.fn(
        (command: {
          constructor: { name: string };
          input: Record<string, unknown>;
        }) => {
          const name = command.constructor.name;
          const input = command.input;
          if (name === "GetObjectCommand") {
            const key = String(input.Key);
            const body = objects.get(key);
            if (!body) {
              const error = new Error("NoSuchKey") as Error & {
                name: string;
                $metadata: { httpStatusCode: number };
              };
              error.name = "NoSuchKey";
              error.$metadata = { httpStatusCode: 404 };
              throw error;
            }
            return Promise.resolve({
              Body: {
                transformToString: () => Promise.resolve(body),
              },
            });
          }
          if (name === "PutObjectCommand") {
            objects.set(String(input.Key), String(input.Body));
            return Promise.resolve({});
          }
          if (name === "ListObjectsV2Command") {
            const prefix = typeof input.Prefix === "string" ? input.Prefix : "";
            return Promise.resolve({
              Contents: [...objects.keys()]
                .filter((key) => key.startsWith(prefix))
                .map((Key) => ({ Key })),
              IsTruncated: false,
            });
          }
          if (name === "DeleteObjectCommand") {
            objects.delete(String(input.Key));
            return Promise.resolve({});
          }
          return Promise.reject(new Error(`Unexpected command ${name}`));
        },
      ),
    },
  };
}

describe("clampReviewListLimit", () => {
  it("defaults, floors, and caps the list limit", () => {
    expect(clampReviewListLimit(undefined)).toBe(DEFAULT_REVIEW_LIST_LIMIT);
    expect(clampReviewListLimit("3")).toBe(3);
    expect(clampReviewListLimit(0)).toBe(DEFAULT_REVIEW_LIST_LIMIT);
    expect(clampReviewListLimit(MAX_REVIEW_LIST_LIMIT + 50)).toBe(
      MAX_REVIEW_LIST_LIMIT,
    );
  });
});

describe("LocalFilesystemReviewRunStore", () => {
  it("round-trips latest review run and a dated copy", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "brownie-review-"));
    try {
      const store = new LocalFilesystemReviewRunStore({
        rootDir,
        prefix: "brownie",
      });
      const run = sampleRun();
      const now = new Date("2026-08-17T12:00:00.000Z");
      const key = await store.putLatest(run, { now });
      expect(key).toBe("brownie/wallets/WALLETADDR/reviews/latest.json");
      await expect(store.getLatest("WALLETADDR")).resolves.toEqual(run);

      const datedKey = datedReviewKey("brownie", "WALLETADDR", run);
      expect(datedKey).toBe(
        "brownie/wallets/WALLETADDR/reviews/2026/08/17/run-1.json",
      );
      const datedPath = join(rootDir, ...datedKey.split("/"));
      const dated = JSON.parse(await readFile(datedPath, "utf8")) as ReviewRun;
      expect(dated).toEqual(run);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("returns undefined for missing or corrupt latest.json", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "brownie-review-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const store = new LocalFilesystemReviewRunStore({ rootDir });
      await expect(store.getLatest("MISSING")).resolves.toBeUndefined();

      await store.putLatest(sampleRun({ id: "bad" }), {
        now: new Date("2026-08-17T12:00:00.000Z"),
      });
      const filePath = join(
        rootDir,
        "wallets",
        "WALLETADDR",
        "reviews",
        "latest.json",
      );
      await writeFile(filePath, '{"not":"a-review-run"}', "utf8");
      await expect(store.getLatest("WALLETADDR")).resolves.toBeUndefined();

      await writeFile(filePath, "{not json", "utf8");
      await expect(store.getLatest("WALLETADDR")).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("lists recent run summaries without dumping full payloads", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "brownie-review-"));
    try {
      const store = new LocalFilesystemReviewRunStore({
        rootDir,
        prefix: "brownie",
      });
      const older = sampleRun({
        id: "run-old",
        startedAt: "2026-08-16T08:00:00.000Z",
        completedAt: "2026-08-16T08:00:01.000Z",
        status: "no-op",
      });
      const newer = sampleRun({
        id: "run-new",
        startedAt: "2026-08-17T10:00:00.000Z",
        completedAt: "2026-08-17T10:00:02.000Z",
        status: "failed",
        error: "plan parse failed",
      });
      const now = new Date("2026-08-17T12:00:00.000Z");
      await store.putLatest(older, { now });
      await store.putLatest(newer, { now });

      const listed = await store.list("WALLETADDR", { now, limit: 10 });
      expect(listed).toEqual([
        summarizeReviewRun(newer),
        summarizeReviewRun(older),
      ]);
      expect(listed[0]).not.toHaveProperty("snapshot");
      expect(listed[0]).not.toHaveProperty("plan");
      expect(listed[0]).not.toHaveProperty("opportunities");
      expect(listed[0]).not.toHaveProperty("payments");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rotates dated files older than one week and keeps latest.json", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "brownie-review-"));
    try {
      const store = new LocalFilesystemReviewRunStore({
        rootDir,
        prefix: "brownie",
      });
      const stale = sampleRun({
        id: "stale-run",
        startedAt: "2026-08-10T09:00:00.000Z",
        completedAt: "2026-08-10T09:00:01.000Z",
      });
      const fresh = sampleRun({
        id: "fresh-run",
        startedAt: "2026-08-16T09:00:00.000Z",
        completedAt: "2026-08-16T09:00:01.000Z",
        status: "confirmed",
      });
      await store.putLatest(stale, { now: new Date(stale.startedAt) });
      await store.putLatest(fresh, { now: new Date(fresh.startedAt) });

      const staleKey = datedReviewKey("brownie", "WALLETADDR", stale);
      const freshKey = datedReviewKey("brownie", "WALLETADDR", fresh);
      const stalePath = join(rootDir, ...staleKey.split("/"));
      const freshPath = join(rootDir, ...freshKey.split("/"));
      const latestPath = join(
        rootDir,
        "brownie",
        "wallets",
        "WALLETADDR",
        "reviews",
        "latest.json",
      );

      expect(JSON.parse(await readFile(stalePath, "utf8"))).toMatchObject({
        id: "stale-run",
      });

      const now = new Date("2026-08-17T12:00:00.000Z");
      const deleted = await store.rotate("WALLETADDR", now);
      expect(deleted).toEqual([staleKey]);
      await expect(readFile(stalePath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(JSON.parse(await readFile(freshPath, "utf8"))).toMatchObject({
        id: "fresh-run",
      });
      expect(JSON.parse(await readFile(latestPath, "utf8"))).toMatchObject({
        id: "fresh-run",
      });

      const listed = await store.list("WALLETADDR", { now });
      expect(listed.map((run) => run.id)).toEqual(["fresh-run"]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("hides expired files on list without deleting them", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "brownie-review-"));
    try {
      const store = new LocalFilesystemReviewRunStore({ rootDir });
      const stale = sampleRun({
        id: "expired",
        startedAt: "2026-08-01T00:00:00.000Z",
        completedAt: "2026-08-01T00:00:01.000Z",
        walletAddress: "WALLETADDR",
      });
      const staleKey = datedReviewKey("", "WALLETADDR", stale);
      const stalePath = join(rootDir, ...staleKey.split("/"));
      await mkdir(dirname(stalePath), { recursive: true });
      await writeFile(stalePath, JSON.stringify(stale), "utf8");

      const now = new Date("2026-08-17T00:00:00.000Z");
      const listed = await store.list("WALLETADDR", { now });
      expect(listed).toEqual([]);
      expect(JSON.parse(await readFile(stalePath, "utf8"))).toMatchObject({
        id: "expired",
      });

      const deleted = await store.rotate("WALLETADDR", now);
      expect(deleted).toEqual([staleKey]);
      await expect(readFile(stalePath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("keeps a late-UTC-day run until startedAt plus 7 days", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "brownie-review-"));
    try {
      const store = new LocalFilesystemReviewRunStore({
        rootDir,
        prefix: "brownie",
      });
      const late = sampleRun({
        id: "late-run",
        startedAt: "2026-08-11T23:00:00.000Z",
        completedAt: "2026-08-11T23:00:01.000Z",
      });
      await store.putLatest(late, { now: new Date(late.startedAt) });
      const datedKey = datedReviewKey("brownie", "WALLETADDR", late);
      const datedPath = join(rootDir, ...datedKey.split("/"));

      const beforeExpiry = new Date("2026-08-18T22:59:00.000Z");
      await expect(
        store.list("WALLETADDR", { now: beforeExpiry }),
      ).resolves.toEqual([summarizeReviewRun(late)]);
      await expect(store.rotate("WALLETADDR", beforeExpiry)).resolves.toEqual(
        [],
      );
      expect(JSON.parse(await readFile(datedPath, "utf8"))).toMatchObject({
        id: "late-run",
      });

      const atExpiry = new Date("2026-08-18T23:00:00.000Z");
      await expect(
        store.list("WALLETADDR", { now: atExpiry }),
      ).resolves.toEqual([]);
      expect(JSON.parse(await readFile(datedPath, "utf8"))).toMatchObject({
        id: "late-run",
      });
      await expect(store.rotate("WALLETADDR", atExpiry)).resolves.toEqual([
        datedKey,
      ]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("returns unreadable dated files as failed summaries instead of throwing", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "brownie-review-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const store = new LocalFilesystemReviewRunStore({ rootDir });
      const invalidJsonKey =
        "wallets/WALLETADDR/reviews/2026/08/17/bad-json.json";
      const invalidSchemaKey =
        "wallets/WALLETADDR/reviews/2026/08/17/bad-schema.json";
      const invalidJsonPath = join(rootDir, ...invalidJsonKey.split("/"));
      const invalidSchemaPath = join(rootDir, ...invalidSchemaKey.split("/"));
      await mkdir(dirname(invalidJsonPath), { recursive: true });
      await writeFile(invalidJsonPath, "{not json", "utf8");
      await writeFile(invalidSchemaPath, '{"not":"a-review-run"}', "utf8");

      const listed = await store.list("WALLETADDR", {
        now: new Date("2026-08-17T12:00:00.000Z"),
      });
      expect(listed).toHaveLength(2);
      expect(listed.map((run) => run.id).sort()).toEqual([
        "bad-json",
        "bad-schema",
      ]);
      expect(listed.find((run) => run.id === "bad-json")?.error).toContain(
        "invalid JSON",
      );
      expect(listed.find((run) => run.id === "bad-schema")?.error).toMatch(
        /^Unreadable review file:/,
      );
      expect(listed.every((run) => run.status === "failed")).toBe(true);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

describe("SpacesReviewRunStore", () => {
  it("writes and reads latest review run plus a dated copy", async () => {
    const memory = createMemoryS3();
    const store = new SpacesReviewRunStore({
      endpoint: "https://nyc3.digitaloceanspaces.com",
      region: "nyc3",
      bucket: "bucket",
      accessKeyId: "key",
      secretAccessKey: "secret",
      prefix: "brownie",
      client: memory.client as never,
    });
    const run = sampleRun({ id: "spaces-1" });
    const now = new Date("2026-08-17T12:00:00.000Z");
    const key = await store.putLatest(run, { now });
    expect(key).toBe("brownie/wallets/WALLETADDR/reviews/latest.json");
    expect(memory.objects.get(key)).toContain('"spaces-1"');
    const datedKey = datedReviewKey("brownie", "WALLETADDR", run);
    expect(memory.objects.get(datedKey)).toContain('"spaces-1"');
    await expect(store.getLatest("WALLETADDR")).resolves.toEqual(run);
  });

  it("lists summaries and rotates expired dated objects", async () => {
    const memory = createMemoryS3();
    const store = new SpacesReviewRunStore({
      endpoint: "https://nyc3.digitaloceanspaces.com",
      region: "nyc3",
      bucket: "bucket",
      accessKeyId: "key",
      secretAccessKey: "secret",
      prefix: "brownie",
      client: memory.client as never,
    });
    const stale = sampleRun({
      id: "spaces-stale",
      startedAt: "2026-08-10T09:00:00.000Z",
      completedAt: "2026-08-10T09:00:01.000Z",
    });
    const fresh = sampleRun({
      id: "spaces-fresh",
      startedAt: "2026-08-16T09:00:00.000Z",
      completedAt: "2026-08-16T09:00:01.000Z",
      status: "no-op",
    });
    await store.putLatest(stale, { now: new Date(stale.startedAt) });
    await store.putLatest(fresh, { now: new Date(fresh.startedAt) });
    expect(
      memory.objects.has(datedReviewKey("brownie", "WALLETADDR", stale)),
    ).toBe(true);

    const now = new Date("2026-08-17T12:00:00.000Z");
    const listed = await store.list("WALLETADDR", { now });
    expect(listed.map((run) => run.id)).toEqual(["spaces-fresh"]);
    expect(listed[0]).not.toHaveProperty("snapshot");
    expect(
      memory.objects.has(datedReviewKey("brownie", "WALLETADDR", stale)),
    ).toBe(true);
    expect(
      memory.objects.has(datedReviewKey("brownie", "WALLETADDR", fresh)),
    ).toBe(true);

    const deleted = await store.rotate("WALLETADDR", now);
    expect(deleted).toEqual([datedReviewKey("brownie", "WALLETADDR", stale)]);
    expect(
      memory.objects.has(datedReviewKey("brownie", "WALLETADDR", stale)),
    ).toBe(false);
    expect(
      memory.objects.has(datedReviewKey("brownie", "WALLETADDR", fresh)),
    ).toBe(true);
    expect(
      memory.objects.has("brownie/wallets/WALLETADDR/reviews/latest.json"),
    ).toBe(true);
    expect(REVIEW_HISTORY_RETENTION_DAYS).toBe(7);
  });
});
