import { loadGeneralCliConfig } from "./config.js";
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
  context = createCliContext(loadGeneralCliConfig());
  const result = await context.client.getOpportunities(limit);
  printOpportunities(
    "Canix402 Algorand DeFi opportunities",
    result,
    context.payerAddress,
  );
} catch (error) {
  printCliError(error);
  process.exitCode = 1;
} finally {
  await context?.client.close();
}
