import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountingRunInProgressError } from "../src/services/accounting.js";
import type { OperatorPauseStore } from "../src/services/operator-pause.js";
import { RunCoordinatorBusyError } from "../src/services/run-coordinator.js";
import {
  TelegramBotClient,
  type TelegramUpdate,
} from "../src/services/telegram-bot.js";
import {
  createCommandDispatcher,
  createOperatorCommandHandlers,
  formatStatusReply,
  isAllowedTelegramChat,
  parseTelegramCommand,
  TelegramCommandLoop,
} from "../src/services/telegram-commands.js";
import { RunInProgressError } from "../src/services/treasury-review.js";
import type { HealthReport } from "../src/services/health.js";

function mockPauseStore(): OperatorPauseStore {
  let paused = false;
  return {
    isPaused: () => paused,
    getState: () => ({
      paused,
      updatedAt: null,
      source: null,
    }),
    hydrate: vi.fn(),
    pause: vi.fn(async () => {
      paused = true;
      return {
        paused: true,
        updatedAt: "2026-07-30T00:00:00.000Z",
        source: "telegram" as const,
      };
    }),
    resume: vi.fn(async () => {
      paused = false;
      return {
        paused: false,
        updatedAt: "2026-07-30T00:00:00.000Z",
        source: "telegram" as const,
      };
    }),
  } as unknown as OperatorPauseStore;
}

function baseHandlerDeps(
  overrides: Partial<Parameters<typeof createOperatorCommandHandlers>[0]> = {},
) {
  return {
    reviewService: {
      run: vi.fn().mockRejectedValue(new RunInProgressError()),
    } as never,
    accountingService: {
      run: vi.fn().mockRejectedValue(new AccountingRunInProgressError()),
    } as never,
    pauseStore: mockPauseStore(),
    signingEnabled: false,
    getHealthInput: () => ({
      signingEnabled: false,
      paused: false,
      telegramConfigured: true,
      accountingStorage: "local" as const,
      folksEscrowStorage: "local" as const,
      busy: true,
    }),
    ...overrides,
  };
}

function commandCtx(
  overrides: Partial<{
    chatId: string;
    command: { name: string; args: string; raw: string };
    reply: (text: string) => Promise<void>;
  }> = {},
) {
  return {
    chatId: "1",
    command: { name: "help", args: "", raw: "/help" },
    reply: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("parseTelegramCommand", () => {
  it("parses slash commands and strips bot username", () => {
    expect(parseTelegramCommand("/run")).toEqual({
      name: "run",
      args: "",
      raw: "/run",
    });
    expect(parseTelegramCommand("/run@BrownieBot now")).toEqual({
      name: "run",
      args: "now",
      raw: "/run@BrownieBot now",
    });
    expect(parseTelegramCommand("/STATUS")).toEqual({
      name: "status",
      args: "",
      raw: "/STATUS",
    });
  });

  it("returns undefined for non-commands", () => {
    expect(parseTelegramCommand(undefined)).toBeUndefined();
    expect(parseTelegramCommand("hello")).toBeUndefined();
    expect(parseTelegramCommand("/")).toBeUndefined();
    expect(parseTelegramCommand("  ")).toBeUndefined();
  });
});

describe("isAllowedTelegramChat", () => {
  it("accepts matching chat ids as string or number", () => {
    expect(isAllowedTelegramChat("123", "123")).toBe(true);
    expect(isAllowedTelegramChat(123, "123")).toBe(true);
    expect(isAllowedTelegramChat("999", "123")).toBe(false);
  });
});

describe("createCommandDispatcher", () => {
  it("routes known commands and hints on unknown", async () => {
    const dispatch = createCommandDispatcher({
      help: () => Promise.resolve("help-ok"),
    });
    await expect(
      dispatch(commandCtx({ command: { name: "help", args: "", raw: "/help" } })),
    ).resolves.toBe("help-ok");

    const unknown = await dispatch(
      commandCtx({ command: { name: "nope", args: "", raw: "/nope" } }),
    );
    expect(unknown).toContain("Unknown command /nope");
    expect(unknown).toContain("/status");
  });
});

describe("createOperatorCommandHandlers", () => {
  it("returns help, status, and busy-friendly run errors", async () => {
    const handlers = createOperatorCommandHandlers(baseHandlerDeps());

    await expect(
      handlers.help!(commandCtx({ command: { name: "help", args: "", raw: "/help" } })),
    ).resolves.toContain("/pause");

    const status = await handlers.status!(
      commandCtx({ command: { name: "status", args: "", raw: "/status" } }),
    );
    expect(status).toContain("Busy: yes");
    expect(status).toContain("Paused: no");
    expect(status).toContain("Signing: disabled");

    await expect(
      handlers.run!(commandCtx({ command: { name: "run", args: "", raw: "/run" } })),
    ).rejects.toThrow(/already in progress/i);

    await expect(
      handlers.accounting!(
        commandCtx({ command: { name: "accounting", args: "", raw: "/accounting" } }),
      ),
    ).rejects.toThrow(/already in progress/i);
  });

  it("maps coordinator busy via health busy flag before starting", async () => {
    const run = vi.fn().mockRejectedValue(new RunCoordinatorBusyError());
    const handlers = createOperatorCommandHandlers(
      baseHandlerDeps({
        reviewService: { run } as never,
        signingEnabled: true,
        getHealthInput: () => ({
          signingEnabled: true,
          paused: false,
          telegramConfigured: true,
          accountingStorage: "local",
          folksEscrowStorage: "local",
          busy: true,
        }),
      }),
    );

    await expect(
      handlers.run!(commandCtx({ command: { name: "run", args: "", raw: "/run" } })),
    ).rejects.toThrow(/already in progress/i);
    expect(run).not.toHaveBeenCalled();
  });

  it("acks start immediately and replies when the background run finishes", async () => {
    let release: (() => void) | undefined;
    const run = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              id: "rev-1",
              status: "no-op",
            });
        }),
    );
    const reply = vi.fn().mockResolvedValue(undefined);
    const handlers = createOperatorCommandHandlers(
      baseHandlerDeps({
        reviewService: { run } as never,
        accountingService: {
          run: vi.fn().mockResolvedValue({
            id: "acc-1",
            status: "reported",
          }),
        } as never,
        signingEnabled: true,
        getHealthInput: () => ({
          signingEnabled: true,
          paused: false,
          telegramConfigured: true,
          accountingStorage: "local",
          folksEscrowStorage: "local",
          busy: false,
        }),
      }),
    );

    await expect(
      handlers.run!(
        commandCtx({
          command: { name: "run", args: "", raw: "/run" },
          reply,
        }),
      ),
    ).resolves.toContain("Treasury review starting");
    expect(run).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();

    release?.();
    await vi.waitFor(() => {
      expect(reply).toHaveBeenCalledWith(
        expect.stringContaining("Review rev-1 finished: no-op"),
      );
    });

    const accountingReply = vi.fn().mockResolvedValue(undefined);
    await expect(
      handlers.accounting!(
        commandCtx({
          command: { name: "accounting", args: "", raw: "/accounting" },
          reply: accountingReply,
        }),
      ),
    ).resolves.toContain("Accounting snapshot starting");
    await vi.waitFor(() => {
      expect(accountingReply).toHaveBeenCalledWith(
        expect.stringContaining("Accounting acc-1 finished: reported"),
      );
    });
  });

  it("pauses and resumes trading with idempotent replies", async () => {
    const pauseStore = mockPauseStore();
    const handlers = createOperatorCommandHandlers(
      baseHandlerDeps({ pauseStore, signingEnabled: true }),
    );

    await expect(
      handlers.pause!(
        commandCtx({ command: { name: "pause", args: "", raw: "/pause" } }),
      ),
    ).resolves.toContain("Paused. Reviews continue as plan-only");

    await expect(
      handlers.pause!(
        commandCtx({ command: { name: "pause", args: "", raw: "/pause" } }),
      ),
    ).resolves.toContain("Already paused");

    await expect(
      handlers.resume!(
        commandCtx({ command: { name: "resume", args: "", raw: "/resume" } }),
      ),
    ).resolves.toContain("Resumed. Trading is enabled");

    await expect(
      handlers.resume!(
        commandCtx({ command: { name: "resume", args: "", raw: "/resume" } }),
      ),
    ).resolves.toContain("Already active. Trading is enabled");
  });

  it("notes when resume cannot enable signing", async () => {
    const pauseStore = mockPauseStore();
    await pauseStore.pause("telegram");
    const handlers = createOperatorCommandHandlers(
      baseHandlerDeps({ pauseStore, signingEnabled: false }),
    );

    await expect(
      handlers.resume!(
        commandCtx({ command: { name: "resume", args: "", raw: "/resume" } }),
      ),
    ).resolves.toContain("still disabled by ENABLE_TRANSACTION_SIGNING");
  });

  it("records deposits and withdrawals from txids", async () => {
    const recordCashflowFromTx = vi.fn().mockResolvedValue({
      cashflow: { amountUsd: "100.00", notes: "100 USDC" },
      amountLabel: "100 USDC",
      alreadyRecorded: false,
    });
    const handlers = createOperatorCommandHandlers(
      baseHandlerDeps({
        accountingService: { run: vi.fn(), recordCashflowFromTx } as never,
      }),
    );

    await expect(
      handlers.deposit!(
        commandCtx({ command: { name: "deposit", args: "", raw: "/deposit" } }),
      ),
    ).resolves.toContain("Usage: /deposit <txid>");

    await expect(
      handlers.deposit!(
        commandCtx({
          command: {
            name: "deposit",
            args: "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
            raw: "/deposit ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
          },
        }),
      ),
    ).resolves.toContain("Recorded deposit: $100.00 (100 USDC)");
    expect(recordCashflowFromTx).toHaveBeenCalledWith({
      type: "external_deposit",
      transactionId: "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
    });
  });

  it("acks already-recorded cashflows without failing", async () => {
    const { CashflowAlreadyRecordedError } = await import(
      "../src/services/accounting.js"
    );
    const handlers = createOperatorCommandHandlers(
      baseHandlerDeps({
        accountingService: {
          run: vi.fn(),
          recordCashflowFromTx: vi.fn().mockRejectedValue(
            new CashflowAlreadyRecordedError({
              schemaVersion: 1,
              eventId: "TX1",
              walletAddress: "W",
              type: "external_withdrawal",
              amountUsd: "5.00",
              occurredAt: "2026-07-15T00:00:00.000Z",
              recordedAt: "2026-07-15T00:00:00.000Z",
              notes: "5 USDC (asset 31566704) to ADDR",
              checksum: "x",
            }),
          ),
        } as never,
      }),
    );

    await expect(
      handlers.withdraw!(
        commandCtx({
          command: { name: "withdraw", args: "TX1", raw: "/withdraw TX1" },
        }),
      ),
    ).resolves.toContain("Already recorded withdrawal: $5.00");
  });
});

describe("formatStatusReply", () => {
  it("summarizes health without dumping the full JSON", () => {
    const report: HealthReport = {
      status: "degraded",
      mode: "autonomous",
      signingEnabled: true,
      paused: true,
      walletConfigured: true,
      telegramConfigured: true,
      accountingEnabled: true,
      accountingStorage: "local",
      folksEscrowStorage: "local",
      busy: false,
      latestReview: {
        id: "r1",
        status: "confirmed",
        completedAt: "2026-07-24T12:00:00.000Z",
        ageSeconds: 120,
        failed: false,
      },
      latestAccounting: null,
      warnings: ["Trading paused (plan-only)"],
    };
    const text = formatStatusReply(report);
    expect(text).toContain("Status: degraded");
    expect(text).toContain("Paused: yes");
    expect(text).toContain("Latest review: confirmed (r1)");
    expect(text).toContain("Latest accounting: none");
    expect(text).toContain("Warnings:");
  });
});

describe("TelegramBotClient", () => {
  it("calls getUpdates and sendText against the Bot API", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            ok: true,
            result: [
              {
                update_id: 7,
                message: { message_id: 1, text: "/help", chat: { id: 1 } },
              },
            ],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true, result: true }),
      });

    const client = new TelegramBotClient("token", fetchImpl as typeof fetch);
    const updates = await client.getUpdates({ offset: 1, timeout: 0 });
    expect(updates).toHaveLength(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://api.telegram.org/bottoken/getUpdates",
    );

    await client.sendText("42", "hello");
    const secondCall = fetchImpl.mock.calls[1]?.[1] as
      | { body?: string }
      | undefined;
    const sendBody = JSON.parse(String(secondCall?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    expect(sendBody.chat_id).toBe("42");
    expect(sendBody.text).toBe("hello");
  });
});

describe("TelegramCommandLoop", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores unauthorized chats and unknown non-commands", async () => {
    const sendText = vi.fn();
    const client = {
      getUpdates: vi.fn(),
      sendText,
    } as unknown as TelegramBotClient;
    const dispatch = vi.fn().mockResolvedValue("ok");
    const loop = new TelegramCommandLoop({
      client,
      allowedChatId: "allowed",
      dispatch,
    });

    await loop.handleUpdate({
      update_id: 1,
      message: { message_id: 1, text: "/run", chat: { id: "other" } },
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();

    await loop.handleUpdate({
      update_id: 2,
      message: { message_id: 2, text: "not a command", chat: { id: "allowed" } },
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dispatches allowed commands and replies", async () => {
    const sendText = vi.fn().mockResolvedValue(undefined);
    const client = {
      getUpdates: vi.fn(),
      sendText,
    } as unknown as TelegramBotClient;
    const dispatch = vi.fn().mockResolvedValue("status-ok");
    const loop = new TelegramCommandLoop({
      client,
      allowedChatId: "9",
      dispatch,
    });

    await loop.handleUpdate({
      update_id: 10,
      message: {
        message_id: 3,
        text: "/status@Bot",
        chat: { id: 9 },
      },
    });

    expect(dispatch).toHaveBeenCalledWith({
      chatId: "9",
      command: { name: "status", args: "", raw: "/status@Bot" },
      reply: expect.any(Function),
    });
    expect(sendText).toHaveBeenCalledWith("9", "status-ok");
  });

  it("replies with a sanitized error when the handler throws", async () => {
    const sendText = vi.fn().mockResolvedValue(undefined);
    const client = {
      getUpdates: vi.fn(),
      sendText,
    } as unknown as TelegramBotClient;
    const loop = new TelegramCommandLoop({
      client,
      allowedChatId: "1",
      dispatch: () => Promise.reject(new Error("boom")),
    });

    await loop.handleUpdate({
      update_id: 3,
      message: { message_id: 1, text: "/run", chat: { id: "1" } },
    });

    expect(sendText).toHaveBeenCalledWith(
      "1",
      expect.stringContaining("Command /run failed:"),
    );
  });

  it("drains stale updates on start then processes new ones", async () => {
    const stale: TelegramUpdate[] = [
      {
        update_id: 100,
        message: { message_id: 1, text: "/run", chat: { id: "1" } },
      },
    ];
    const fresh: TelegramUpdate[] = [
      {
        update_id: 101,
        message: { message_id: 2, text: "/help", chat: { id: "1" } },
      },
    ];
    const getUpdates = vi
      .fn()
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(fresh)
      .mockImplementation(({ signal }: { signal?: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      });
    const sendText = vi.fn().mockResolvedValue(undefined);
    const client = {
      getUpdates,
      sendText,
    } as unknown as TelegramBotClient;
    const dispatch = vi.fn().mockResolvedValue("help-text");
    const loop = new TelegramCommandLoop({
      client,
      allowedChatId: "1",
      dispatch,
      pollTimeoutSeconds: 1,
      errorBackoffMs: 10,
    });

    loop.start();
    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalled();
    });
    await loop.stop();

    expect(dispatch).toHaveBeenCalledTimes(1);
    const firstCall = dispatch.mock.calls[0]?.[0] as
      | { command: { name: string } }
      | undefined;
    expect(firstCall?.command.name).toBe("help");
    expect(getUpdates.mock.calls[0]?.[0]).toMatchObject({ timeout: 0 });
  });
});
