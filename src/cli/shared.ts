import type { OpportunityResult } from "../domain.js";
import {
  Canix402Client,
  McpSdkToolCaller,
} from "../integrations/canix402/client.js";
import { AlgorandPaymentBuilder } from "../integrations/canix402/payment.js";
import { walletFromMnemonic } from "../integrations/canix402/wallet.js";
import { rankOpportunities } from "../services/treasury-review.js";

interface CanixCliConfig {
  CANIX402_MCP_URL: string;
  WALLET_MNEMONIC: string;
  X402_ALGOD_URL: string;
}

export interface CliContext {
  client: Canix402Client;
  payerAddress: string;
}

export function createCliContext(config: CanixCliConfig): CliContext {
  const wallet = walletFromMnemonic(config.WALLET_MNEMONIC);
  const caller = new McpSdkToolCaller(new URL(config.CANIX402_MCP_URL));
  const paymentBuilder = new AlgorandPaymentBuilder(wallet, {
    algodUrl: config.X402_ALGOD_URL,
  });
  return {
    client: new Canix402Client(caller, paymentBuilder),
    payerAddress: wallet.address,
  };
}

export function parseLimit(rawValue: string | undefined): number {
  if (rawValue === undefined) {
    return 10;
  }
  if (!/^\d+$/.test(rawValue)) {
    throw new Error("limit must be an integer between 1 and 200");
  }
  const limit = Number(rawValue);
  if (limit < 1 || limit > 200) {
    throw new Error("limit must be an integer between 1 and 200");
  }
  return limit;
}

export function assertNoExtraArgs(args: string[]): void {
  if (args.length > 1) {
    throw new Error("expected at most one positional argument: [limit]");
  }
}

export function printOpportunities(
  heading: string,
  result: OpportunityResult,
  payerAddress: string,
  targetAddress?: string,
): void {
  const opportunities = rankOpportunities(result.opportunities);
  console.log(`\n${heading}`);
  console.log("=".repeat(heading.length));
  console.log(`x402 payer: ${payerAddress}`);
  if (targetAddress) {
    console.log(`Personalization target: ${targetAddress}`);
  }
  if (result.payment) {
    console.log(
      `x402 payment: ${formatUsdc(result.payment.amountBaseUnits)} USDC (${result.payment.amountBaseUnits} base units)`,
    );
    if (result.payment.responseHeader) {
      console.log(
        `Settlement: ${truncate(result.payment.responseHeader, 120)}`,
      );
    }
  }
  console.log(`Opportunities returned: ${opportunities.length}\n`);

  if (opportunities.length === 0) {
    console.log("No opportunities were returned.");
    return;
  }

  console.table(
    opportunities.map((opportunity, index) => ({
      Rank: index + 1,
      Protocol: opportunity.protocol,
      Type: opportunity.opportunityType,
      Assets: opportunity.assetPair,
      "APY %": formatRate(opportunity.apy),
      "APR %":
        opportunity.apr === undefined ? "—" : formatRate(opportunity.apr),
      TVL: formatUsd(opportunity.tvlUsd),
      Freshness: formatFreshness(opportunity.sourceTimestamp),
      "Source time": opportunity.sourceTimestamp,
    })),
  );
}

export function printCliError(error: unknown): void {
  const message =
    error instanceof Error ? error.message : "Unknown command failure";
  console.error(`Canix402 command failed: ${message}`);
}

function formatRate(value: number): string {
  return value.toLocaleString("en-US", {
    maximumFractionDigits: 6,
  });
}

function formatUsd(value: number): string {
  return `$${value.toLocaleString("en-US", {
    maximumFractionDigits: 2,
  })}`;
}

function formatFreshness(timestamp: string): string {
  const ageSeconds = Math.floor(
    (Date.now() - new Date(timestamp).getTime()) / 1_000,
  );
  if (!Number.isFinite(ageSeconds)) {
    return "unknown";
  }
  if (ageSeconds < 0) {
    return "future timestamp";
  }
  if (ageSeconds < 60) {
    return `${ageSeconds}s ago`;
  }
  const ageMinutes = Math.floor(ageSeconds / 60);
  if (ageMinutes < 60) {
    return `${ageMinutes}m ago`;
  }
  const ageHours = Math.floor(ageMinutes / 60);
  if (ageHours < 48) {
    return `${ageHours}h ago`;
  }
  return `${Math.floor(ageHours / 24)}d ago`;
}

function formatUsdc(baseUnits: string): string {
  return (Number(baseUnits) / 1_000_000).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}
