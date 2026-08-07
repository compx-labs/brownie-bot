import { readFile } from "node:fs/promises";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { inceptionReviewSchema } from "./domain.js";
import {
  DEFAULT_INCEPTION_AS_OF,
  DEFAULT_INCEPTION_MIN_ROUND,
  InceptionReviewService,
} from "./services/inception-review.js";

function usage(): string {
  return `Usage:
  npm run accounting-inception-review -- [options]
  npm run accounting-inception-review -- --commit [--review path] [--inception-nav usd] [--force]

Options:
  --min-round <n>       Indexer min round (default ${DEFAULT_INCEPTION_MIN_ROUND})
  --as-of <iso>         Inception asOf ISO timestamp (default ${DEFAULT_INCEPTION_AS_OF})
  --commit              Commit last/loaded review: cashflows + inception.json
  --review <path>       Review JSON file to commit (default: store inception-review.json)
  --inception-nav <usd> Override proposed liquid NAV at min round
  --force               Overwrite existing inception
`;
}

function parseArgs(argv: string[]): {
  commit: boolean;
  force: boolean;
  minRound?: number;
  asOf?: string;
  reviewPath?: string;
  inceptionNavUsd?: string;
} {
  const result: {
    commit: boolean;
    force: boolean;
    minRound?: number;
    asOf?: string;
    reviewPath?: string;
    inceptionNavUsd?: string;
  } = { commit: false, force: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (arg === "--commit") {
      result.commit = true;
      continue;
    }
    if (arg === "--force") {
      result.force = true;
      continue;
    }
    if (arg === "--min-round") {
      const raw = argv[++i];
      if (!raw || !/^\d+$/.test(raw)) {
        throw new Error("--min-round requires a non-negative integer");
      }
      result.minRound = Number(raw);
      continue;
    }
    if (arg === "--as-of") {
      const raw = argv[++i];
      if (!raw) {
        throw new Error("--as-of requires an ISO timestamp");
      }
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error(`Invalid --as-of timestamp: ${raw}`);
      }
      result.asOf = parsed.toISOString();
      continue;
    }
    if (arg === "--review") {
      const raw = argv[++i];
      if (!raw) {
        throw new Error("--review requires a file path");
      }
      result.reviewPath = raw;
      continue;
    }
    if (arg === "--inception-nav") {
      const raw = argv[++i];
      if (!raw || !/^-?[0-9]+(?:\.[0-9]+)?$/.test(raw)) {
        throw new Error("--inception-nav requires a USD number");
      }
      result.inceptionNavUsd = raw;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n${usage()}`);
  }
  return result;
}

const config = loadConfig();
const args = parseArgs(process.argv.slice(2));
const { app, accountingService, canix, store } = await createApp(config);

const reviewService = new InceptionReviewService(
  store,
  canix,
  accountingService,
  {
    walletAddress: config.BOT_WALLET,
    indexerUrl: config.X402_INDEXER_URL,
    algodUrl: config.X402_ALGOD_URL,
  },
);

try {
  if (args.commit) {
    let review;
    if (args.reviewPath) {
      const raw = JSON.parse(await readFile(args.reviewPath, "utf8")) as unknown;
      review = inceptionReviewSchema.parse(raw);
    } else {
      review = await store.getInceptionReview(config.BOT_WALLET);
      if (!review) {
        throw new Error(
          "No inception-review.json in store; run without --commit first or pass --review <path>",
        );
      }
    }
    const result = await reviewService.commitReview({
      review,
      inceptionNavUsd: args.inceptionNavUsd,
      force: args.force,
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          committed: true,
          inception: result.inception,
          recordedCashflows: result.recordedCashflows,
          skippedCashflows: result.skippedCashflows,
          next: "npm run accounting-once",
        },
        null,
        2,
      )}\n`,
    );
  } else {
    const review = await reviewService.buildReview({
      minRound: args.minRound,
      asOf: args.asOf,
    });
    process.stdout.write(`${JSON.stringify(review, null, 2)}\n`);
    process.stderr.write(
      `Wrote inception review (${review.rows.length} rows). Verify, then:\n` +
        `  npm run accounting-inception-review -- --commit\n`,
    );
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  await app.close();
}
