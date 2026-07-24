/**
 * Thin Telegram Bot API client for inbound long-polling and plain text replies.
 * Outbound run digests stay on TelegramNotifier in telegram.ts.
 */

export interface TelegramChat {
  id: number | string;
}

export interface TelegramMessage {
  message_id: number;
  text?: string;
  chat: TelegramChat;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface GetUpdatesOptions {
  offset?: number;
  timeout?: number;
  allowed_updates?: string[];
  signal?: AbortSignal;
}

export class TelegramBotClient {
  constructor(
    private readonly botToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getUpdates(options: GetUpdatesOptions = {}): Promise<TelegramUpdate[]> {
    const body: Record<string, unknown> = {
      allowed_updates: options.allowed_updates ?? ["message"],
    };
    if (options.offset !== undefined) {
      body.offset = options.offset;
    }
    if (options.timeout !== undefined) {
      body.timeout = options.timeout;
    }
    const result = await this.call<TelegramUpdate[]>(
      "getUpdates",
      body,
      options.signal,
    );
    return Array.isArray(result) ? result : [];
  }

  async sendText(
    chatId: string,
    text: string,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    await this.call(
      "sendMessage",
      {
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      },
      options?.signal,
    );
  }

  private async call<T = unknown>(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.fetchImpl(
      `https://api.telegram.org/bot${this.botToken}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      },
    );
    const payload = (await response.json()) as {
      ok?: boolean;
      description?: string;
      result?: T;
    };
    if (!response.ok || payload.ok === false) {
      throw new Error(
        `Telegram API ${method} failed (HTTP ${response.status})${
          payload.description ? `: ${payload.description}` : ""
        }`,
      );
    }
    return payload.result as T;
  }
}
