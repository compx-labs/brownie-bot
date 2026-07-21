import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppConfig } from "./config.js";
import {
  isSpacesConfigured,
  isTelegramConfigured,
  requireSpacesCredentials,
  requireTelegramCredentials,
} from "./config.js";
import { accountingCashflowSchema } from "./domain.js";
import {
  Canix402Client,
  McpSdkToolCaller,
} from "./integrations/canix402/client.js";
import { AlgorandPaymentBuilder } from "./integrations/canix402/payment.js";
import { walletFromMnemonic } from "./integrations/canix402/wallet.js";
import { AlgorandPortfolioReader } from "./integrations/algorand/portfolio.js";
import { AlgorandExecutionService } from "./integrations/algorand/execution.js";
import {
  LocalFolksEscrowStore,
  SpacesFolksEscrowStore,
  type FolksEscrowStore,
} from "./integrations/algorand/folks-escrow-store.js";
import {
  LocalFilesystemAccountingStore,
  SpacesAccountingStore,
  type AccountingStore,
} from "./integrations/storage/accounting-store.js";
import {
  AccountingRunInProgressError,
  AccountingService,
  type AccountingState,
} from "./services/accounting.js";
import { RunCoordinator } from "./services/run-coordinator.js";
import {
  RunInProgressError,
  TreasuryReviewService,
  type ReviewState,
} from "./services/treasury-review.js";
import { createPortfolioAgent } from "./services/portfolio-agent.js";
import { PortfolioPolicy } from "./services/portfolio-policy.js";
import {
  ConsoleNotifier,
  TelegramNotifier,
  type AccountingNotifier,
  type RunNotifier,
} from "./services/telegram.js";

export interface AppContext {
  app: FastifyInstance;
  reviewService: TreasuryReviewService;
  accountingService: AccountingService;
  canix: Canix402Client;
  state: ReviewState;
  accountingState: AccountingState;
  coordinator: RunCoordinator;
}

const cashflowBodySchema = z.object({
  eventId: z.string().min(1),
  type: accountingCashflowSchema.shape.type,
  amountUsd: accountingCashflowSchema.shape.amountUsd,
  occurredAt: z.iso.datetime(),
  transactionId: z.string().min(1).optional(),
  reference: z.string().min(1).optional(),
  notes: z.string().optional(),
});

export function createApp(config: AppConfig): AppContext {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === "test" ? "silent" : "info",
      redact: {
        paths: [
          "req.headers.authorization",
          "WALLET_MNEMONIC",
          "paymentSignature",
          "DO_SPACES_SECRET",
          "DO_SPACES_KEY",
        ],
        censor: "[REDACTED]",
      },
    },
  });

  const wallet = walletFromMnemonic(config.WALLET_MNEMONIC);
  if (
    config.ENABLE_TRANSACTION_SIGNING &&
    wallet.address !== config.BOT_WALLET
  ) {
    throw new Error(
      "BOT_WALLET must match WALLET_MNEMONIC when transaction signing is enabled",
    );
  }
  const caller = new McpSdkToolCaller(new URL(config.CANIX402_MCP_URL));
  const paymentBuilder = new AlgorandPaymentBuilder(wallet, {
    algodUrl: config.X402_ALGOD_URL,
    maxDailyBaseUnits: BigInt(config.MAX_DAILY_X402_BASE_UNITS),
  });
  const canix = new Canix402Client(caller, paymentBuilder);
  const portfolioReader = new AlgorandPortfolioReader(
    canix,
    config.BOT_WALLET,
    config.X402_ALGOD_URL,
    config.MAX_SOURCE_AGE_HOURS,
  );
  const hostGuidance = {
    maxPositionPct: config.MAX_POSITION_PCT,
    maxProtocolPct: config.MAX_PROTOCOL_PCT,
    minLiquidReservePct: config.MIN_LIQUID_RESERVE_PCT,
    minTvlUsd: config.MIN_TVL_USD,
    maxSourceAgeHours: config.MAX_SOURCE_AGE_HOURS,
    minProjectedNetImprovementUsd: config.MIN_PROJECTED_NET_IMPROVEMENT_USD,
  };
  const agent = createPortfolioAgent(
    config.OPEN_AI_API_KEY,
    canix,
    portfolioReader,
    {
      model: config.OPENAI_MODEL,
      reasoningEffort: config.OPENAI_REASONING_EFFORT,
      aiMode: config.AI_MODE,
      maxToolCalls: config.AI_MAX_TOOL_CALLS,
      walletAddress: config.BOT_WALLET,
      hostGuidance,
      signingEnabled: config.ENABLE_TRANSACTION_SIGNING,
    },
    config.OPENAI_BASE_URL,
  );
  const policy = new PortfolioPolicy({
    ...hostGuidance,
    signingEnabled: config.ENABLE_TRANSACTION_SIGNING,
  });
  const folksEscrowStore: FolksEscrowStore = isSpacesConfigured(config)
    ? (() => {
        const spaces = requireSpacesCredentials(config);
        return new SpacesFolksEscrowStore({
          endpoint: spaces.endpoint,
          region: config.DO_SPACES_REGION,
          bucket: spaces.bucket,
          accessKeyId: spaces.key,
          secretAccessKey: spaces.secret,
          prefix: config.DO_SPACES_PREFIX,
        });
      })()
    : new LocalFolksEscrowStore(config.FOLKS_ESCROW_DATA_DIR);
  const executor = new AlgorandExecutionService(
    canix,
    wallet,
    config.BOT_WALLET,
    config.X402_ALGOD_URL,
    {
      signingEnabled: config.ENABLE_TRANSACTION_SIGNING,
      maxSlippageBps: config.MAX_SLIPPAGE_BPS,
      maxPriceImpactPct: config.MAX_PRICE_IMPACT_PCT,
    },
    folksEscrowStore,
  );
  const notifier: RunNotifier & AccountingNotifier = isTelegramConfigured(
    config,
  )
    ? (() => {
        const telegram = requireTelegramCredentials(config);
        return new TelegramNotifier(telegram.botToken, telegram.chatId);
      })()
    : new ConsoleNotifier();
  const coordinator = new RunCoordinator();
  const state: ReviewState = {};
  const accountingState: AccountingState = {};
  const reviewService = new TreasuryReviewService(
    agent,
    policy,
    executor,
    notifier,
    state,
    config.BOT_WALLET,
    config.ENABLE_TRANSACTION_SIGNING,
    portfolioReader,
    coordinator,
  );
  const store: AccountingStore = isSpacesConfigured(config)
    ? (() => {
        const spaces = requireSpacesCredentials(config);
        return new SpacesAccountingStore({
          endpoint: spaces.endpoint,
          region: config.DO_SPACES_REGION,
          bucket: spaces.bucket,
          accessKeyId: spaces.key,
          secretAccessKey: spaces.secret,
          prefix: config.DO_SPACES_PREFIX,
        });
      })()
    : new LocalFilesystemAccountingStore({
        rootDir: config.ACCOUNTING_DATA_DIR,
        prefix: config.DO_SPACES_PREFIX,
      });
  const accountingService = new AccountingService(
    portfolioReader,
    canix,
    store,
    notifier,
    coordinator,
    accountingState,
    {
      walletAddress: config.BOT_WALLET,
      maxSourceAgeHours: config.MAX_SOURCE_AGE_HOURS,
    },
  );

  app.get("/health", () => ({
    status: "ok",
    mode: "autonomous",
    signingEnabled: config.ENABLE_TRANSACTION_SIGNING,
    walletConfigured: true,
    telegramConfigured: isTelegramConfigured(config),
    accountingEnabled: true,
    accountingStorage: isSpacesConfigured(config) ? "spaces" : "local",
    folksEscrowStorage: isSpacesConfigured(config) ? "spaces" : "local",
  }));

  app.get("/runs/latest", async (_request, reply) => {
    if (!state.latest) {
      return reply.code(404).send({
        error: "NO_RUNS",
        message: "No treasury review has completed yet",
      });
    }
    return state.latest;
  });

  app.post("/runs", async (request, reply) => {
    if (!config.MANUAL_TRIGGER_TOKEN) {
      return reply.code(404).send({
        error: "NOT_FOUND",
        message: "Manual review triggering is disabled",
      });
    }
    if (
      request.headers.authorization !== `Bearer ${config.MANUAL_TRIGGER_TOKEN}`
    ) {
      return reply.code(401).send({
        error: "UNAUTHORIZED",
        message: "A valid bearer token is required",
      });
    }
    try {
      return await reviewService.run("fail");
    } catch (error) {
      if (error instanceof RunInProgressError) {
        return reply.code(409).send({
          error: "RUN_IN_PROGRESS",
          message: error.message,
        });
      }
      throw error;
    }
  });

  app.get("/accounting/latest", async (_request, reply) => {
    if (!accountingState.latest?.summary) {
      return reply.code(404).send({
        error: "NO_ACCOUNTING",
        message: "No accounting snapshot has completed yet",
      });
    }
    return accountingState.latest;
  });

  app.post("/accounting/run", async (request, reply) => {
    if (!config.MANUAL_TRIGGER_TOKEN) {
      return reply.code(404).send({
        error: "NOT_FOUND",
        message: "Manual accounting triggering is disabled",
      });
    }
    if (
      request.headers.authorization !== `Bearer ${config.MANUAL_TRIGGER_TOKEN}`
    ) {
      return reply.code(401).send({
        error: "UNAUTHORIZED",
        message: "A valid bearer token is required",
      });
    }
    try {
      return await accountingService.run("fail");
    } catch (error) {
      if (error instanceof AccountingRunInProgressError) {
        return reply.code(409).send({
          error: "RUN_IN_PROGRESS",
          message: error.message,
        });
      }
      throw error;
    }
  });

  app.post("/accounting/cashflows", async (request, reply) => {
    if (!config.MANUAL_TRIGGER_TOKEN) {
      return reply.code(404).send({
        error: "NOT_FOUND",
        message: "Manual cashflow recording is disabled",
      });
    }
    if (
      request.headers.authorization !== `Bearer ${config.MANUAL_TRIGGER_TOKEN}`
    ) {
      return reply.code(401).send({
        error: "UNAUTHORIZED",
        message: "A valid bearer token is required",
      });
    }
    const body = cashflowBodySchema.parse(request.body);
    try {
      return await accountingService.recordCashflow(body);
    } catch (error) {
      return reply.code(409).send({
        error: "CASHFLOW_CONFLICT",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  app.addHook("onClose", async () => {
    await canix.close();
  });

  return {
    app,
    reviewService,
    accountingService,
    canix,
    state,
    accountingState,
    coordinator,
  };
}
