import cron, { type ScheduledTask } from "node-cron";
import type { FastifyBaseLogger } from "fastify";

import type { TreasuryReviewService } from "./services/treasury-review.js";

export function startDailyScheduler(
  reviewService: TreasuryReviewService,
  schedule: string,
  timezone: string,
  logger: FastifyBaseLogger,
): ScheduledTask {
  if (!cron.validate(schedule)) {
    throw new Error(`Invalid CRON_SCHEDULE: ${schedule}`);
  }

  return cron.schedule(
    schedule,
    async () => {
      const run = await reviewService.run();
      logger.info(
        { runId: run.id, status: run.status },
        "scheduled treasury review completed",
      );
    },
    {
      timezone,
      noOverlap: true,
    },
  );
}
