import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  const walletEnvironment = {
    BOT_WALLET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ",
    WALLET_MNEMONIC: "test mnemonic",
  };
  const requiredEnvironment = {
    ...walletEnvironment,
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
  });

  it("requires an OpenAI API key", () => {
    expect(() =>
      loadConfig({
        ...walletEnvironment,
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_CHAT_ID: "chat",
      }),
    ).toThrow(/OPEN_AI_API_KEY/);
  });

  it("requires both wallet identity and signer", () => {
    expect(() =>
      loadConfig({
        WALLET_MNEMONIC: "test mnemonic",
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_CHAT_ID: "chat",
      }),
    ).toThrow(/BOT_WALLET/);
    expect(() =>
      loadConfig({
        BOT_WALLET: walletEnvironment.BOT_WALLET,
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_CHAT_ID: "chat",
      }),
    ).toThrow(/WALLET_MNEMONIC/);
  });

  it("requires complete Telegram credentials", () => {
    expect(() =>
      loadConfig({
        ...walletEnvironment,
        TELEGRAM_BOT_TOKEN: "token",
      }),
    ).toThrow(/TELEGRAM_CHAT_ID/);
  });
});
