import cron, { type ScheduledTask } from "node-cron";
import type { FastifyBaseLogger } from "fastify";

import type { AccountingService } from "./services/accounting.js";
import type { TreasuryReviewService } from "./services/treasury-review.js";

export function startReviewScheduler(
  reviewService: TreasuryReviewService,
  schedule: string,
  timezone: string,
  logger: FastifyBaseLogger,
): ScheduledTask {
  return startCron(
    schedule,
    timezone,
    async () => {
      const run = await reviewService.run("wait");
      logger.info(
        { runId: run.id, status: run.status },
        "scheduled treasury review completed",
      );
    },
    "CRON_SCHEDULE",
  );
}

/** @deprecated Use startReviewScheduler */
export function startDailyScheduler(
  reviewService: TreasuryReviewService,
  schedule: string,
  timezone: string,
  logger: FastifyBaseLogger,
): ScheduledTask {
  return startReviewScheduler(reviewService, schedule, timezone, logger);
}

export function startAccountingScheduler(
  accountingService: AccountingService,
  schedule: string,
  timezone: string,
  logger: FastifyBaseLogger,
): ScheduledTask {
  return startCron(
    schedule,
    timezone,
    async () => {
      const run = await accountingService.run("wait");
      logger.info(
        { runId: run.id, status: run.status },
        "scheduled accounting snapshot completed",
      );
    },
    "ACCOUNTING_CRON_SCHEDULE",
  );
}

function startCron(
  schedule: string,
  timezone: string,
  handler: () => Promise<void>,
  label: string,
): ScheduledTask {
  if (!cron.validate(schedule)) {
    throw new Error(`Invalid ${label}: ${schedule}`);
  }
  return cron.schedule(
    schedule,
    async () => {
      await handler();
    },
    {
      timezone,
      noOverlap: true,
    },
  );
}
