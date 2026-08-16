import "dotenv/config";

import algosdk from "algosdk";
import { z } from "zod";

import { walletFromMnemonic } from "../integrations/canix402/wallet.js";
import { parseEnv } from "../util/env-error.js";

const baseCliConfigSchema = z.object({
  CANIX402_MCP_URL: z.url().default("https://canix402-mcp.compx.io/mcp"),
  WALLET_MNEMONIC: z.string().min(1),
  X402_ALGOD_URL: z.url().default("https://mainnet-api.algonode.cloud"),
});

const botWalletSchema = z
  .string()
  .refine(algosdk.isValidAddress, "BOT_WALLET is not a valid Algorand address");

const testWalletSchema = z
  .string()
  .refine(
    algosdk.isValidAddress,
    "TEST_WALLET is not a valid Algorand address",
  );

export function loadGeneralCliConfig(
  environment: NodeJS.ProcessEnv = process.env,
) {
  return parseEnv(baseCliConfigSchema, environment, ["WALLET_MNEMONIC"]);
}

export function loadPersonalizedCliConfig(
  environment: NodeJS.ProcessEnv = process.env,
) {
  return parseEnv(
    baseCliConfigSchema.extend({ BOT_WALLET: botWalletSchema }),
    environment,
    ["WALLET_MNEMONIC", "BOT_WALLET"],
  );
}

export function loadWalletScanCliConfig(
  environment: NodeJS.ProcessEnv = process.env,
) {
  return parseEnv(
    baseCliConfigSchema.extend({
      BOT_WALLET: botWalletSchema,
      MAX_SOURCE_AGE_HOURS: z.coerce.number().positive().default(24),
    }),
    environment,
    ["WALLET_MNEMONIC", "BOT_WALLET"],
  );
}

/**
 * Dedicated wallet + sizing for protocol discovery / live round-trip verify.
 * Independent of BOT_WALLET / WALLET_MNEMONIC used by the production bot.
 */
export function loadProtocolVerifyConfig(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const parsed = parseEnv(
    z.object({
      CANIX402_MCP_URL: z.url().default("https://canix402-mcp.compx.io/mcp"),
      X402_ALGOD_URL: z.url().default("https://mainnet-api.algonode.cloud"),
      TEST_WALLET: testWalletSchema,
      TEST_MNEMONIC: z.string().min(1),
      PROTOCOL_VERIFY_AMOUNT_USDC: z.coerce.number().positive().default(1),
      PROTOCOL_VERIFY_AMOUNT_ALGO: z.coerce.number().positive().default(1),
      /** CompX credit verify: borrow size in whole COMPX tokens. */
      PROTOCOL_VERIFY_AMOUNT_COMPX: z.coerce.number().positive().default(10),
      /** DorkFi credit verify: borrow size in whole UNIT tokens. */
      PROTOCOL_VERIFY_AMOUNT_UNIT: z.coerce.number().positive().default(0.1),
      /** Myth dualSTAKE paired ASA (ORA) balance check; Canix derives exact transfer. */
      PROTOCOL_VERIFY_AMOUNT_ORA: z.coerce.number().positive().default(1),
      MAX_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(10_000).default(100),
      MAX_PRICE_IMPACT_PCT: z.coerce.number().min(0).max(100).default(3),
      MAX_DAILY_X402_BASE_UNITS: z.coerce
        .number()
        .int()
        .positive()
        .default(5_000_000),
      MAX_SOURCE_AGE_HOURS: z.coerce.number().positive().default(72),
      FOLKS_ESCROW_DATA_DIR: z
        .string()
        .min(1)
        .default("data/folks-escrows-verify"),
    }),
    environment,
    ["TEST_WALLET", "TEST_MNEMONIC"],
  );

  const wallet = walletFromMnemonic(parsed.TEST_MNEMONIC);
  if (wallet.address !== parsed.TEST_WALLET) {
    throw new Error(
      "TEST_WALLET must match TEST_MNEMONIC when running protocol verify",
    );
  }

  return parsed;
}

export type ProtocolVerifyConfig = ReturnType<typeof loadProtocolVerifyConfig>;
