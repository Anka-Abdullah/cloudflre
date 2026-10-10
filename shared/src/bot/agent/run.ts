/**
 * The responder seam.
 *
 * Phase 2 answers every allowed message with a deterministic, AI-free reply so
 * the queue pipeline, the lock, the history and the WuzAPI client can be tested
 * end to end without an AI endpoint. Phase 3 replaces the body of
 * `createResponder` with the prompt + tool-calling loop (`agent/prompt.ts`,
 * `agent/llm.ts`, `agent/tools.ts`); the exported `Responder`/`ReplyPlan`
 * contract stays the same, so nothing downstream changes.
 *
 * Keeping a non-AI reply is not only a testing convenience: "the worker must stay
 * alive while the AI is down" is an acceptance criterion, so this path is also
 * the production fallback when the model times out or returns nothing usable.
 */
import type { Logger } from "../../lib/logger";
import type { InboundMessage, OutboundMessage, ReplyContext } from "../types";

export interface ReplyPlan {
  /** Messages to send, in order. Empty means "answer nothing". */
  messages: OutboundMessage[];
  /** Short machine-readable label for logs: `fallback_greeting`, `llm_turn`, … */
  reason: string;
}

export type Responder = (context: ReplyContext) => Promise<ReplyPlan>;

export interface AgentOptions {
  slug: string;
  /** AI_MAX_TURNS; phase 3's tool loop stops after this many assistant turns. */
  maxTurns: number;
  log: Logger;
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
  return (
    `${greeting}, pesan Kakak sudah kami terima dan akan segera ditindaklanjuti oleh admin kami. ` +
    "Mohon tunggu sebentar ya."
  );
}

export function createResponder(options: AgentOptions): Responder {
  return async (context: ReplyContext): Promise<ReplyPlan> => {
    // Logged as a warning on every message on purpose: while phase 3 is
    // unfinished this is the signal that a number is answering with the generic
    // fallback instead of the model.
    options.log.warn("ai_unavailable", {
      slug: options.slug,
      chatJid: context.chatJid,
      reason: "responder_is_fallback",
      maxTurns: options.maxTurns,
    });
    return {
      messages: [{ kind: "text", body: fallbackReply(context.message) }],
      reason: "fallback_reply",
    };
  };
}
