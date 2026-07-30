import type { AccountingRun, ReviewRun } from "../domain.js";
import { sanitizeErrorMessage, sanitizeErrorText } from "../util/errors.js";
import {
  AccountingRunInProgressError,
  type AccountingService,
} from "./accounting.js";
import {
  buildHealthReport,
  type BuildHealthReportInput,
  type HealthReport,
} from "./health.js";
import type { OperatorPauseStore } from "./operator-pause.js";
import { RunCoordinatorBusyError } from "./run-coordinator.js";
import {
  TelegramBotClient,
  type TelegramUpdate,
} from "./telegram-bot.js";
import {
  RunInProgressError,
  type TreasuryReviewService,
} from "./treasury-review.js";

export interface ParsedTelegramCommand {
  name: string;
  args: string;
  raw: string;
}

export interface TelegramCommandContext {
  chatId: string;
  command: ParsedTelegramCommand;
}

export type TelegramCommandHandler = (
  ctx: TelegramCommandContext,
) => Promise<string>;

export interface TelegramCommandLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
}

const HELP_TEXT = [
  "Brownie operator commands:",
  "/help — list commands",
  "/status — health and last-run summary",
  "/run — start a treasury review now",
  "/accounting — start an accounting snapshot now",
  "/pause — hold trading (reviews stay plan-only)",
  "/resume — allow trading again (if signing is enabled)",
].join("\n");

/**
 * Parse `/cmd@BotName args` into a normalized command name (lowercase, no @bot).
 * Returns undefined when the text is not a slash command.
 */
export function parseTelegramCommand(
  text: string | undefined,
): ParsedTelegramCommand | undefined {
  if (!text) {
    return undefined;
  }
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }
  const [rawToken, ...rest] = trimmed.split(/\s+/);
  const token = rawToken ?? "";
  const withoutSlash = token.slice(1);
  const at = withoutSlash.indexOf("@");
  const name = (
    at >= 0 ? withoutSlash.slice(0, at) : withoutSlash
  ).toLowerCase();
  if (!name) {
    return undefined;
  }
  return {
    name,
    args: rest.join(" ").trim(),
    raw: trimmed,
  };
}

export function isAllowedTelegramChat(
  chatId: string | number,
  allowedChatId: string,
): boolean {
  return String(chatId) === String(allowedChatId);
}

export function createCommandDispatcher(
  handlers: Record<string, TelegramCommandHandler>,
): TelegramCommandHandler {
  return async (ctx) => {
    const handler = handlers[ctx.command.name];
    if (!handler) {
      return `Unknown command /${ctx.command.name}.\n${HELP_TEXT}`;
    }
    return handler(ctx);
  };
}

export interface OperatorCommandDeps {
  reviewService: TreasuryReviewService;
  accountingService: AccountingService;
  getHealthInput: () => BuildHealthReportInput;
  pauseStore: OperatorPauseStore;
  /** Env signing flag; /resume reports whether trading is actually effective. */
  signingEnabled: boolean;
}

export function createOperatorCommandHandlers(
  deps: OperatorCommandDeps,
): Record<string, TelegramCommandHandler> {
  return {
    help: () => Promise.resolve(HELP_TEXT),
    start: () => Promise.resolve(HELP_TEXT),
    status: () =>
      Promise.resolve(formatStatusReply(buildHealthReport(deps.getHealthInput()))),
    run: async () => {
      try {
        const run = await deps.reviewService.run("fail");
        return formatReviewAck(run);
      } catch (error) {
        throw mapBusyError(error);
      }
    },
    accounting: async () => {
      try {
        const run = await deps.accountingService.run("fail");
        return formatAccountingAck(run);
      } catch (error) {
        throw mapBusyError(error);
      }
    },
    pause: async () => {
      const already = deps.pauseStore.isPaused();
      await deps.pauseStore.pause("telegram");
      if (already) {
        return "Already paused. Reviews continue as plan-only until /resume.";
      }
      return "Paused. Reviews continue as plan-only until /resume.";
    },
    resume: async () => {
      const wasPaused = deps.pauseStore.isPaused();
      await deps.pauseStore.resume("telegram");
      const trading =
        deps.signingEnabled && !deps.pauseStore.isPaused()
          ? "enabled"
          : "still disabled by ENABLE_TRANSACTION_SIGNING";
      if (!wasPaused) {
        return `Already active. Trading is ${trading}.`;
      }
      return `Resumed. Trading is ${trading}.`;
    },
  };
}

export function formatStatusReply(report: HealthReport): string {
  const lines = [
    `Status: ${report.status}`,
    `Busy: ${report.busy ? "yes" : "no"}`,
    `Paused: ${report.paused ? "yes" : "no"}`,
    `Signing: ${report.signingEnabled ? "enabled" : "disabled"}`,
    `Telegram: configured`,
  ];
  if (report.latestReview) {
    lines.push(
      `Latest review: ${report.latestReview.status} (${report.latestReview.id})${
        report.latestReview.ageSeconds !== null
          ? ` · ${formatAgeShort(report.latestReview.ageSeconds)} ago`
          : ""
      }`,
    );
  } else {
    lines.push("Latest review: none");
  }
  if (report.latestAccounting) {
    lines.push(
      `Latest accounting: ${report.latestAccounting.status} (${report.latestAccounting.id})${
        report.latestAccounting.ageSeconds !== null
          ? ` · ${formatAgeShort(report.latestAccounting.ageSeconds)} ago`
          : ""
      }`,
    );
  } else {
    lines.push("Latest accounting: none");
  }
  if (report.warnings.length > 0) {
    lines.push(`Warnings: ${report.warnings.slice(0, 3).join("; ")}`);
  }
  return lines.join("\n");
}

function formatReviewAck(run: ReviewRun): string {
  return `Review ${run.id} finished: ${run.status}. Full digest sent separately.`;
}

function formatAccountingAck(run: AccountingRun): string {
  return `Accounting ${run.id} finished: ${run.status}. Full digest sent separately.`;
}

function mapBusyError(error: unknown): Error {
  if (
    error instanceof RunInProgressError ||
    error instanceof AccountingRunInProgressError ||
    error instanceof RunCoordinatorBusyError
  ) {
    return new Error("A run is already in progress. Try again shortly.");
  }
  return error instanceof Error ? error : new Error(String(error));
}

function formatAgeShort(ageSeconds: number): string {
  if (ageSeconds < 60) {
    return `${ageSeconds}s`;
  }
  if (ageSeconds < 3_600) {
    return `${Math.floor(ageSeconds / 60)}m`;
  }
  const hours = Math.floor(ageSeconds / 3_600);
  const minutes = Math.floor((ageSeconds % 3_600) / 60);
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

export interface TelegramCommandLoopOptions {
  client: TelegramBotClient;
  allowedChatId: string;
  dispatch: TelegramCommandHandler;
  logger?: TelegramCommandLogger;
  /** Long-poll timeout in seconds (Telegram max 50). */
  pollTimeoutSeconds?: number;
  /** Backoff after transient getUpdates failures. */
  errorBackoffMs?: number;
}

/**
 * Long-polls Telegram getUpdates and dispatches slash commands from the
 * configured chat. Drains pending updates on start so redeploys do not replay
 * stale /run commands.
 */
export class TelegramCommandLoop {
  private readonly client: TelegramBotClient;
  private readonly allowedChatId: string;
  private readonly dispatch: TelegramCommandHandler;
  private readonly logger: TelegramCommandLogger;
  private readonly pollTimeoutSeconds: number;
  private readonly errorBackoffMs: number;
  private offset = 0;
  private running = false;
  private loopPromise: Promise<void> | undefined;
  private abort: AbortController | undefined;

  constructor(options: TelegramCommandLoopOptions) {
    this.client = options.client;
    this.allowedChatId = options.allowedChatId;
    this.dispatch = options.dispatch;
    this.logger = options.logger ?? silentLogger;
    this.pollTimeoutSeconds = options.pollTimeoutSeconds ?? 25;
    this.errorBackoffMs = options.errorBackoffMs ?? 3_000;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.abort = new AbortController();
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.abort?.abort();
    await this.loopPromise?.catch(() => undefined);
    this.loopPromise = undefined;
    this.abort = undefined;
  }

  /** Process a single update (exported for tests). */
  async handleUpdate(update: TelegramUpdate): Promise<void> {
    this.offset = Math.max(this.offset, update.update_id + 1);
    const message = update.message;
    if (!message?.text) {
      return;
    }
    const chatId = String(message.chat.id);
    if (!isAllowedTelegramChat(chatId, this.allowedChatId)) {
      this.logger.warn({ chatId }, "telegram command ignored (chat ACL)");
      return;
    }
    const command = parseTelegramCommand(message.text);
    if (!command) {
      return;
    }

    try {
      const reply = await this.dispatch({ chatId, command });
      await this.client.sendText(chatId, truncateReply(reply));
    } catch (error) {
      const text = sanitizeErrorMessage(error, { maxLength: 400 });
      this.logger.error({ err: text, command: command.name }, "telegram command failed");
      try {
        await this.client.sendText(
          chatId,
          `Command /${command.name} failed: ${sanitizeErrorText(text, { maxLength: 350 })}`,
        );
      } catch (sendError) {
        this.logger.error(
          { err: sanitizeErrorMessage(sendError, { maxLength: 200 }) },
          "telegram command error reply failed",
        );
      }
    }
  }

  private async runLoop(): Promise<void> {
    try {
      await this.drainPendingUpdates();
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      this.logger.warn(
        { err: sanitizeErrorMessage(error, { maxLength: 200 }) },
        "telegram command drain failed; continuing",
      );
    }

    while (this.running) {
      try {
        const updates = await this.client.getUpdates({
          offset: this.offset,
          timeout: this.pollTimeoutSeconds,
          allowed_updates: ["message"],
          signal: this.abort?.signal,
        });
        for (const update of updates) {
          await this.handleUpdate(update);
        }
      } catch (error) {
        if (!this.running || isAbortError(error)) {
          return;
        }
        this.logger.warn(
          { err: sanitizeErrorMessage(error, { maxLength: 200 }) },
          "telegram getUpdates failed; backing off",
        );
        await sleep(this.errorBackoffMs, this.abort?.signal);
      }
    }
  }

  private async drainPendingUpdates(): Promise<void> {
    // Short timeout: fetch whatever is queued without waiting for new messages.
    const updates = await this.client.getUpdates({
      offset: this.offset,
      timeout: 0,
      allowed_updates: ["message"],
      signal: this.abort?.signal,
    });
    for (const update of updates) {
      this.offset = Math.max(this.offset, update.update_id + 1);
    }
    if (updates.length > 0) {
      this.logger.info(
        { drained: updates.length, offset: this.offset },
        "drained stale telegram updates on boot",
      );
    }
  }
}

export function startTelegramCommandLoop(
  options: TelegramCommandLoopOptions,
): TelegramCommandLoop {
  const loop = new TelegramCommandLoop(options);
  loop.start();
  return loop;
}

function truncateReply(text: string, max = 3_500): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name: string }).name === "AbortError")
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const silentLogger: TelegramCommandLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
