import { loadWalletScanCliConfig } from "./config.js";
import {
  assertNoArgs,
  createCliContext,
  printCliError,
  printPortfolioSnapshot,
  readPortfolioSnapshot,
} from "./shared.js";

let context: ReturnType<typeof createCliContext> | undefined;

try {
  const args = process.argv.slice(2);
  assertNoArgs(args);
  const config = loadWalletScanCliConfig();
  context = createCliContext(config);
  const { snapshot, payments } = await readPortfolioSnapshot(
    context.client,
    config.BOT_WALLET,
    config.X402_ALGOD_URL,
    config.MAX_SOURCE_AGE_HOURS,
  );
  printPortfolioSnapshot(
    "Canix402 wallet / portfolio scan",
    snapshot,
    context.payerAddress,
    payments,
    config.MAX_SOURCE_AGE_HOURS,
  );
  if (!snapshot.complete) {
    process.exitCode = 2;
  }
} catch (error) {
  printCliError(error);
  process.exitCode = 1;
} finally {
  await context?.client.close();
}
