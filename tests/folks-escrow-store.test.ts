import algosdk from "algosdk";
import { describe, expect, it, vi } from "vitest";

import { SpacesFolksEscrowStore } from "../src/integrations/algorand/folks-escrow-store.js";

describe("SpacesFolksEscrowStore", () => {
  it("reads and writes escrow records under the wallet prefix", async () => {
    const wallet =
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ";
    const escrowAddress = algosdk.generateAccount().addr.toString();
    const sends: Array<{ Key?: string; Body?: string }> = [];
    const client = {
      send: vi.fn(async (command: { input: Record<string, unknown> }) => {
        const name = command.constructor.name;
        if (name === "GetObjectCommand") {
          const key = command.input.Key as string;
          const match = sends.find((item) => item.Key === key);
          if (!match?.Body) {
            const error = new Error("missing") as Error & {
              name: string;
              $metadata: { httpStatusCode: number };
            };
            error.name = "NoSuchKey";
            error.$metadata = { httpStatusCode: 404 };
            throw error;
          }
          return {
            Body: {
              transformToString: async () => match.Body,
            },
          };
        }
        if (name === "PutObjectCommand") {
          sends.push({
            Key: command.input.Key as string,
            Body: command.input.Body as string,
          });
          return {};
        }
        throw new Error(`unexpected command ${name}`);
      }),
    };

    const store = new SpacesFolksEscrowStore({
      endpoint: "https://example.digitaloceanspaces.com",
      region: "lon1",
      bucket: "brownie",
      accessKeyId: "key",
      secretAccessKey: "secret",
      prefix: "brownie-bot",
      client: client as never,
    });

    expect(await store.get(wallet, 971_372_237)).toBeUndefined();

    const saved = await store.save({
      walletAddress: wallet,
      poolAppId: 971_372_237,
      depositsAppId: 971_353_536,
      escrowAddress,
      escrowPrivateKeyBase64: Buffer.alloc(64, 7).toString("base64"),
    });

    expect(sends[0]?.Key).toBe(
      `brownie-bot/wallets/${wallet}/folks-escrows/971372237.json`,
    );
    expect(saved.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const loaded = await store.get(wallet, 971_372_237);
    expect(loaded?.escrowAddress).toBe(saved.escrowAddress);
    expect(loaded?.escrowPrivateKeyBase64).toBe(saved.escrowPrivateKeyBase64);
  });
});
