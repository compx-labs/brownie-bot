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
    OPEN_AI_API_KEY: "test-openai-key",
  };

  afterEach(async () => {
    await context?.app.close();
    context = undefined;
  });

  it("reports safe configuration state without optional integrations", async () => {
    context = createApp(loadConfig(environment));
    const response = await context.app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      mode: "autonomous",
      signingEnabled: false,
      walletConfigured: true,
      telegramConfigured: false,
      accountingEnabled: true,
      accountingStorage: "local",
    });
  });

  it("reports Telegram and Spaces when configured", async () => {
    context = createApp(
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
    context = createApp(loadConfig(environment));
    const response = await context.app.inject({
      method: "POST",
      url: "/runs",
    });
    expect(response.statusCode).toBe(404);
  });

  it("allows a separate x402 payer only while execution signing is disabled", async () => {
    const differentTreasury = algosdk.generateAccount().addr.toString();
    context = createApp(
      loadConfig({ ...environment, BOT_WALLET: differentTreasury }),
    );
    await context.app.ready();
    expect(context).toBeDefined();
    await context.app.close();
    context = undefined;

    expect(() =>
      createApp(
        loadConfig({
          ...environment,
          BOT_WALLET: differentTreasury,
          ENABLE_TRANSACTION_SIGNING: "true",
        }),
      ),
    ).toThrow(/BOT_WALLET must match WALLET_MNEMONIC/);
  });
});
