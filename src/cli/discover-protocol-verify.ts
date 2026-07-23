/**
 * Discover and pin stable opportunity IDs for the protocol verify suite.
 *
 * Uses TEST_WALLET / TEST_MNEMONIC (x402 paid research). Writes
 * tests/fixtures/protocol-verify-opportunities.json.
 *
 * Usage:
 *   npm run canix:discover-verify
 */
import path from "node:path";

import { loadProtocolVerifyConfig } from "./config.js";
import { createCliContext, printCliError } from "./shared.js";
import {
  assertAllCasesPinned,
  collectDiscoveryOpportunities,
  DEFAULT_PROTOCOL_VERIFY_FIXTURE_PATH,
  matchProtocolVerifyCases,
  toBaseUnits,
  writeProtocolVerifyFixture,
} from "../services/protocol-verify.js";

let context: ReturnType<typeof createCliContext> | undefined;

try {
  const config = loadProtocolVerifyConfig();
  context = createCliContext({
    CANIX402_MCP_URL: config.CANIX402_MCP_URL,
    WALLET_MNEMONIC: config.TEST_MNEMONIC,
    X402_ALGOD_URL: config.X402_ALGOD_URL,
  });
  if (context.payerAddress !== config.TEST_WALLET) {
    throw new Error("TEST_WALLET must match TEST_MNEMONIC");
  }

  console.log(
    `Discovering protocol-verify opportunities for ${config.TEST_WALLET}…`,
  );
  const opportunities = await collectDiscoveryOpportunities(
    context.client,
    config.TEST_WALLET,
    50,
  );
  console.log(`Catalog size: ${opportunities.length}`);

  const matched = matchProtocolVerifyCases(opportunities, {
    algoBudgetRaw: toBaseUnits(
      config.PROTOCOL_VERIFY_AMOUNT_ALGO,
      6,
    ),
  });
  const cases = assertAllCasesPinned(matched);
  const fixturePath = path.resolve(DEFAULT_PROTOCOL_VERIFY_FIXTURE_PATH);
  await writeProtocolVerifyFixture(
    {
      fetchedAt: new Date().toISOString(),
      walletAddress: config.TEST_WALLET,
      cases,
    },
    fixturePath,
  );

  console.log(`\nPinned fixture written to ${fixturePath}`);
  console.table(
    Object.values(cases).map((entry) => ({
      Case: entry.caseId,
      Protocol: entry.protocol,
      Opportunity: entry.opportunityId ?? "—",
      Enter: entry.enterShapeKey ?? "—",
      Exit: entry.exitShapeKey ?? "—",
    })),
  );
} catch (error) {
  printCliError(error);
  process.exitCode = 1;
} finally {
  await context?.client.close();
}
