import "dotenv/config";

import algosdk from "algosdk";
import { z } from "zod";

const baseCliConfigSchema = z.object({
  CANIX402_MCP_URL: z.url().default("https://canix402-mcp.compx.io/mcp"),
  WALLET_MNEMONIC: z.string().min(1),
  X402_ALGOD_URL: z.url().default("https://mainnet-api.algonode.cloud"),
});

const botWalletSchema = z
  .string()
  .refine(algosdk.isValidAddress, "BOT_WALLET is not a valid Algorand address");

export function loadGeneralCliConfig(
  environment: NodeJS.ProcessEnv = process.env,
) {
  return baseCliConfigSchema.parse(environment);
}

export function loadPersonalizedCliConfig(
  environment: NodeJS.ProcessEnv = process.env,
) {
  return baseCliConfigSchema
    .extend({ BOT_WALLET: botWalletSchema })
    .parse(environment);
}
