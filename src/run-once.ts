import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { app, reviewService } = createApp(config);

try {
  const run = await reviewService.run();
  process.stdout.write(
    `${JSON.stringify(
      {
        id: run.id,
        status: run.status,
        signingEnabled: run.signingEnabled,
        actionCount: run.plan?.actions.length,
        policyApproved: run.policy?.approved,
        transactionIds: run.executions
          ?.map((execution) => execution.transactionId)
          .filter(Boolean),
        error: run.error,
        reconciliationError: run.reconciliationError,
        notificationError: run.notificationError,
      },
      null,
      2,
    )}\n`,
  );
  if (run.status === "failed") {
    process.exitCode = 1;
  }
} finally {
  await app.close();
}
