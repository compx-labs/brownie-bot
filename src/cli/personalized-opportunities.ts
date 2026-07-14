import { loadPersonalizedCliConfig } from "./config.js";
import {
  assertNoExtraArgs,
  createCliContext,
  parseLimit,
  printCliError,
  printOpportunities,
} from "./shared.js";

let context: ReturnType<typeof createCliContext> | undefined;

try {
  const args = process.argv.slice(2);
  assertNoExtraArgs(args);
  const limit = parseLimit(args[0]);
  const config = loadPersonalizedCliConfig();
  context = createCliContext(config);
  const result = await context.client.getPersonalizedOpportunities(
    config.BOT_WALLET,
    limit,
  );
  printOpportunities(
    "Canix402 personalized Algorand DeFi opportunities",
    result,
    context.payerAddress,
    config.BOT_WALLET,
  );
} catch (error) {
  printCliError(error);
  process.exitCode = 1;
} finally {
  await context?.client.close();
}
