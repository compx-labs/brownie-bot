import "dotenv/config";

import { z } from "zod";

import { parseEnv } from "./util/env-error.js";

export {
  ConfigError,
  ENV_DOCS_POINTER,
  formatEnvZodError,
  parseEnv,
} from "./util/env-error.js";

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

/** Preferred liquid/long-term hold: ASA id + soft target share of portfolio USD. */
export interface PreferredHoldAsset {
  assetId: number;
  targetPortfolioPct: number;
}

/**
 * Parse `PREFERRED_HOLD_ASSETS` as `assetId:targetPct` pairs.
 * Example: `246516580:15,31566704:5` → GOLD$ ~15%, USDC ~5% of portfolio.
 */
export function parsePreferredHoldAssets(
  raw: string | undefined,
): PreferredHoldAsset[] {
  if (!raw || raw.trim() === "") {
    return [];
  }
  const entries: PreferredHoldAsset[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const [idRaw, pctRaw] = trimmed.split(":");
    if (!idRaw || pctRaw === undefined) {
      throw new Error(
        `PREFERRED_HOLD_ASSETS entry ${JSON.stringify(trimmed)} must be assetId:targetPct`,
      );
    }
    const assetId = Number(idRaw.trim());
    const targetPortfolioPct = Number(pctRaw.trim());
    if (!Number.isInteger(assetId) || assetId < 0) {
      throw new Error(
        `PREFERRED_HOLD_ASSETS asset id must be a non-negative integer (got ${JSON.stringify(idRaw)})`,
      );
    }
    if (
      !Number.isFinite(targetPortfolioPct) ||
      targetPortfolioPct < 0 ||
      targetPortfolioPct > 100
    ) {
      throw new Error(
        `PREFERRED_HOLD_ASSETS targetPct must be 0–100 (got ${JSON.stringify(pctRaw)})`,
      );
    }
    entries.push({ assetId, targetPortfolioPct });
  }
  return entries;
}

const requiredEnvSchema = z.object({
  BOT_WALLET: z.string().min(1),
  WALLET_MNEMONIC: z.string().min(1),
});

const optionalEnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"]) // pragma: allowlist secret
    .default("development"), // pragma: allowlist secret
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  RUN_CRON: booleanFromString,
  CRON_SCHEDULE: z.string().min(1).default("0 9 * * *"), // pragma: allowlist secret
  CRON_TIMEZONE: z.string().min(1).default("UTC"),
  MANUAL_TRIGGER_TOKEN: optionalString(16),

  CANIX402_MCP_URL: z.url().default("https://canix402-mcp.compx.io/mcp"),
  X402_ALGOD_URL: z.url().default("https://mainnet-api.algonode.cloud"),
  /** Indexer for cashflow tx lookup (`/deposit` `/withdraw`). */
  X402_INDEXER_URL: z.url().default("https://mainnet-idx.algonode.cloud"),

  /** OpenAI-compatible base URL. Default is host-local zs-proxy. */
  OPENAI_BASE_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.url().default("http://127.0.0.1:8080/v1"), // pragma: allowlist secret
  ),
  /**
   * Placeholder for the OpenAI SDK (requires a non-empty string).
   * zs-proxy ignores the key; admission is the on-chain wallet seal.
   */
  OPEN_AI_API_KEY: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).default("zerosignal"), // pragma: allowlist secret
  ),
  OPENAI_MODEL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).default("glm-5.2"),
  ),
  OPENAI_REASONING_EFFORT: z.enum(["low", "medium", "high"]).default("medium"),
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
  /**
   * Display-only zs-proxy daily cap in USDC (matches zs-proxy
   * `spend.daily_cap_usdc` / `PROXY_SPEND_DAILY_CAP_USDC` by default).
   * `0` = show "uncapped". The bot does not enforce this cap.
   */
  MAX_DAILY_ZS_USDC: z.coerce.number().nonnegative().default(5),
  /**
   * Advisory `/health?deps=1` (and Telegram `/status`) spendable ALGO floor
   * in token units. `0` disables the ALGO check. Does not pause trading.
   */
  HEALTH_LOW_ALGO: z.coerce.number().nonnegative().default(1),
  /**
   * Advisory `/health?deps=1` (and Telegram `/status`) USDC floor in token
   * units (ASA `31566704`). `0` disables the USDC check. Does not pause trading.
   */
  HEALTH_LOW_USDC: z.coerce.number().nonnegative().default(1),
  MIN_PROJECTED_NET_IMPROVEMENT_USD: z.coerce.number().nonnegative().default(1),
  /**
   * Soft operator steer: comma-separated `assetId:targetPortfolioPct` pairs.
   * Example: `246516580:15` (hold ~15% GOLD$). Empty = no preferred holds.
   */
  PREFERRED_HOLD_ASSETS: optionalString(),
  TELEGRAM_BOT_TOKEN: optionalString(),
  TELEGRAM_CHAT_ID: optionalString(),

  ACCOUNTING_CRON_SCHEDULE: z.string().min(1).default("0 8 * * *"), // pragma: allowlist secret
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
});

/** App env keys with no default — process will not start without them. */
export const REQUIRED_ENV_KEYS = Object.keys(requiredEnvSchema.shape) as Array<
  keyof typeof requiredEnvSchema.shape
>;

/** App env keys that have defaults or may be omitted. */
export const OPTIONAL_ENV_KEYS = Object.keys(optionalEnvSchema.shape) as Array<
  keyof typeof optionalEnvSchema.shape
>;

/**
 * Docker entrypoint-only (not validated by `loadConfig`). Required when the
 * image uses the file keyring.
 */
export const DOCKER_REQUIRED_ENV_KEYS = [
  "ZEROSIGNAL_KEYSTORE_PASSPHRASE", // pragma: allowlist secret
] as const;

const configSchema = requiredEnvSchema
  .extend(optionalEnvSchema.shape)
  .superRefine((value, context) => {
    const telegramCount = [
      value.TELEGRAM_BOT_TOKEN,
      value.TELEGRAM_CHAT_ID,
    ].filter(Boolean).length;
    if (telegramCount === 1) {
      context.addIssue({
        code: "custom",
        message:
          "Optional env TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must both be set or both omitted",
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
          "Optional env DO_SPACES_ENDPOINT, DO_SPACES_BUCKET, DO_SPACES_KEY, and DO_SPACES_SECRET must all be set or all omitted",
      });
    }

    try {
      parsePreferredHoldAssets(value.PREFERRED_HOLD_ASSETS);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message:
          error instanceof Error
            ? error.message
            : "PREFERRED_HOLD_ASSETS is invalid",
      });
    }
  });

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = parseEnv(configSchema, environment, REQUIRED_ENV_KEYS);
  return {
    ...parsed,
    preferredHoldAssets: parsePreferredHoldAssets(parsed.PREFERRED_HOLD_ASSETS),
  };
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
