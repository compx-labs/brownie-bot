import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { startDailyScheduler } from "./scheduler.js";

const config = loadConfig();
const { app, reviewService } = createApp(config);
const task = config.RUN_CRON
  ? startDailyScheduler(
      reviewService,
      config.CRON_SCHEDULE,
      config.CRON_TIMEZONE,
      app.log,
    )
  : undefined;

async function shutdown(signal: string) {
  app.log.info({ signal }, "shutting down");
  await task?.stop();
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
      signingEnabled: config.ENABLE_TRANSACTION_SIGNING,
      cronSchedule: config.RUN_CRON ? config.CRON_SCHEDULE : undefined,
      cronTimezone: config.RUN_CRON ? config.CRON_TIMEZONE : undefined,
    },
    "autonomous treasury backend started",
  );
} catch (error) {
  app.log.error(error, "failed to start backend");
  process.exitCode = 1;
}
