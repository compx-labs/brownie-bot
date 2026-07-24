import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ReviewRun } from "../src/domain.js";
import {
  LocalFilesystemReviewRunStore,
  SpacesReviewRunStore,
} from "../src/integrations/storage/review-run-store.js";
import { portfolioPlan, portfolioSnapshot } from "./fixtures.js";

function sampleRun(overrides: Partial<ReviewRun> = {}): ReviewRun {
  return {
    id: "run-1",
    startedAt: "2026-07-13T09:00:00.000Z",
    completedAt: "2026-07-13T09:00:01.000Z",
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
          return Promise.reject(new Error(`Unexpected command ${name}`));
        },
      ),
    },
  };
}

describe("LocalFilesystemReviewRunStore", () => {
  it("round-trips latest review run", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "brownie-review-"));
    try {
      const store = new LocalFilesystemReviewRunStore({
        rootDir,
        prefix: "brownie",
      });
      const run = sampleRun();
      const key = await store.putLatest(run);
      expect(key).toBe("brownie/wallets/WALLETADDR/reviews/latest.json");
      await expect(store.getLatest("WALLETADDR")).resolves.toEqual(run);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("returns undefined for missing or corrupt latest.json", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "brownie-review-"));
    try {
      const store = new LocalFilesystemReviewRunStore({ rootDir });
      await expect(store.getLatest("MISSING")).resolves.toBeUndefined();

      await store.putLatest(sampleRun({ id: "bad" }));
      const filePath = join(
        rootDir,
        "wallets",
        "WALLETADDR",
        "reviews",
        "latest.json",
      );
      const { writeFile } = await import("node:fs/promises");
      await writeFile(filePath, '{"not":"a-review-run"}', "utf8");
      await expect(store.getLatest("WALLETADDR")).resolves.toBeUndefined();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

describe("SpacesReviewRunStore", () => {
  it("writes and reads latest review run", async () => {
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
    const key = await store.putLatest(run);
    expect(key).toBe("brownie/wallets/WALLETADDR/reviews/latest.json");
    expect(memory.objects.get(key)).toContain('"spaces-1"');
    await expect(store.getLatest("WALLETADDR")).resolves.toEqual(run);
  });
});
