/**
 * OpenAI-compatible chat client for the agent.
 *
 * Behaviour that this model required in practice (work order FASE 3; verified by
 * scripts/smoke-ai.mjs):
 *
 *  - `reasoning_content` is the model's private scratchpad. It is dropped on the
 *    way in, so it can never be appended to the conversation and never be sent to
 *    a customer. `content` is null on a tool-calling turn, which is legitimate.
 *  - `finish_reason: "length"` with nothing usable means the output budget was
 *    spent before an answer appeared. That is a configuration fault (AI_MAX_TOKENS
 *    too small), so it is reported as an error rather than retried forever.
 *  - 429/5xx/network are retried on the 1s/2s/4s ladder, the same ladder the
 *    WuzAPI client uses, and the whole call is bounded by AI_TIMEOUT_MS.
 */
import type { Logger } from "../../lib/logger";
import { createLogger } from "../../lib/logger";

export interface LlmToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LlmToolCall {
  id: string;
  name: string;
  /** Raw JSON string exactly as the model produced it; parsed by the caller. */
  arguments: string;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** Assistant turns only. */
  tool_calls?: LlmToolCall[];
  /** Tool result turns only. */
  tool_call_id?: string;
}

export interface LlmResult {
  ok: boolean;
  message: LlmMessage | null;
  finishReason: string;
  error: string;
  attempts: number;
}

export interface LlmClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
  temperature?: number;
  deps?: {
    fetchImpl?: typeof fetch;
    log?: Logger;
    sleep?: (ms: number) => Promise<void>;
    retryDelaysMs?: readonly number[];
  };
}

const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

interface RawMessage {
  content?: unknown;
  tool_calls?: unknown;
  reasoning_content?: unknown;
}

function parseToolCalls(raw: unknown): LlmToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: LlmToolCall[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const fn = record["function"];
    const fnRecord = typeof fn === "object" && fn !== null ? (fn as Record<string, unknown>) : null;
    const name = typeof fnRecord?.["name"] === "string" ? fnRecord["name"] : "";
    if (name === "") continue;
    calls.push({
      id: typeof record["id"] === "string" ? record["id"] : `call_${calls.length}`,
      name,
      arguments: typeof fnRecord?.["arguments"] === "string" ? fnRecord["arguments"] : "{}",
    });
  }
  return calls;
}

export class LlmClient {
  private readonly options: LlmClientOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly retryDelaysMs: readonly number[];
  private readonly log: Logger;

  constructor(options: LlmClientOptions) {
    const deps = options.deps ?? {};
    this.options = options;
    // Bound: calling the global fetch as a method of this object makes workerd
    // throw "Illegal invocation". Same trap as the WuzAPI client.
    this.fetchImpl = (deps.fetchImpl ?? fetch).bind(globalThis);
    this.sleep = deps.sleep ?? defaultSleep;
    this.retryDelaysMs = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.log = deps.log ?? createLogger({ handler: "llm" });
  }

  get configured(): boolean {
    return this.options.baseUrl !== "" && this.options.apiKey !== "" && this.options.model !== "";
  }

  /**
   * One completion. `tools` is omitted on the final turn so the model must answer
   * instead of calling another tool (work order: "turn terakhir tanpa tools").
   */
  async chat(messages: readonly LlmMessage[], tools?: readonly LlmToolDefinition[]): Promise<LlmResult> {
    if (!this.configured) {
      return { ok: false, message: null, finishReason: "", error: "AI is not configured", attempts: 0 };
    }

    const body: Record<string, unknown> = {
      model: this.options.model,
      messages: messages.map(toWireMessage),
      max_tokens: this.options.maxTokens,
      temperature: this.options.temperature ?? 0.3,
    };
    if (tools && tools.length > 0) {
      body["tools"] = tools;
      body["tool_choice"] = "auto";
    }

    const url = `${this.options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const maxAttempts = this.retryDelaysMs.length + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.options.apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (attempt < maxAttempts) {
          this.log.warn("ai_call_retry", { attempt, reason: "network", error: detail });
          await this.sleep(this.retryDelaysMs[attempt - 1] ?? 4_000);
          continue;
        }
        this.log.error("ai_call_failed", { attempt, reason: "network", error: detail });
        return { ok: false, message: null, finishReason: "", error: detail, attempts: attempt };
      }

      const text = await safeText(response);
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = text === "" ? null : (JSON.parse(text) as Record<string, unknown>);
      } catch {
        parsed = null;
      }

      if (response.ok && parsed) {
        const choices = parsed["choices"];
        const first = Array.isArray(choices) ? choices[0] : null;
        const choice = typeof first === "object" && first !== null ? (first as Record<string, unknown>) : null;
        const rawMessage = choice?.["message"];
        const message = typeof rawMessage === "object" && rawMessage !== null ? (rawMessage as RawMessage) : null;
        const finishReason = typeof choice?.["finish_reason"] === "string" ? (choice["finish_reason"] as string) : "";

        const content = typeof message?.content === "string" ? message.content : null;
        const toolCalls = parseToolCalls(message?.tool_calls);
        // reasoning_content is intentionally not read into the result at all.

        if (toolCalls.length === 0 && (content === null || content.trim() === "")) {
          const reason = finishReason === "length" ? "output budget exhausted (AI_MAX_TOKENS too small)" : "empty response";
          this.log.error("ai_call_empty", { finishReason, reason, attempt });
          return { ok: false, message: null, finishReason, error: reason, attempts: attempt };
        }

        return {
          ok: true,
          // reasoning_content is never part of this message, so the caller cannot
          // accidentally append it to the conversation.
          message: toolCalls.length > 0 ? { role: "assistant", content, tool_calls: toolCalls } : { role: "assistant", content },
          finishReason,
          error: "",
          attempts: attempt,
        };
      }

      const errorRecord = parsed?.["error"];
      const detail =
        typeof errorRecord === "string"
          ? errorRecord
          : errorRecord
            ? JSON.stringify(errorRecord).slice(0, 300)
            : text.slice(0, 300) || `HTTP ${response.status}`;

      if (isRetryable(response.status) && attempt < maxAttempts) {
        this.log.warn("ai_call_retry", { attempt, status: response.status, error: detail });
        await this.sleep(this.retryDelaysMs[attempt - 1] ?? 4_000);
        continue;
      }

      this.log.error("ai_call_failed", { attempt, status: response.status, error: detail });
      return { ok: false, message: null, finishReason: "", error: detail, attempts: attempt };
    }

    return { ok: false, message: null, finishReason: "", error: "exhausted", attempts: maxAttempts };
  }
}

/**
 * Wire format. Only role/content/tool_calls/tool_call_id are ever sent: a
 * `reasoning_content` field must not exist on the way out, or the model would see
 * its own scratchpad echoed back as if it had said it.
 */
function toWireMessage(message: LlmMessage): Record<string, unknown> {
  const wire: Record<string, unknown> = { role: message.role, content: message.content ?? "" };
  if (message.tool_calls && message.tool_calls.length > 0) {
    wire["content"] = message.content;
    wire["tool_calls"] = message.tool_calls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  if (message.tool_call_id) wire["tool_call_id"] = message.tool_call_id;
  return wire;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
