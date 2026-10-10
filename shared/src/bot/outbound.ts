/**
 * The only place the bot talks to WhatsApp.
 *
 * Three guarantees live here, and every one of them is a bug that is expensive
 * in production:
 *
 *  1. Nothing leaves the worker unless `deliver` is true, which is what
 *     `BOT_MODE=shadow` means: the pipeline runs in full — filter, policy, AI,
 *     history — but the customer receives nothing.
 *  2. Every send passes the number-wide token bucket first (work plan R7).
 *     WhatsApp rate-limits numbers that burst; the bucket is a Durable Object so
 *     it survives concurrency and isolates rather than living in a variable.
 *  3. A failure is reported per message, not thrown, so the caller can decide
 *     between a queue retry and the outbox instead of losing the whole batch.
 */
import type { InstanceConfig } from "../config";
import type { Env } from "../config";
import type { Logger } from "../lib/logger";
import { rateLimiterFor } from "./coordinator/chat-lock";
import type { OutboundMessage } from "./types";
import type { WuzapiClient, WuzapiSendResult } from "./wuzapi/client";

/** Burst size; also the bucket capacity. */
export const RATE_CAPACITY = 30;
/** 0.5 tokens/second ≈ 30 messages/minute sustained. */
export const RATE_REFILL_PER_SECOND = 0.5;
/** How long a single send waits for a token before giving up to the caller. */
const RATE_WAIT_ATTEMPTS = 3;
const RATE_WAIT_MAX_MS = 5_000;
/**
 * Gap between two messages of the same reply. A customer who receives four
 * bubbles in 40 ms is talking to a machine; 1–3 s is what a human assistant
 * looks like, and it also keeps the number away from WhatsApp's burst heuristics.
 */
export const HUMAN_DELAY_MIN_MS = 1_000;
export const HUMAN_DELAY_MAX_MS = 3_000;

export interface SendFailure {
  message: OutboundMessage;
  error: string;
  attempts: number;
  /** 4xx from wuzapi: retrying the identical call cannot succeed. */
  permanent: boolean;
}

export interface OutboundOutcome {
  sent: number;
  /** True when shadow mode swallowed the messages. */
  suppressed: boolean;
  failures: SendFailure[];
}

export interface OutboundContext {
  env: Pick<Env, "CHAT_COORDINATOR">;
  config: InstanceConfig;
  client: WuzapiClient;
  log: Logger;
  /** False in shadow mode and in tests that assert no traffic. */
  deliver: boolean;
  sleep?: (ms: number) => Promise<void>;
  /** Test seam for the human-like gap between messages. */
  random?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits for a token. Returns false when the bucket stays empty, which the caller
 * turns into a retry rather than an unbounded wait inside the queue consumer.
 */
async function takeRateToken(context: OutboundContext, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  const limiter = rateLimiterFor(context.env, context.config.slug);
  if (!limiter) return true;

  for (let attempt = 0; attempt < RATE_WAIT_ATTEMPTS; attempt++) {
    let payload: { allowed?: boolean; retryAfterMs?: number };
    try {
      const response = await limiter.fetch("https://coordinator/rate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          capacity: RATE_CAPACITY,
          refillPerSecond: RATE_REFILL_PER_SECOND,
          cost: 1,
        }),
      });
      payload = (await response.json()) as { allowed?: boolean; retryAfterMs?: number };
    } catch (error) {
      // A failing rate limiter must not stop the bot from answering; the token
      // bucket protects WhatsApp, it is not a correctness boundary.
      context.log.warn("rate_limit_unavailable", { error: String(error) });
      return true;
    }

    if (payload.allowed === true) return true;
    const waitMs = Math.min(Math.max(0, payload.retryAfterMs ?? 1_000), RATE_WAIT_MAX_MS);
    if (waitMs <= 0) continue;
    await sleep(waitMs);
  }

  context.log.warn("rate_limited", { capacity: RATE_CAPACITY, refillPerSecond: RATE_REFILL_PER_SECOND });
  return false;
}

async function sendOne(
  context: OutboundContext,
  chatJid: string,
  message: OutboundMessage,
): Promise<WuzapiSendResult> {
  switch (message.kind) {
    case "text":
      return await context.client.sendText(chatJid, message.body);
    case "image":
      return await context.client.sendImage(chatJid, message.image, message.caption, {
        ...(message.mimeType ? { mimeType: message.mimeType } : {}),
      });
    case "document":
      return await context.client.sendDocument(chatJid, message.document, message.fileName, {
        ...(message.caption ? { caption: message.caption } : {}),
        ...(message.mimeType ? { mimeType: message.mimeType } : {}),
      });
  }
}

/** Short, log-safe description of an outbound message. */
export function describeOutbound(message: OutboundMessage): string {
  if (message.kind === "text") return message.body.slice(0, 120);
  if (message.kind === "image") return message.caption.slice(0, 120);
  return message.fileName;
}

export async function deliverOutbound(
  context: OutboundContext,
  chatJid: string,
  messages: readonly OutboundMessage[],
): Promise<OutboundOutcome> {
  const sleep = context.sleep ?? defaultSleep;

  if (messages.length === 0) return { sent: 0, suppressed: false, failures: [] };

  if (!context.deliver) {
    for (const message of messages) {
      context.log.info("outbound_suppressed_shadow", {
        chatJid,
        kind: message.kind,
        preview: describeOutbound(message),
      });
    }
    return { sent: 0, suppressed: true, failures: [] };
  }

  const failures: SendFailure[] = [];
  const random = context.random ?? Math.random;
  let sent = 0;
  let handled = 0;

  for (const message of messages) {
    // Human-like gap between the parts of one reply (never before the first).
    if (handled > 0) {
      const gap = HUMAN_DELAY_MIN_MS + Math.trunc(random() * (HUMAN_DELAY_MAX_MS - HUMAN_DELAY_MIN_MS));
      await sleep(gap);
    }
    handled += 1;

    if (!(await takeRateToken(context, sleep))) {
      failures.push({ message, error: "rate limited", attempts: 0, permanent: false });
      continue;
    }

    const result = await sendOne(context, chatJid, message);
    if (result.ok) {
      sent += 1;
      context.log.info("outbound_sent", {
        chatJid,
        kind: message.kind,
        messageId: result.messageId,
        attempts: result.attempts,
      });
      continue;
    }

    context.log.error("outbound_failed", {
      chatJid,
      kind: message.kind,
      status: result.status,
      attempts: result.attempts,
      permanent: result.permanent,
      error: result.error,
    });
    failures.push({
      message,
      error: result.error,
      attempts: result.attempts,
      permanent: result.permanent,
    });
  }

  return { sent, suppressed: false, failures };
}
