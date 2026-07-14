import Fastify, { type FastifyInstance } from "fastify";

import type { AppConfig } from "./config.js";
import {
  Canix402Client,
  McpSdkToolCaller,
} from "./integrations/canix402/client.js";
import { AlgorandPaymentBuilder } from "./integrations/canix402/payment.js";
import { walletFromMnemonic } from "./integrations/canix402/wallet.js";
import { AlgorandPortfolioReader } from "./integrations/algorand/portfolio.js";
import { AlgorandExecutionService } from "./integrations/algorand/execution.js";
import {
  RunInProgressError,
  TreasuryReviewService,
  type ReviewState,
} from "./services/treasury-review.js";
import { createPortfolioAgent } from "./services/portfolio-agent.js";
import { PortfolioPolicy } from "./services/portfolio-policy.js";
import { TelegramNotifier } from "./services/telegram.js";

export interface AppContext {
  app: FastifyInstance;
  reviewService: TreasuryReviewService;
  canix: Canix402Client;
  state: ReviewState;
}

export function createApp(config: AppConfig): AppContext {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === "test" ? "silent" : "info",
      redact: {
        paths: [
          "req.headers.authorization",
          "WALLET_MNEMONIC",
          "paymentSignature",
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
  const agent = createPortfolioAgent(
    config.OPEN_AI_API_KEY,
    canix,
    portfolioReader,
    {
      model: config.OPENAI_MODEL,
      reasoningEffort: config.OPENAI_REASONING_EFFORT,
      maxToolCalls: config.AI_MAX_TOOL_CALLS,
      walletAddress: config.BOT_WALLET,
      minimumHoldingHorizonDays: config.MIN_HOLDING_HORIZON_DAYS,
    },
  );
  const policy = new PortfolioPolicy({
    maxPositionPct: config.MAX_POSITION_PCT,
    maxProtocolPct: config.MAX_PROTOCOL_PCT,
    minLiquidReservePct: config.MIN_LIQUID_RESERVE_PCT,
    maxDailyTurnoverPct: config.MAX_DAILY_TURNOVER_PCT,
    minTvlUsd: config.MIN_TVL_USD,
    maxSourceAgeHours: config.MAX_SOURCE_AGE_HOURS,
    minHoldingHorizonDays: config.MIN_HOLDING_HORIZON_DAYS,
    minProjectedNetImprovementUsd: config.MIN_PROJECTED_NET_IMPROVEMENT_USD,
  });
  const executor = new AlgorandExecutionService(
    canix,
    wallet,
    config.BOT_WALLET,
    config.X402_ALGOD_URL,
    {
      signingEnabled: config.ENABLE_TRANSACTION_SIGNING,
      maxFeeMicroAlgos: BigInt(config.MAX_TRANSACTION_FEE_MICROALGOS),
      maxSlippageBps: config.MAX_SLIPPAGE_BPS,
      maxPriceImpactPct: config.MAX_PRICE_IMPACT_PCT,
    },
  );
  const notifier = new TelegramNotifier(
    config.TELEGRAM_BOT_TOKEN,
    config.TELEGRAM_CHAT_ID,
  );
  const state: ReviewState = {};
  const reviewService = new TreasuryReviewService(
    agent,
    policy,
    executor,
    notifier,
    state,
    config.BOT_WALLET,
    config.ENABLE_TRANSACTION_SIGNING,
    portfolioReader,
  );

  app.get("/health", () => ({
    status: "ok",
    mode: "autonomous",
    signingEnabled: config.ENABLE_TRANSACTION_SIGNING,
    walletConfigured: true,
    telegramConfigured: true,
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
      return await reviewService.run();
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

  app.addHook("onClose", async () => {
    await canix.close();
  });

  return { app, reviewService, canix, state };
}
