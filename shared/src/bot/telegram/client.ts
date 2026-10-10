/**
 * Telegram Bot API client — the admin approval card and the operator alerts.
 *
 * Deliberately shaped like `bot/wuzapi/client.ts`, because it faces the same
 * failure modes: a send that fails is a normal outcome the caller has to classify
 * (retry, outbox, give up) rather than an exception that unwinds a queue handler.
 * So every method returns a result object, retries 429/5xx with the same
 * 1 s / 2 s / 4 s ladder, and reports `permanent: true` for a 4xx — which is what
 * stops a card from being retried forever against a chat that blocked the bot.
 *
 * Telegram facts this file encodes (they are easy to get wrong):
 *
 *   - the API root is `https://api.telegram.org/bot<token>/<method>`;
 *   - `inline_keyboard` buttons carry `callback_data` (max 64 bytes) — the order
 *     reference and the verb have to fit, which is why they are comma-free;
 *   - `force_reply` is a `reply_markup` that makes the admin's next message a
 *     *reply* to a specific message id — that id is how "Ubah Biaya" finds its
 *     order again (`telegram_pending` in D1);
 *   - a successful call answers `{ ok: true, result: { message_id } }`, a failure
 *     answers `{ ok: false, description }` **with HTTP 200** for some errors, so
 *     the body is checked as well as the status.
 */
import { createLogger, type Logger } from "../../lib/logger";

export interface TelegramResult {
  ok: boolean;
  /** Message id when the call created or edited a message. */
  messageId: number | null;
  error: string;
  /** True when retrying the identical call cannot succeed (4xx). */
  permanent: boolean;
  attempts: number;
}

export interface TelegramInlineButton {
  text: string;
  callback_data: string;
}

export interface TelegramReplyMarkup {
  inline_keyboard?: TelegramInlineButton[][];
  force_reply?: boolean;
  selective?: boolean;
}

export interface SendMessageOptions {
  replyMarkup?: TelegramReplyMarkup;
  /** `HTML` or `MarkdownV2`; omitted sends plain text, which never fails to parse. */
  parseMode?: "HTML" | "MarkdownV2";
  disablePreview?: boolean;
  replyToMessageId?: number;
}

export interface TelegramClientDeps {
  fetchImpl?: typeof fetch;
  log?: Logger;
  sleep?: (ms: number) => Promise<void>;
  retryDelaysMs?: readonly number[];
}

export interface TelegramClientOptions {
  botToken: string;
  chatId: string;
  apiBase?: string;
  timeoutMs?: number;
  deps?: TelegramClientDeps;
}

const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;
const DEFAULT_TIMEOUT_MS = 15_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

interface TelegramEnvelope {
  ok?: boolean;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
  result?: { message_id?: number } | unknown;
}

export class TelegramClient {
  private readonly apiBase: string;
  private readonly chatId: string;
  private readonly botToken: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly retryDelaysMs: readonly number[];
  private readonly log: Logger;

  constructor(options: TelegramClientOptions) {
    const deps = options.deps ?? {};
    // Same trap as the WuzAPI client: an unbound global `fetch` invoked as a
    // method throws "Illegal invocation" in workerd, and tests with an
    // arrow-function double would never notice.
    this.fetchImpl = (deps.fetchImpl ?? fetch).bind(globalThis);
    this.apiBase = (options.apiBase ?? "https://api.telegram.org").replace(/\/+$/, "");
    this.chatId = options.chatId;
    this.botToken = options.botToken;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sleep = deps.sleep ?? defaultSleep;
    this.retryDelaysMs = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.log = deps.log ?? createLogger({ handler: "telegram" });
  }

  get configured(): boolean {
    return this.botToken !== "" && this.chatId !== "";
  }

  async sendMessage(text: string, options: SendMessageOptions = {}): Promise<TelegramResult> {
    const body: Record<string, unknown> = { chat_id: this.chatId, text };
    if (options.parseMode) body["parse_mode"] = options.parseMode;
    if (options.disablePreview) body["link_preview_options"] = { is_disabled: true };
    if (options.replyToMessageId !== undefined) body["reply_to_message_id"] = options.replyToMessageId;
    if (options.replyMarkup) body["reply_markup"] = options.replyMarkup;
    return await this.call("sendMessage", body);
  }

  /**
   * Sends to an explicit chat instead of the configured admin chat; used by the
   * DLQ alerter, which must reach the operator even if a card chat is different.
   */
  async sendMessageTo(chatId: string, text: string, options: SendMessageOptions = {}): Promise<TelegramResult> {
    const body: Record<string, unknown> = { chat_id: chatId, text };
    if (options.parseMode) body["parse_mode"] = options.parseMode;
    if (options.replyMarkup) body["reply_markup"] = options.replyMarkup;
    return await this.call("sendMessage", body);
  }

  async editMessageText(messageId: number, text: string, options: SendMessageOptions = {}): Promise<TelegramResult> {
    const body: Record<string, unknown> = { chat_id: this.chatId, message_id: messageId, text };
    if (options.parseMode) body["parse_mode"] = options.parseMode;
    if (options.replyMarkup) body["reply_markup"] = options.replyMarkup;
    return await this.call("editMessageText", body);
  }

  async answerCallbackQuery(callbackQueryId: string, options: { text?: string; showAlert?: boolean } = {}): Promise<TelegramResult> {
    return await this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(options.text ? { text: options.text } : {}),
      ...(options.showAlert ? { show_alert: true } : {}),
    });
  }

  /** `document` is base64 (no data: prefix) or an https URL Telegram can fetch. */
  async sendDocument(
    document: string,
    fileName: string,
    options: { caption?: string; parseMode?: "HTML" | "MarkdownV2"; mimeType?: string } = {},
  ): Promise<TelegramResult> {
    return await this.call("sendDocument", {
      chat_id: this.chatId,
      document,
      file_name: fileName,
      ...(options.caption ? { caption: options.caption } : {}),
      ...(options.parseMode ? { parse_mode: options.parseMode } : {}),
      ...(options.mimeType ? { mime_type: options.mimeType } : {}),
    });
  }

  private async call(method: string, body: Record<string, unknown>): Promise<TelegramResult> {
    if (!this.configured) {
      return {
        ok: false,
        messageId: null,
        error: "telegram is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)",
        permanent: true,
        attempts: 0,
      };
    }

    const url = `${this.apiBase}/bot${this.botToken}/${method}`;
    const maxAttempts = this.retryDelaysMs.length + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt < maxAttempts) {
          this.log.warn("telegram_retry", { method, attempt, reason: "network", error: message });
          await this.sleep(this.retryDelaysMs[attempt - 1] ?? 4_000);
          continue;
        }
        return { ok: false, messageId: null, error: message, permanent: false, attempts: attempt };
      }

      const text = await safeText(response);
      let envelope: TelegramEnvelope | null = null;
      try {
        envelope = text === "" ? null : (JSON.parse(text) as TelegramEnvelope);
      } catch {
        envelope = null;
      }

      if (response.ok && envelope?.ok === true) {
        return {
          ok: true,
          messageId: extractMessageId(envelope),
          error: "",
          permanent: false,
          attempts: attempt,
        };
      }

      const error = envelope?.description ?? (text === "" ? `HTTP ${response.status}` : text.slice(0, 300));
      const retryAfter = envelope?.parameters?.retry_after;
      if (isRetryableStatus(response.status) && attempt < maxAttempts) {
        const waitMs = typeof retryAfter === "number" && retryAfter > 0 ? retryAfter * 1_000 : (this.retryDelaysMs[attempt - 1] ?? 4_000);
        this.log.warn("telegram_retry", { method, attempt, status: response.status, error });
        await this.sleep(waitMs);
        continue;
      }

      return {
        ok: false,
        messageId: null,
        error,
        // Telegram answers 200 with `ok: false` for e.g. "message is not
        // modified" or "bot was blocked": retrying cannot help.
        permanent: !isRetryableStatus(response.status),
        attempts: attempt,
      };
    }

    return { ok: false, messageId: null, error: "exhausted", permanent: false, attempts: maxAttempts };
  }
}

function extractMessageId(envelope: TelegramEnvelope): number | null {
  const result = envelope.result;
  if (typeof result !== "object" || result === null) return null;
  const id = (result as { message_id?: unknown }).message_id;
  return typeof id === "number" ? id : null;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
