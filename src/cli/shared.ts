import type {
  OpportunityResult,
  PaymentReceipt,
  PortfolioSnapshot,
} from "../domain.js";
import { AlgorandPortfolioReader } from "../integrations/algorand/portfolio.js";
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

export function assertNoArgs(args: string[]): void {
  if (args.length > 0) {
    throw new Error("this command does not take positional arguments");
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

export async function readPortfolioSnapshot(
  client: Canix402Client,
  address: string,
  algodUrl: string,
  maxSourceAgeHours: number,
): Promise<{
  snapshot: PortfolioSnapshot;
  payments: PaymentReceipt[];
}> {
  const reader = new AlgorandPortfolioReader(
    client,
    address,
    algodUrl,
    maxSourceAgeHours,
  );
  return reader.read();
}

export function printPortfolioSnapshot(
  heading: string,
  snapshot: PortfolioSnapshot,
  payerAddress: string,
  payments: PaymentReceipt[],
  maxSourceAgeHours: number,
): void {
  console.log(`\n${heading}`);
  console.log("=".repeat(heading.length));
  console.log(`x402 payer: ${payerAddress}`);
  console.log(`Scan target: ${snapshot.address}`);
  console.log(`Fetched at: ${snapshot.fetchedAt}`);
  console.log(`Max source age: ${maxSourceAgeHours}h`);
  console.log(
    `Snapshot complete: ${snapshot.complete ? "yes" : "NO — policy will treat non-hold plans as incomplete"}`,
  );
  for (const payment of payments) {
    console.log(
      `x402 payment: ${formatUsdc(payment.amountBaseUnits)} USDC (${payment.amountBaseUnits} base units)`,
    );
    if (payment.responseHeader) {
      console.log(`Settlement: ${truncate(payment.responseHeader, 120)}`);
    }
  }

  console.log("\nWhy incomplete (caveats)");
  if (snapshot.caveats.length === 0) {
    console.log("- none");
  } else {
    for (const [index, caveat] of snapshot.caveats.entries()) {
      console.log(`${index + 1}. ${caveat}`);
    }
  }

  console.log("\nProtocol scan status");
  if (snapshot.protocols.length === 0) {
    console.log("- no protocol results returned");
  } else {
    console.table(
      snapshot.protocols.map((protocol) => ({
        Protocol: protocol.protocol,
        Status: protocol.status,
        Positions: protocol.positionCount,
        Message: protocol.message ?? "—",
      })),
    );
  }

  console.log("\nAggregate totals (null = incomplete valuation)");
  console.table([
    {
      suppliedUsd: formatNullableUsd(snapshot.totals.suppliedUsd),
      borrowedUsd: formatNullableUsd(snapshot.totals.borrowedUsd),
      rewardsUsd: formatNullableUsd(snapshot.totals.rewardsUsd),
      netUsd: formatNullableUsd(snapshot.totals.netUsd),
    },
  ]);

  console.log(`\nPositions returned: ${snapshot.positions.length}`);
  if (snapshot.positions.length > 0) {
    console.table(
      snapshot.positions.map((position) => ({
        Protocol: position.protocol,
        Type: position.positionType,
        Id: truncate(position.positionId, 40),
        Asset: position.assetSymbol ?? position.assetId ?? "—",
        Amount: position.amount,
        USD: formatNullableUsd(position.usdValue),
        ExitKeys: position.compatibleExitShapeKeys.length,
        ManageKeys: position.compatibleManageShapeKeys.length,
        Freshness: position.sourceTimestamp
          ? formatFreshness(position.sourceTimestamp)
          : "—",
      })),
    );
  }

  console.log(`\nLiquid balances: ${snapshot.liquidBalances.length}`);
  console.log(
    `Account min balance (microAlgos): ${snapshot.minimumBalanceRaw}`,
  );
  if (snapshot.liquidBalances.length > 0) {
    console.table(
      snapshot.liquidBalances.map((balance) => ({
        AssetId: balance.assetId,
        Symbol: balance.symbol ?? "—",
        AmountRaw: balance.amountRaw,
        SpendableRaw: balance.spendableAmountRaw ?? balance.amountRaw,
        Frozen: balance.frozen ? "yes" : "no",
      })),
    );
  }

  console.log(
    `\nVerdict: ${snapshot.complete ? "COMPLETE" : "INCOMPLETE"} (${snapshot.caveats.length} caveat(s))`,
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

function formatNullableUsd(value: number | null): string {
  return value === null ? "null" : formatUsd(value);
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
