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
    OPEN_AI_API_KEY: "test-openai-key",
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
    expect(config.ACCOUNTING_DATA_DIR).toBe("data/accounting");
    expect(config.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(config.DO_SPACES_BUCKET).toBeUndefined();
  });

  it("requires an OpenAI API key", () => {
    expect(() => loadConfig({ ...walletEnvironment })).toThrow(
      /OPEN_AI_API_KEY/,
    );
  });

  it("requires both wallet identity and signer", () => {
    expect(() =>
      loadConfig({
        WALLET_MNEMONIC: "test mnemonic",
        OPEN_AI_API_KEY: "test-openai-key",
      }),
    ).toThrow(/BOT_WALLET/);
    expect(() =>
      loadConfig({
        BOT_WALLET: walletEnvironment.BOT_WALLET,
        OPEN_AI_API_KEY: "test-openai-key",
      }),
    ).toThrow(/WALLET_MNEMONIC/);
  });

  it("allows omitting Telegram credentials", () => {
    const config = loadConfig(requiredEnvironment);
    expect(config.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(config.TELEGRAM_CHAT_ID).toBeUndefined();
  });

  it("rejects partial Telegram credentials", () => {
    expect(() =>
      loadConfig({
        ...requiredEnvironment,
        TELEGRAM_BOT_TOKEN: "token",
      }),
    ).toThrow(/TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID/);
  });

  it("allows omitting Spaces credentials", () => {
    const config = loadConfig(requiredEnvironment);
    expect(config.DO_SPACES_ENDPOINT).toBeUndefined();
    expect(config.DO_SPACES_BUCKET).toBeUndefined();
  });

  it("rejects partial Spaces credentials", () => {
    expect(() =>
      loadConfig({
        ...requiredEnvironment,
        DO_SPACES_ENDPOINT: "https://nyc3.digitaloceanspaces.com",
        DO_SPACES_BUCKET: "bucket",
      }),
    ).toThrow(/DO_SPACES_ENDPOINT, DO_SPACES_BUCKET/);
  });

  it("accepts complete Telegram and Spaces credentials together", () => {
    const config = loadConfig({
      ...requiredEnvironment,
      ...spacesEnvironment,
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_CHAT_ID: "chat",
    });
    expect(config.TELEGRAM_BOT_TOKEN).toBe("token");
    expect(config.DO_SPACES_BUCKET).toBe("bucket");
  });
});
