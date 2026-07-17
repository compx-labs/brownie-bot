import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AccountingCashflow, AccountingSnapshot } from "../src/domain.js";
import {
  canonicalChecksum,
  LocalFilesystemAccountingStore,
  SpacesAccountingStore,
} from "../src/integrations/storage/accounting-store.js";

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
          return Promise.reject(new Error(`Unexpected command ${name}`));
        },
      ),
    },
  };
}

describe("SpacesAccountingStore", () => {
  it("writes immutable snapshots and rejects conflicts", async () => {
    const memory = createMemoryS3();
    const store = new SpacesAccountingStore({
      endpoint: "https://nyc3.digitaloceanspaces.com",
      region: "nyc3",
      bucket: "bucket",
      accessKeyId: "key",
      secretAccessKey: "secret",
      prefix: "brownie",
      client: memory.client as never,
    });

    const body = {
      schemaVersion: 2 as const,
      id: "run-1",
      walletAddress: "WALLET",
      asOf: "2026-07-16T08:00:00.000Z",
      fetchedAt: "2026-07-16T08:00:00.000Z",
      defiByProtocol: [],
      defiValueUsd: "0",
      walletAsaValueUsd: "10",
      unpricedAssetIds: [],
      algoBalance: "1",
      algoBalanceRaw: "1000000",
      minimumBalance: "0.1",
      minimumBalanceRaw: "100000",
      totalValueUsd: "10",
      notes: [],
      prices: [],
    };
    const snapshot: AccountingSnapshot = {
      ...body,
      checksum: canonicalChecksum(body),
    };

    const key = await store.putSnapshot(snapshot);
    expect(key).toBe("brownie/wallets/WALLET/snapshots/2026/07/16/run-1.json");
    await expect(store.putSnapshot(snapshot)).rejects.toThrow(/already exists/);
  });

  it("accepts idempotent cashflows and rejects checksum conflicts", async () => {
    const memory = createMemoryS3();
    const store = new SpacesAccountingStore({
      endpoint: "https://nyc3.digitaloceanspaces.com",
      region: "nyc3",
      bucket: "bucket",
      accessKeyId: "key",
      secretAccessKey: "secret",
      client: memory.client as never,
    });
    const cashflowBody = {
      schemaVersion: 1 as const,
      eventId: "evt-1",
      walletAddress: "WALLET",
      type: "external_deposit" as const,
      amountUsd: "5",
      occurredAt: "2026-07-16T01:00:00.000Z",
      recordedAt: "2026-07-16T01:00:00.000Z",
    };
    const cashflow: AccountingCashflow = {
      ...cashflowBody,
      checksum: canonicalChecksum(cashflowBody),
    };

    await store.putCashflow(cashflow);
    await expect(store.putCashflow(cashflow)).resolves.toContain("evt-1.json");
    await expect(
      store.putCashflow({ ...cashflow, checksum: "different" }),
    ).rejects.toThrow(/Conflicting cashflow/);
  });

  it("lists cashflows in a time window", async () => {
    const memory = createMemoryS3();
    const store = new SpacesAccountingStore({
      endpoint: "https://nyc3.digitaloceanspaces.com",
      region: "nyc3",
      bucket: "bucket",
      accessKeyId: "key",
      secretAccessKey: "secret",
      client: memory.client as never,
    });
    const make = (eventId: string, occurredAt: string): AccountingCashflow => {
      const body = {
        schemaVersion: 1 as const,
        eventId,
        walletAddress: "WALLET",
        type: "external_deposit" as const,
        amountUsd: "1",
        occurredAt,
        recordedAt: occurredAt,
      };
      return { ...body, checksum: canonicalChecksum(body) };
    };
    await store.putCashflow(make("a", "2026-07-15T23:00:00.000Z"));
    await store.putCashflow(make("b", "2026-07-16T01:00:00.000Z"));
    await store.putCashflow(make("c", "2026-07-17T00:00:00.000Z"));

    const listed = await store.listCashflows(
      "WALLET",
      "2026-07-16T00:00:00.000Z",
      "2026-07-17T00:00:00.000Z",
    );
    expect(listed.map((item) => item.eventId)).toEqual(["b"]);
  });
});

describe("LocalFilesystemAccountingStore", () => {
  it("writes immutable snapshots under the local data directory", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "brownie-accounting-"));
    try {
      const store = new LocalFilesystemAccountingStore({
        rootDir,
        prefix: "brownie",
      });
      const body = {
        schemaVersion: 2 as const,
        id: "run-1",
        walletAddress: "WALLET",
        asOf: "2026-07-16T08:00:00.000Z",
        fetchedAt: "2026-07-16T08:00:00.000Z",
        defiByProtocol: [],
        defiValueUsd: "0",
        walletAsaValueUsd: "10",
        unpricedAssetIds: [],
        algoBalance: "1",
        algoBalanceRaw: "1000000",
        minimumBalance: "0.1",
        minimumBalanceRaw: "100000",
        totalValueUsd: "10",
        notes: [],
        prices: [],
      };
      const snapshot: AccountingSnapshot = {
        ...body,
        checksum: canonicalChecksum(body),
      };

      const key = await store.putSnapshot(snapshot);
      expect(key).toBe(
        "brownie/wallets/WALLET/snapshots/2026/07/16/run-1.json",
      );
      await expect(store.putSnapshot(snapshot)).rejects.toThrow(
        /already exists/,
      );
      const listed = await store.listSnapshots("WALLET", 2026, 7);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.id).toBe("run-1");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
