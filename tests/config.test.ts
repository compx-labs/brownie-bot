import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  const walletEnvironment = {
    BOT_WALLET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ",
    WALLET_MNEMONIC: "test mnemonic",
  };
  const spacesEnvironment = {
    DO_SPACES_ENDPOINT: "https://nyc3.digitaloceanspaces.com",
    DO_SPACES_BUCKET: "bucket",
    DO_SPACES_KEY: "key",
    DO_SPACES_SECRET: "secret",
  };
  const requiredEnvironment = {
    ...walletEnvironment,
    ...spacesEnvironment,
    OPEN_AI_API_KEY: "test-openai-key",
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_CHAT_ID: "chat",
  };

  it("uses fixed Canix402 infrastructure defaults", () => {
    const config = loadConfig(requiredEnvironment);
    expect(config.CANIX402_MCP_URL).toBe("https://canix402-mcp.compx.io/mcp");
    expect(config.X402_ALGOD_URL).toBe("https://mainnet-api.algonode.cloud");
    expect(config.OPENAI_MODEL).toBe("gpt-5.6-luna");
    expect(config.OPENAI_REASONING_EFFORT).toBe("medium");
    expect(config.AI_MAX_TOOL_CALLS).toBe(16);
    expect(config.ENABLE_TRANSACTION_SIGNING).toBe(false);
    expect(config.DO_SPACES_PREFIX).toBe("brownie-bot");
    expect(config.ACCOUNTING_CRON_SCHEDULE).toBe("0 8 * * *");
  });

  it("requires an OpenAI API key", () => {
    expect(() =>
      loadConfig({
        ...walletEnvironment,
        ...spacesEnvironment,
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_CHAT_ID: "chat",
      }),
    ).toThrow(/OPEN_AI_API_KEY/);
  });

  it("requires both wallet identity and signer", () => {
    expect(() =>
      loadConfig({
        ...spacesEnvironment,
        WALLET_MNEMONIC: "test mnemonic",
        OPEN_AI_API_KEY: "test-openai-key",
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_CHAT_ID: "chat",
      }),
    ).toThrow(/BOT_WALLET/);
    expect(() =>
      loadConfig({
        ...spacesEnvironment,
        BOT_WALLET: walletEnvironment.BOT_WALLET,
        OPEN_AI_API_KEY: "test-openai-key",
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_CHAT_ID: "chat",
      }),
    ).toThrow(/WALLET_MNEMONIC/);
  });

  it("requires complete Telegram credentials", () => {
    expect(() =>
      loadConfig({
        ...walletEnvironment,
        ...spacesEnvironment,
        TELEGRAM_BOT_TOKEN: "token",
        OPEN_AI_API_KEY: "test-openai-key",
      }),
    ).toThrow(/TELEGRAM_CHAT_ID/);
  });

  it("requires Spaces credentials", () => {
    expect(() =>
      loadConfig({
        ...walletEnvironment,
        OPEN_AI_API_KEY: "test-openai-key",
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_CHAT_ID: "chat",
      }),
    ).toThrow(/DO_SPACES_ENDPOINT/);
  });
});
