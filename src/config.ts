import "dotenv/config";

import { z } from "zod";

const booleanFromString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const optionalString = (minimumLength = 1) =>
  z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(minimumLength).optional(),
  );

const optionalUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.url().optional(),
);

const configSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    RUN_CRON: booleanFromString,
    CRON_SCHEDULE: z.string().min(1).default("0 9 * * *"),
    CRON_TIMEZONE: z.string().min(1).default("UTC"),
    MANUAL_TRIGGER_TOKEN: optionalString(16),

    CANIX402_MCP_URL: z.url().default("https://canix402-mcp.compx.io/mcp"),
    BOT_WALLET: z.string().min(1),
    WALLET_MNEMONIC: z.string().min(1),
    X402_ALGOD_URL: z.url().default("https://mainnet-api.algonode.cloud"),

    /** OpenAI-compatible base URL. Default is host-local ZeroSignal zs-proxy. */
    OPENAI_BASE_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.url().default("http://127.0.0.1:8080/v1"),
    ),
    /**
     * Placeholder for the OpenAI SDK (requires a non-empty string).
     * zs-proxy ignores the key; admission is the on-chain wallet seal.
     */
    OPEN_AI_API_KEY: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(1).default("zerosignal"),
    ),
    OPENAI_MODEL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(1).default("Qwen/Qwen3-Coder-480B-A35B-Instruct"),
    ),
    OPENAI_REASONING_EFFORT: z
      .enum(["low", "medium", "high"])
      .default("medium"),
    /**
     * `full` — LLM drives Canix research via a multi-turn tool loop.
     * `lite` — host prefetches research; LLM decides once with tools disabled.
     */
    AI_MODE: z.enum(["full", "lite"]).default("full"),
    AI_MAX_TOOL_CALLS: z.coerce.number().int().min(3).max(50).default(16),
    ENABLE_TRANSACTION_SIGNING: booleanFromString,
    MAX_POSITION_PCT: z.coerce.number().positive().max(100).default(35),
    MAX_PROTOCOL_PCT: z.coerce.number().positive().max(100).default(50),
    MIN_LIQUID_RESERVE_PCT: z.coerce.number().min(0).max(100).default(10),
    MIN_TVL_USD: z.coerce.number().nonnegative().default(6_000),
    MAX_SOURCE_AGE_HOURS: z.coerce.number().positive().default(24),
    MAX_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(10_000).default(100),
    MAX_PRICE_IMPACT_PCT: z.coerce.number().min(0).max(100).default(3),
    MAX_DAILY_X402_BASE_UNITS: z.coerce
      .number()
      .int()
      .positive()
      .default(5_000_000),
    MIN_PROJECTED_NET_IMPROVEMENT_USD: z.coerce
      .number()
      .nonnegative()
      .default(1),
    TELEGRAM_BOT_TOKEN: optionalString(),
    TELEGRAM_CHAT_ID: optionalString(),

    ACCOUNTING_CRON_SCHEDULE: z.string().min(1).default("0 8 * * *"),
    ACCOUNTING_CRON_TIMEZONE: z.string().min(1).default("UTC"),
    /** Local JSON root when DigitalOcean Spaces is not configured. */
    ACCOUNTING_DATA_DIR: z.string().min(1).default("data/accounting"),
    /** Persisted Folks deposit escrow address + signing key (mode 0600 files). */
    FOLKS_ESCROW_DATA_DIR: z.string().min(1).default("data/folks-escrows"),
    DO_SPACES_ENDPOINT: optionalUrl,
    DO_SPACES_REGION: z.string().min(1).default("nyc3"),
    DO_SPACES_BUCKET: optionalString(),
    DO_SPACES_KEY: optionalString(),
    DO_SPACES_SECRET: optionalString(),
    DO_SPACES_PREFIX: z.string().min(1).default("brownie-bot"),
  })
  .superRefine((value, context) => {
    const telegramCount = [
      value.TELEGRAM_BOT_TOKEN,
      value.TELEGRAM_CHAT_ID,
    ].filter(Boolean).length;
    if (telegramCount === 1) {
      context.addIssue({
        code: "custom",
        message:
          "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must both be set or both omitted",
      });
    }

    const spacesCount = [
      value.DO_SPACES_ENDPOINT,
      value.DO_SPACES_BUCKET,
      value.DO_SPACES_KEY,
      value.DO_SPACES_SECRET,
    ].filter(Boolean).length;
    if (spacesCount > 0 && spacesCount < 4) {
      context.addIssue({
        code: "custom",
        message:
          "DO_SPACES_ENDPOINT, DO_SPACES_BUCKET, DO_SPACES_KEY, and DO_SPACES_SECRET must all be set or all omitted",
      });
    }
  });

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  return configSchema.parse(environment);
}

export function isTelegramConfigured(config: AppConfig): boolean {
  return Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID);
}

export function isSpacesConfigured(config: AppConfig): boolean {
  return Boolean(
    config.DO_SPACES_ENDPOINT &&
    config.DO_SPACES_BUCKET &&
    config.DO_SPACES_KEY &&
    config.DO_SPACES_SECRET,
  );
}

export function requireTelegramCredentials(config: AppConfig): {
  botToken: string;
  chatId: string;
} {
  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) {
    throw new Error("Telegram is not configured");
  }
  return {
    botToken: config.TELEGRAM_BOT_TOKEN,
    chatId: config.TELEGRAM_CHAT_ID,
  };
}

export function requireSpacesCredentials(config: AppConfig): {
  endpoint: string;
  bucket: string;
  key: string;
  secret: string;
} {
  if (
    !config.DO_SPACES_ENDPOINT ||
    !config.DO_SPACES_BUCKET ||
    !config.DO_SPACES_KEY ||
    !config.DO_SPACES_SECRET
  ) {
    throw new Error("DigitalOcean Spaces is not configured");
  }
  return {
    endpoint: config.DO_SPACES_ENDPOINT,
    bucket: config.DO_SPACES_BUCKET,
    key: config.DO_SPACES_KEY,
    secret: config.DO_SPACES_SECRET,
  };
}
