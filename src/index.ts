import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { startAccountingScheduler, startReviewScheduler } from "./scheduler.js";

const config = loadConfig();
const { app, reviewService, accountingService } = createApp(config);
const reviewTask = config.RUN_CRON
  ? startReviewScheduler(
      reviewService,
      config.CRON_SCHEDULE,
      config.CRON_TIMEZONE,
      app.log,
    )
  : undefined;
const accountingTask = startAccountingScheduler(
  accountingService,
  config.ACCOUNTING_CRON_SCHEDULE,
  config.ACCOUNTING_CRON_TIMEZONE,
  app.log,
);

async function shutdown(signal: string) {
  app.log.info({ signal }, "shutting down");
  await reviewTask?.stop();
  await accountingTask.stop();
  await app.close();
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

try {
  await app.listen({ host: config.HOST, port: config.PORT });
  app.log.info(
    {
      cronEnabled: config.RUN_CRON,
      accountingCronEnabled: true,
      signingEnabled: config.ENABLE_TRANSACTION_SIGNING,
      cronSchedule: config.RUN_CRON ? config.CRON_SCHEDULE : undefined,
      cronTimezone: config.RUN_CRON ? config.CRON_TIMEZONE : undefined,
      accountingCronSchedule: config.ACCOUNTING_CRON_SCHEDULE,
      accountingCronTimezone: config.ACCOUNTING_CRON_TIMEZONE,
    },
    "autonomous treasury backend started",
  );
} catch (error) {
  app.log.error(error, "failed to start backend");
  process.exitCode = 1;
}
