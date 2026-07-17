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

const configSchema = z.object({
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

  OPEN_AI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().min(1).default("gpt-5.6-luna"),
  OPENAI_REASONING_EFFORT: z.enum(["low", "medium", "high"]).default("medium"),
  AI_MAX_TOOL_CALLS: z.coerce.number().int().min(3).max(50).default(16),
  ENABLE_TRANSACTION_SIGNING: booleanFromString,
  MAX_POSITION_PCT: z.coerce.number().positive().max(100).default(35),
  MAX_PROTOCOL_PCT: z.coerce.number().positive().max(100).default(50),
  MIN_LIQUID_RESERVE_PCT: z.coerce.number().min(0).max(100).default(10),
  MIN_TVL_USD: z.coerce.number().nonnegative().default(100_000),
  MAX_SOURCE_AGE_HOURS: z.coerce.number().positive().default(24),
  MAX_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(10_000).default(100),
  MAX_PRICE_IMPACT_PCT: z.coerce.number().min(0).max(100).default(3),
  MAX_DAILY_X402_BASE_UNITS: z.coerce
    .number()
    .int()
    .positive()
    .default(500_000),
  MIN_PROJECTED_NET_IMPROVEMENT_USD: z.coerce.number().nonnegative().default(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHAT_ID: z.string().min(1),

  ACCOUNTING_CRON_SCHEDULE: z.string().min(1).default("0 8 * * *"),
  ACCOUNTING_CRON_TIMEZONE: z.string().min(1).default("UTC"),
  DO_SPACES_ENDPOINT: z.url(),
  DO_SPACES_REGION: z.string().min(1).default("nyc3"),
  DO_SPACES_BUCKET: z.string().min(1),
  DO_SPACES_KEY: z.string().min(1),
  DO_SPACES_SECRET: z.string().min(1),
  DO_SPACES_PREFIX: z.string().min(1).default("brownie-bot"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  return configSchema.parse(environment);
}
