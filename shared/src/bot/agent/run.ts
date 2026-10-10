/**
 * The responder: one inbound message in, the messages to send out.
 *
 * FASE 2 shipped this file as a deterministic fallback so the queue pipeline
 * could be tested without an AI endpoint. FASE 3 fills in the agent loop while
 * keeping the fallback, because "the worker stays alive when the AI is down" is an
 * acceptance criterion, not a convenience.
 *
 * Loop shape (work order step 4):
 *
 *   system prompt + history + the customer's message
 *     → model
 *     → if it asked for tools: run EVERY tool call, append the assistant turn and
 *       one tool result per call, then go again
 *     → otherwise: that text is the answer
 *
 * The last turn is sent without `tools`, so the model must produce prose instead
 * of calling another tool — otherwise a chatty model can loop until the turn
 * budget runs out and the customer gets nothing.
 *
 * Two things are deliberately absent: no intermediate text is sent while tool
 * calls are pending (the customer would see "let me check…" followed by the real
 * answer), and `reasoning_content` is never part of any message.
 */
import type { Env, InstanceConfig } from "../../config";
import type { Logger } from "../../lib/logger";
import { loadKnowledge, loadOngkirPolicy } from "../knowledge/loader";
import { parseCatalog, resolveCatalog, type CatalogProduct, type ResolvedProduct } from "../knowledge/catalog";
import { retrieve, type KnowledgeHit } from "../knowledge/search";
import { readCart, cartToPrompt } from "../sales/cart.service";
import type { InboundMessage, OutboundMessage, ReplyContext } from "../types";
import { LlmClient, type LlmMessage } from "./llm";
import { buildSystemPrompt, checkForbidden } from "./prompt";
import { executeTool, TOOL_DEFINITIONS, type ToolContext } from "./tools";

export interface ReplyPlan {
  /** Messages to send, in order. Empty means "answer nothing". */
  messages: OutboundMessage[];
  /** Short machine-readable label for logs: `agent`, `fallback_ai_error`, … */
  reason: string;
}

export type Responder = (context: ReplyContext) => Promise<ReplyPlan>;

export interface AgentOptions {
  env: Pick<Env, "BOT_DB" | "KNOWLEDGE_KV" | "MEDIA" | "R2_PUBLIC_BASE_URL">;
  config: InstanceConfig;
  log: Logger;
  /** Test seam: a preconfigured client (or a double) replaces the default one. */
  llm?: LlmClient;
  deps?: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> };
}

const GREETINGS = [
  "halo",
  "hai",
  "hi",
  "hello",
  "assalamualaikum",
  "assalamu'alaikum",
  "selamat pagi",
  "selamat siang",
  "selamat sore",
  "selamat malam",
  "permisi",
  "pagi",
  "siang",
  "sore",
  "malam",
];

function isGreeting(body: string): boolean {
  const normalised = body.trim().toLowerCase().replace(/[!,.?]+$/g, "");
  return GREETINGS.some((greeting) => normalised === greeting || normalised.startsWith(`${greeting} `));
}

/**
 * Indonesian, short, and deliberately non-committal: it never quotes a price,
 * never promises stock, and always hands the conversation back to a human. A
 * wrong price sent by a fallback would be worse than a slow answer.
 */
export function fallbackReply(message: InboundMessage): string {
  const name = message.pushName.trim().split(/\s+/)[0] ?? "";
  const greeting = name === "" ? "Halo" : `Halo Kak ${name}`;
  if (isGreeting(message.body)) {
    return `${greeting}, terima kasih sudah menghubungi kami. Ada yang bisa kami bantu?`;
  }
  return `${greeting}, pesan Kakak sudah kami terima dan akan segera ditindaklanjuti oleh admin kami. Mohon tunggu sebentar ya.`;
}

// ---------------------------------------------------------------------------
// Catalogue cache: parsing the whole knowledge on every message would be wasteful
// and identical, so the parse result is kept per knowledge text.
// ---------------------------------------------------------------------------

interface CatalogCacheEntry {
  fingerprint: string;
  products: CatalogProduct[];
}

let catalogCache: CatalogCacheEntry | null = null;

export function invalidateCatalogCache(): void {
  catalogCache = null;
}

export function catalogFor(knowledge: string): CatalogProduct[] {
  const fingerprint = String(knowledge.length);
  if (catalogCache && catalogCache.fingerprint === fingerprint) return catalogCache.products;
  const { products } = parseCatalog(knowledge);
  catalogCache = { fingerprint, products };
  return products;
}

/** Everything the loop needs, assembled once per message. */
export interface AgentTurnInput {
  env: Pick<Env, "BOT_DB" | "MEDIA" | "R2_PUBLIC_BASE_URL">;
  config: InstanceConfig;
  log: Logger;
  llm: LlmClient;
  message: InboundMessage;
  history: ReplyContext["history"];
  now: Date;
  botPrompt: string;
  catalog: readonly ResolvedProduct[];
  hits: readonly KnowledgeHit[];
  noContext: boolean;
  cartText: string;
}

/** Conversation starter for the model: system prompt, then the customer message. */
export function buildMessages(input: AgentTurnInput): LlmMessage[] {
  const system = buildSystemPrompt({
    botPrompt: input.botPrompt,
    now: input.now,
    pushName: input.message.pushName,
    hits: input.hits,
    catalog: input.catalog,
    cart: input.cartText,
    orderStatus: null,
    history: input.history,
    noContext: input.noContext,
  });

  return [
    { role: "system", content: system },
    { role: "user", content: input.message.body },
  ];
}

export interface AgentLoopOptions {
  maxTurns: number;
  /** Test seam: replaces the real tool execution. */
  execute?: typeof executeTool;
}

/**
 * Runs the tool-calling loop. Exported so the tests can drive it with a fake model
 * without standing up KV, R2 and D1.
 */
export async function runAgentLoop(
  input: AgentTurnInput,
  options: AgentLoopOptions,
): Promise<{ text: string; outbound: OutboundMessage[]; reason: string; toolCalls: number }> {
  const { log, config, message } = input;
  const messages = buildMessages(input);
  const outbound: OutboundMessage[] = [];
  let toolCalls = 0;
  const turnLimit = Math.max(1, options.maxTurns);

  for (let turn = 1; turn <= turnLimit; turn++) {
    const isLastTurn = turn === turnLimit;
    const result = await input.llm.chat(messages, isLastTurn ? undefined : TOOL_DEFINITIONS);

    if (!result.ok || !result.message) {
      log.error("ai_call_unusable", {
        chatJid: message.chatJid,
        turn,
        error: result.error,
        finishReason: result.finishReason,
      });
      return { text: "", outbound, reason: turn === 1 ? "fallback_ai_error" : "fallback_ai_error_midturn", toolCalls };
    }

    const assistant = result.message;
    const calls = assistant.tool_calls ?? [];

    if (calls.length === 0) {
      const text = (assistant.content ?? "").trim();
      if (text === "") {
        log.error("ai_empty_final", { chatJid: message.chatJid, turn, finishReason: result.finishReason });
        return { text: "", outbound, reason: "fallback_ai_empty", toolCalls };
      }
      return { text, outbound, reason: "agent", toolCalls };
    }

    // Every tool call is executed, not just the first: the model may ask for a
    // cart update and an image in one turn, and skipping one leaves it waiting for
    // a result that never arrives.
    messages.push(assistant);
    const toolContext: ToolContext = {
      env: input.env,
      config,
      chatJid: message.chatJid,
      catalog: input.catalog,
      now: input.now,
      log,
    };
    const run = options.execute ?? executeTool;

    for (const call of calls) {
      toolCalls += 1;
      const outcome = await run(call.name, call.arguments, toolContext);
      if (outcome.outbound.length > 0) outbound.push(...outcome.outbound);
      messages.push({ role: "tool", content: outcome.result, tool_call_id: call.id });
    }
  }

  // Ran out of turns with tool calls still pending: a safe sentence beats silence.
  log.warn("ai_max_turns", { chatJid: message.chatJid, turns: turnLimit, toolCalls });
  return { text: "", outbound, reason: "fallback_max_turns", toolCalls };
}

export function createResponder(options: AgentOptions): Responder {
  const { env, config, log } = options;
  const llm =
    options.llm ??
    new LlmClient({
      baseUrl: config.bot.aiBaseUrl,
      apiKey: config.bot.aiApiKey,
      model: config.bot.aiModel,
      timeoutMs: config.bot.aiTimeoutMs,
      maxTokens: config.bot.aiMaxTokens,
      deps: {
        log,
        ...(options.deps?.fetchImpl ? { fetchImpl: options.deps.fetchImpl } : {}),
        ...(options.deps?.sleep ? { sleep: options.deps.sleep } : {}),
      },
    });

  return async (context: ReplyContext): Promise<ReplyPlan> => {
    const fallback = (reason: string): ReplyPlan => ({
      messages: [{ kind: "text", body: fallbackReply(context.message) }],
      reason,
    });

    if (!llm.configured) {
      log.error("ai_unavailable", { chatJid: context.chatJid, reason: "not_configured" });
      return fallback("fallback_not_configured");
    }

    try {
      const bundle = await loadKnowledge({ env, config, log });
      const policy = await loadOngkirPolicy(env, log);
      const products = catalogFor(bundle?.knowledge ?? "");
      const catalog = resolveCatalog(products, (policy ?? null) as never);

      const retrieval = await retrieve({ env, config, bundle, query: context.message.body, log });

      let cartText = "(keranjang kosong)";
      if (env.BOT_DB) {
        const view = await readCart(env.BOT_DB, context.chatJid, catalog);
        cartText = cartToPrompt(view);
      }

      const outcome = await runAgentLoop(
        {
          env,
          config,
          log,
          llm,
          message: context.message,
          history: context.history,
          now: context.now,
          botPrompt: bundle?.prompt ?? "",
          catalog,
          hits: retrieval.hits,
          noContext: retrieval.intro !== "",
          cartText,
        },
        { maxTurns: config.bot.aiMaxTurns },
      );

      if (outcome.text === "") {
        log.warn("agent_fallback", { chatJid: context.chatJid, reason: outcome.reason, toolCalls: outcome.toolCalls });
        return {
          messages: [...outcome.outbound, { kind: "text", body: fallbackReply(context.message) }],
          reason: outcome.reason,
        };
      }

      // A prompt rule is a request; this is the guarantee. A reply that claims to
      // be an AI or names the system prompt is replaced, not merely logged.
      const verdict = checkForbidden(outcome.text);
      if (!verdict.ok) {
        log.error("agent_reply_forbidden", { chatJid: context.chatJid, reason: verdict.reason });
        return {
          messages: [...outcome.outbound, { kind: "text", body: fallbackReply(context.message) }],
          reason: "fallback_forbidden",
        };
      }

      log.info("ai_call", {
        chatJid: context.chatJid,
        toolCalls: outcome.toolCalls,
        mode: retrieval.mode,
        hits: retrieval.hits.length,
      });
      return { messages: [...outcome.outbound, { kind: "text", body: outcome.text }], reason: outcome.reason };
    } catch (error) {
      log.error("agent_crashed", { chatJid: context.chatJid, error: String(error) });
      return fallback("fallback_crash");
    }
  };
}
