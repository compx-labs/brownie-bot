import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ConfigError,
  DOCKER_REQUIRED_ENV_KEYS,
  ENV_DOCS_POINTER,
  loadConfig,
  OPTIONAL_ENV_KEYS,
  REQUIRED_ENV_KEYS,
} from "../src/config.js";
import {
  loadGeneralCliConfig,
  loadPersonalizedCliConfig,
  loadProtocolVerifyConfig,
} from "../src/cli/config.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadThrownError(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error(`Expected Error, received ${typeof error}`, {
      cause: error,
    });
  }
  throw new Error("Expected loadConfig to throw");
}

function envKeysFromExample(text: string): {
  required: string[];
  dockerRequired: string[];
  optional: string[];
} {
  const sections = {
    required: [] as string[],
    dockerRequired: [] as string[],
    optional: [] as string[],
  };
  let bucket: keyof typeof sections | undefined;
  for (const line of text.split("\n")) {
    const header = /^# === (.+) ===/.exec(line);
    if (header) {
      const name = header[1] ?? "";
      if (name === "Required") {
        bucket = "required";
      } else if (name.startsWith("Required for Docker")) {
        bucket = "dockerRequired";
      } else if (name.startsWith("Optional")) {
        bucket = "optional";
      } else {
        bucket = undefined;
      }
      continue;
    }
    const key = /^#?\s*([A-Z][A-Z0-9_]+)=/.exec(line);
    if (key?.[1] && bucket) {
      sections[bucket].push(key[1]);
    }
  }
  return sections;
}

function envKeysFromReadme(text: string): {
  required: string[];
  optional: string[];
} {
  const start = text.indexOf("## Environment variables");
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start);
  const next = rest.indexOf("\n## ", 3);
  const section = next === -1 ? rest : rest.slice(0, next);
  const requiredHeading = section.indexOf("### Required");
  const optionalHeading = section.indexOf("### Optional");
  expect(requiredHeading).toBeGreaterThanOrEqual(0);
  expect(optionalHeading).toBeGreaterThan(requiredHeading);
  const requiredBlock = section.slice(requiredHeading, optionalHeading);
  const optionalBlock = section.slice(optionalHeading);
  const keys = (block: string) =>
    [...block.matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((match) => match[1] ?? "");
  return {
    required: keys(requiredBlock),
    optional: keys(optionalBlock),
  };
}

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
  };

  it("uses fixed Canix402 and ZeroSignal defaults", () => {
    const config = loadConfig(requiredEnvironment);
    expect(config.CANIX402_MCP_URL).toBe("https://canix402-mcp.compx.io/mcp");
    expect(config.X402_ALGOD_URL).toBe("https://mainnet-api.algonode.cloud");
    expect(config.X402_INDEXER_URL).toBe("https://mainnet-idx.algonode.cloud");
    expect(config.OPENAI_BASE_URL).toBe("http://127.0.0.1:8080/v1");
    expect(config.OPEN_AI_API_KEY).toBe("zerosignal");
    expect(config.OPENAI_MODEL).toBe("glm-5.2");
    expect(config.OPENAI_REASONING_EFFORT).toBe("medium");
    expect(config.AI_MODE).toBe("full");
    expect(config.AI_MAX_TOOL_CALLS).toBe(16);
    expect(config.ENABLE_TRANSACTION_SIGNING).toBe(false);
    expect(config.DO_SPACES_PREFIX).toBe("brownie-bot");
    expect(config.ACCOUNTING_CRON_SCHEDULE).toBe("0 8 * * *");
    expect(config.ACCOUNTING_DATA_DIR).toBe("data/accounting");
    expect(config.MAX_DAILY_X402_BASE_UNITS).toBe(5_000_000);
    expect(config.MAX_DAILY_ZS_USDC).toBe(5);
    expect(config.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(config.DO_SPACES_BUCKET).toBeUndefined();
  });

  it("accepts MAX_DAILY_ZS_USDC=0 for uncapped display", () => {
    const config = loadConfig({
      ...requiredEnvironment,
      MAX_DAILY_ZS_USDC: "0",
    });
    expect(config.MAX_DAILY_ZS_USDC).toBe(0);
  });

  it("does not require an OpenAI API key when using zs-proxy defaults", () => {
    const config = loadConfig({ ...walletEnvironment });
    expect(config.OPEN_AI_API_KEY).toBe("zerosignal");
    expect(config.OPENAI_BASE_URL).toBe("http://127.0.0.1:8080/v1");
  });

  it("accepts an explicit ZeroSignal base URL and model", () => {
    const config = loadConfig({
      ...walletEnvironment,
      OPENAI_BASE_URL: "http://127.0.0.1:9090/v1",
      OPENAI_MODEL: "glm-5.2",
      OPEN_AI_API_KEY: "not-checked",
    });
    expect(config.OPENAI_BASE_URL).toBe("http://127.0.0.1:9090/v1");
    expect(config.OPEN_AI_API_KEY).toBe("not-checked");
    expect(config.OPENAI_MODEL).toBe("glm-5.2");
  });

  it("requires both wallet identity and signer with a one-line human message", () => {
    const missingWallet = loadThrownError(() =>
      loadConfig({
        WALLET_MNEMONIC: "test mnemonic",
      }),
    );
    expect(missingWallet).toBeInstanceOf(ConfigError);
    expect(missingWallet.message).toBe(
      `Missing required env BOT_WALLET. See ${ENV_DOCS_POINTER}.`,
    );
    expect(missingWallet.message).not.toContain("\n");
    expect(missingWallet.message).not.toMatch(/^\s*\[/);

    const missingMnemonic = loadThrownError(() =>
      loadConfig({
        BOT_WALLET: walletEnvironment.BOT_WALLET,
      }),
    );
    expect(missingMnemonic.message).toBe(
      `Missing required env WALLET_MNEMONIC. See ${ENV_DOCS_POINTER}.`,
    );

    const missingBoth = loadThrownError(() => loadConfig({}));
    expect(missingBoth.message).toBe(
      `Missing required env BOT_WALLET and WALLET_MNEMONIC. See ${ENV_DOCS_POINTER}.`,
    );

    const emptyMnemonic = loadThrownError(() =>
      loadConfig({
        BOT_WALLET: walletEnvironment.BOT_WALLET,
        WALLET_MNEMONIC: "",
      }),
    );
    expect(emptyMnemonic.message).toBe(
      `Missing required env WALLET_MNEMONIC. See ${ENV_DOCS_POINTER}.`,
    );
  });

  it("allows omitting Telegram credentials", () => {
    const config = loadConfig(requiredEnvironment);
    expect(config.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(config.TELEGRAM_CHAT_ID).toBeUndefined();
  });

  it("rejects partial Telegram credentials", () => {
    const error = loadThrownError(() =>
      loadConfig({
        ...requiredEnvironment,
        TELEGRAM_BOT_TOKEN: "token",
      }),
    );
    expect(error.message).toMatch(/Optional env TELEGRAM_BOT_TOKEN/);
    expect(error.message).toContain(ENV_DOCS_POINTER);
    expect(error.message).not.toContain("\n");
  });

  it("allows omitting Spaces credentials", () => {
    const config = loadConfig(requiredEnvironment);
    expect(config.DO_SPACES_ENDPOINT).toBeUndefined();
    expect(config.DO_SPACES_BUCKET).toBeUndefined();
  });

  it("rejects partial Spaces credentials", () => {
    const error = loadThrownError(() =>
      loadConfig({
        ...requiredEnvironment,
        DO_SPACES_ENDPOINT: "https://nyc3.digitaloceanspaces.com",
        DO_SPACES_BUCKET: "bucket",
      }),
    );
    expect(error.message).toMatch(/Optional env DO_SPACES_ENDPOINT/);
    expect(error.message).toContain(ENV_DOCS_POINTER);
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

  it("defaults preferredHoldAssets to empty and parses PREFERRED_HOLD_ASSETS", () => {
    expect(loadConfig(requiredEnvironment).preferredHoldAssets).toEqual([]);

    const config = loadConfig({
      ...requiredEnvironment,
      PREFERRED_HOLD_ASSETS: "246516580:15, 31566704:5",
    });
    expect(config.preferredHoldAssets).toEqual([
      { assetId: 246_516_580, targetPortfolioPct: 15 },
      { assetId: 31_566_704, targetPortfolioPct: 5 },
    ]);
  });

  it("rejects malformed PREFERRED_HOLD_ASSETS", () => {
    expect(() =>
      loadConfig({
        ...requiredEnvironment,
        PREFERRED_HOLD_ASSETS: "246516580",
      }),
    ).toThrow(/PREFERRED_HOLD_ASSETS/);
    expect(() =>
      loadConfig({
        ...requiredEnvironment,
        PREFERRED_HOLD_ASSETS: "246516580:150",
      }),
    ).toThrow(/0–100/);
  });

  it.each([
    { key: "PORT", value: "nope" },
    { key: "PORT", value: "0" },
    { key: "AI_MAX_TOOL_CALLS", value: "2" },
    { key: "MAX_POSITION_PCT", value: "0" },
    { key: "MANUAL_TRIGGER_TOKEN", value: "short" },
  ])(
    "names invalid optional env $key=$value without dumping a Zod tree",
    ({ key, value }) => {
      const error = loadThrownError(() =>
        loadConfig({
          ...requiredEnvironment,
          [key]: value,
        }),
      );
      expect(error).toBeInstanceOf(ConfigError);
      expect(error.message).toMatch(
        new RegExp(`^Optional env ${key} is invalid`),
      );
      expect(error.message).not.toMatch(/missing/i);
      expect(error.message).toContain(ENV_DOCS_POINTER);
      expect(error.message).not.toContain("\n");
      expect(error.message).not.toMatch(/invalid_type|too_small|too_big/);
    },
  );
});

describe("CLI env errors", () => {
  it("fails with a one-line message when WALLET_MNEMONIC is missing", () => {
    const error = loadThrownError(() => loadGeneralCliConfig({}));
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toBe(
      `Missing required env WALLET_MNEMONIC. See ${ENV_DOCS_POINTER}.`,
    );
  });

  it("names BOT_WALLET when the personalized CLI wallet is missing", () => {
    const error = loadThrownError(() =>
      loadPersonalizedCliConfig({ WALLET_MNEMONIC: "test mnemonic" }),
    );
    expect(error.message).toBe(
      `Missing required env BOT_WALLET. See ${ENV_DOCS_POINTER}.`,
    );
  });

  it("names TEST_MNEMONIC for protocol-verify config", () => {
    const error = loadThrownError(() =>
      loadProtocolVerifyConfig({
        TEST_WALLET:
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ",
      }),
    );
    expect(error.message).toBe(
      `Missing required env TEST_MNEMONIC. See ${ENV_DOCS_POINTER}.`,
    );
  });
});

describe("env docs agreement", () => {
  const example = readFileSync(join(repoRoot, ".env.example"), "utf8");
  const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
  const exampleKeys = envKeysFromExample(example);

  it("lists the same required vs optional keys in .env.example as the Zod schema", () => {
    expect(exampleKeys.required.sort()).toEqual([...REQUIRED_ENV_KEYS].sort());
    expect(exampleKeys.dockerRequired.sort()).toEqual(
      [...DOCKER_REQUIRED_ENV_KEYS].sort(),
    );
    for (const key of OPTIONAL_ENV_KEYS) {
      expect(exampleKeys.optional).toContain(key);
    }
    for (const key of exampleKeys.required) {
      expect(exampleKeys.optional).not.toContain(key);
    }
  });

  it("keeps README environment tables in agreement with the schema", () => {
    const readmeKeys = envKeysFromReadme(readme);
    expect(readmeKeys.required).toEqual(
      expect.arrayContaining([...REQUIRED_ENV_KEYS]),
    );
    expect(readmeKeys.required).toEqual(
      expect.arrayContaining([...DOCKER_REQUIRED_ENV_KEYS]),
    );
    for (const key of OPTIONAL_ENV_KEYS) {
      expect(readmeKeys.optional).toContain(key);
    }
    expect(readme).toContain("## Ops troubleshooting");
    expect(readme).toMatch(/zs-proxy/i);
    expect(readme).toMatch(/Canix/i);
    expect(readme).toMatch(/Algod/i);
    expect(readme).toMatch(/mnemonic/i);
    expect(readme).toMatch(/long-poll/i);
  });
});
