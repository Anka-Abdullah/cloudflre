/**
 * Thin client for the wuzapi REST API (work plan Q17).
 *
 * Only the endpoints the bot needs are wrapped, and every wrapper returns a
 * result object instead of throwing: a send failure is a normal outcome that the
 * caller has to classify (retry, outbox, or give up), not an exception that
 * unwinds the queue handler.
 *
 * Wire facts taken from the Go source rather than from the docs:
 *
 *   wuzapi/handlers.go authalice()  → the token travels in the `Token` header
 *   wuzapi/handlers.go Respond()    → body is { code, success, data | error }
 *   wuzapi/handlers.go SendMessage()→ POST /chat/send/text { Phone, Body, Id? }
 *   wuzapi/handlers.go SendImage()  → POST /chat/send/image { Phone, Image, Caption? }
 *   wuzapi/handlers.go SendDocument()→ POST /chat/send/document { Phone, Document, FileName }
 *   wuzapi/handlers.go ChatPresence()→ POST /chat/presence { Phone, State, Media }
 *
 * `Phone` accepts a full JID (`628…@s.whatsapp.net`) because wuzapi's
 * `resolveMessageRecipient` short-circuits when the value already contains `@`.
 */
import { createLogger, type Logger } from "../../lib/logger";

export interface WuzapiSendResult {
  ok: boolean;
  /** wuzapi/WhatsApp message id when the send succeeded. */
  messageId: string | null;
  /** HTTP status, or null when the request never produced a response. */
  status: number | null;
  error: string;
  /** True when retrying the exact same call cannot succeed (4xx). */
  permanent: boolean;
  attempts: number;
}

export interface WuzapiClientDeps {
  fetchImpl?: typeof fetch;
  log?: Logger;
  sleep?: (ms: number) => Promise<void>;
  /** Backoff for 429/5xx/network failures; the plan's 1s/2s/4s ladder. */
  retryDelaysMs?: readonly number[];
}

export interface WuzapiClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  deps?: WuzapiClientDeps;
}

const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;
const DEFAULT_TIMEOUT_MS = 20_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

interface WuzapiEnvelope {
  code?: number;
  success?: boolean;
  data?: unknown;
  error?: string;
}

export class WuzapiClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly retryDelaysMs: readonly number[];
  private readonly log: Logger;

  constructor(options: WuzapiClientOptions) {
    const deps = options.deps ?? {};
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Bound on purpose. Storing the global `fetch` in a field and calling it as
    // `this.fetchImpl(...)` invokes it with `this` set to this client, and workerd
    // rejects that with "Illegal invocation: function called with incorrect `this`
    // reference" — every outbound send would fail. Tests did not catch it because
    // they inject an arrow-function double, which ignores `this`; the runtime test
    // in wrangler dev did. Binding here keeps any future call site correct.
    this.fetchImpl = (deps.fetchImpl ?? fetch).bind(globalThis);
    this.sleep = deps.sleep ?? defaultSleep;
    this.retryDelaysMs = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.log = deps.log ?? createLogger({ handler: "wuzapi" });
  }

  /** True when the client has everything it needs to attempt a call. */
  get configured(): boolean {
    return this.baseUrl !== "" && this.token !== "";
  }

  async sendText(phone: string, body: string, options: { id?: string } = {}): Promise<WuzapiSendResult> {
    return await this.call("/chat/send/text", { Phone: phone, Body: body, ...(options.id ? { Id: options.id } : {}) });
  }

  async sendImage(
    phone: string,
    image: string,
    caption: string,
    options: { mimeType?: string; id?: string } = {},
  ): Promise<WuzapiSendResult> {
    return await this.call("/chat/send/image", {
      Phone: phone,
      Image: image,
      Caption: caption,
      ...(options.mimeType ? { MimeType: options.mimeType } : {}),
      ...(options.id ? { Id: options.id } : {}),
    });
  }

  async sendDocument(
    phone: string,
    document: string,
    fileName: string,
    options: { caption?: string; mimeType?: string; id?: string } = {},
  ): Promise<WuzapiSendResult> {
    return await this.call("/chat/send/document", {
      Phone: phone,
      Document: document,
      FileName: fileName,
      ...(options.caption ? { Caption: options.caption } : {}),
      ...(options.mimeType ? { MimeType: options.mimeType } : {}),
      ...(options.id ? { Id: options.id } : {}),
    });
  }

  /** `composing` shows the "typing…" bubble; `paused` clears it. */
  async sendPresence(phone: string, state: "composing" | "paused"): Promise<WuzapiSendResult> {
    return await this.call("/chat/presence", { Phone: phone, State: state, Media: "" });
  }

  /** `GET /user/contacts` — the raw `{ "<jid>": ContactInfo }` map. */
  async getContacts(): Promise<{ ok: boolean; contacts: Record<string, unknown>; error: string }> {
    const result = await this.request("/user/contacts", null, "GET");
    if (!result.ok) return { ok: false, contacts: {}, error: result.error };
    const data = result.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return { ok: false, contacts: {}, error: "unexpected /user/contacts payload" };
    }
    return { ok: true, contacts: data as Record<string, unknown>, error: "" };
  }

  private async call(path: string, body: Record<string, unknown>): Promise<WuzapiSendResult> {
    const outcome = await this.request(path, body, "POST");
    return {
      ok: outcome.ok,
      messageId: outcome.messageId,
      status: outcome.status,
      error: outcome.error,
      permanent: outcome.permanent,
      attempts: outcome.attempts,
    };
  }

  private async request(
    path: string,
    body: Record<string, unknown> | null,
    method: "POST" | "GET",
  ): Promise<WuzapiSendResult & { data: unknown }> {
    if (!this.configured) {
      return {
        ok: false,
        messageId: null,
        status: null,
        error: "wuzapi is not configured (WUZAPI_API_BASE / WUZAPI_TOKEN)",
        permanent: true,
        attempts: 0,
        data: null,
      };
    }

    const url = `${this.baseUrl}${path}`;
    const maxAttempts = this.retryDelaysMs.length + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: {
            "content-type": "application/json",
            token: this.token,
          },
          ...(body === null ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt < maxAttempts) {
          this.log.warn("wuzapi_retry", { path, attempt, reason: "network", error: message });
          await this.sleep(this.retryDelaysMs[attempt - 1] ?? 4_000);
          continue;
        }
        return { ok: false, messageId: null, status: null, error: message, permanent: false, attempts: attempt, data: null };
      }

      const text = await safeText(response);
      let envelope: WuzapiEnvelope | null = null;
      try {
        envelope = text === "" ? null : (JSON.parse(text) as WuzapiEnvelope);
      } catch {
        envelope = null;
      }

      if (response.ok && (envelope === null || envelope.success !== false)) {
        return {
          ok: true,
          messageId: extractMessageId(envelope),
          status: response.status,
          error: "",
          permanent: false,
          attempts: attempt,
          data: envelope?.data ?? null,
        };
      }

      const error = envelope?.error ?? text.slice(0, 300) ?? `HTTP ${response.status}`;
      if (isRetryableStatus(response.status) && attempt < maxAttempts) {
        this.log.warn("wuzapi_retry", { path, attempt, status: response.status, error });
        await this.sleep(this.retryDelaysMs[attempt - 1] ?? 4_000);
        continue;
      }

      return {
        ok: false,
        messageId: null,
        status: response.status,
        error: error === "" ? `HTTP ${response.status}` : error,
        permanent: !isRetryableStatus(response.status),
        attempts: attempt,
        data: null,
      };
    }

    // Unreachable: the loop returns on the last attempt.
    return { ok: false, messageId: null, status: null, error: "exhausted", permanent: false, attempts: maxAttempts, data: null };
  }
}

/** wuzapi returns `{ data: { Id: "..." } }` for a successful send. */
function extractMessageId(envelope: WuzapiEnvelope | null): string | null {
  const data = envelope?.data;
  if (typeof data !== "object" || data === null) return null;
  const id = (data as Record<string, unknown>)["Id"] ?? (data as Record<string, unknown>)["id"];
  if (typeof id === "string" && id !== "") return id;
  const details = (data as Record<string, unknown>)["Details"];
  return typeof details === "string" ? details : null;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
