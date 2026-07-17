/**
 * Paid probe: find a Folks USDC lending opportunity and request a setup
 * execution quote only. Does not sign or submit.
 *
 * Folks cannot be quoted as a single multi-shape batch: opt/deposit need the
 * escrowAddress created by setup. Host execution must be sequential.
 *
 * Cost: opportunity discovery payments + ~0.10 USDC for the setup quote.
 *
 * Usage:
 *   npm run canix:folks-quote
 */
import type { Opportunity } from "../domain.js";
import { loadPersonalizedCliConfig } from "./config.js";
import { createCliContext, printCliError } from "./shared.js";

const USDC_ASSET_ID = 31_566_704;

let context: ReturnType<typeof createCliContext> | undefined;

try {
  const config = loadPersonalizedCliConfig();
  context = createCliContext(config);

  console.log("Discovering Folks USDC opportunities…");
  const personalized = await context.client.getPersonalizedOpportunities(
    config.BOT_WALLET,
    25,
  );
  const listed = await context.client.getOpportunities(25);
  const opportunities = dedupeOpportunities([
    ...personalized.opportunities,
    ...listed.opportunities,
  ]);
  const folksUsdc = opportunities.find(
    (opportunity) =>
      opportunity.protocol.toLowerCase().includes("folks") &&
      opportunity.executionReady &&
      opportunity.executionShapes.length > 0 &&
      (opportunity.assetIds?.includes(USDC_ASSET_ID) ||
        /usdc/i.test(opportunity.assetPair)),
  );
  if (!folksUsdc) {
    throw new Error("No execution-ready Folks USDC opportunity found");
  }

  const shapes = [...folksUsdc.executionShapes].sort(
    (left, right) =>
      left.order - right.order || left.shapeKey.localeCompare(right.shapeKey),
  );
  console.log(
    JSON.stringify(
      {
        opportunityId: folksUsdc.opportunityId,
        protocol: folksUsdc.protocol,
        apy: folksUsdc.apy,
        tvlUsd: folksUsdc.tvlUsd,
        shapes: shapes.map((shape) => ({
          shapeKey: shape.shapeKey,
          action: shape.action,
          order: shape.order,
          requiredInputs: shape.requiredInputs,
          inputHints: shape.inputHints,
        })),
      },
      null,
      2,
    ),
  );

  const setup = shapes[0];
  if (!setup) {
    throw new Error("Opportunity has no execution shapes");
  }

  const quotes = [
    {
      shapeKey: setup.shapeKey,
      input: {
        ...(setup.inputHints ?? {}),
        maxSlippageBps: 100,
      },
    },
  ];
  console.log("\nRequesting setup quote only (Folks is sequential)…");
  console.log(JSON.stringify({ quotes }, null, 2));

  const result = await context.client.callManagedTool(
    "canix_get_execution_quote",
    { quotes },
    config.BOT_WALLET,
  );
  const quote = (
    result.data as {
      data?: Array<{
        shapeKey?: string;
        warnings?: string[];
        metadata?: Record<string, unknown>;
        encodedTransactions?: unknown[];
      }>;
      meta?: unknown;
    }
  ).data?.[0];

  console.log(
    JSON.stringify(
      {
        payment: result.payment,
        meta: (result.data as { meta?: unknown }).meta,
        shapeKey: quote?.shapeKey,
        warnings: quote?.warnings,
        encodedTransactionCount: quote?.encodedTransactions?.length ?? 0,
        metadata: sanitizeMetadata(quote?.metadata),
      },
      null,
      2,
    ),
  );
  console.log(
    "\nNote: optEscrowAsset/deposit cannot be quoted until setup is confirmed and escrowAddress is known.",
  );
} catch (error) {
  printCliError(error);
  if (error instanceof Error) {
    console.error(error.message);
  }
  process.exitCode = 1;
} finally {
  await context?.client.close();
}

function sanitizeMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }
  const clone = { ...metadata };
  for (const key of Object.keys(clone)) {
    if (/private|secret|mnemonic|key/i.test(key)) {
      clone[key] = "[redacted]";
    }
  }
  return clone;
}

function dedupeOpportunities(opportunities: Opportunity[]): Opportunity[] {
  const seen = new Set<string>();
  const result: Opportunity[] = [];
  for (const opportunity of opportunities) {
    const key = `${opportunity.protocol}:${opportunity.opportunityId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(opportunity);
  }
  return result;
}
