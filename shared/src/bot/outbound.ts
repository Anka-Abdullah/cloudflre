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
import { markReplyPartFailed, markReplyPartSent, type StoredReplyPlan } from "./reply-plan";
import { RATE_CAPACITY, RATE_REFILL_PER_SECOND, takeRateToken } from "./send-throttle";
import type { OutboundMessage } from "./types";
import type { WuzapiClient, WuzapiSendResult } from "./wuzapi/client";

// Re-exported so existing importers keep working; the bucket itself now lives in
// send-throttle.ts, which the outbox flusher shares.
export { RATE_CAPACITY, RATE_REFILL_PER_SECOND };

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
 * Waits for a token from the number-wide bucket (see `send-throttle.ts`).
 *
 * Kept as a thin wrapper so every call site in this file passes the same context
 * — and, more importantly, so the direct path and the outbox cannot drift onto
 * two different buckets.
 */
async function waitForRateToken(context: OutboundContext, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  return await takeRateToken({ env: context.env, config: context.config, log: context.log, sleep });
}

/**
 * Sends one message. `id` is the WhatsApp message id: passing the same id again
 * makes WhatsApp drop the duplicate instead of showing a second bubble, which is
 * what makes a retry after a crash safe. `deliverOutbound` omits it (its callers
 * are not keyed by a delivery), while `deliverReplyPlan` always supplies it.
 */
async function sendOne(
  context: OutboundContext,
  chatJid: string,
  message: OutboundMessage,
  id?: string,
): Promise<WuzapiSendResult> {
  const withId = id === undefined ? {} : { id };
  switch (message.kind) {
    case "text":
      return await context.client.sendText(chatJid, message.body, withId);
    case "image":
      return await context.client.sendImage(chatJid, message.image, message.caption, {
        ...(message.mimeType ? { mimeType: message.mimeType } : {}),
        ...withId,
      });
    case "document":
      return await context.client.sendDocument(chatJid, message.document, message.fileName, {
        ...(message.caption ? { caption: message.caption } : {}),
        ...(message.mimeType ? { mimeType: message.mimeType } : {}),
        ...withId,
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

    if (!(await waitForRateToken(context, sleep))) {
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

/** Context for delivering a *stored* plan: it needs the ledger to record progress. */
export interface ReplyPlanOutboundContext extends OutboundContext {
  db: D1Database;
  deliveryId: string;
  now?: () => Date;
}

export interface ReplyPlanOutcome {
  /** Parts that reached WhatsApp during *this* pass, in order. */
  sentIndexes: number[];
  /** Parts parked permanently (4xx); a retry cannot help them. */
  failedIndexes: number[];
  /**
   * The first part left owed to the customer, if any. Delivery stops there so a
   * retry keeps the reply in order, which means the parts after it are still
   * `pending` in the ledger without being listed here.
   */
  pendingIndexes: number[];
  failures: SendFailure[];
  /** True when shadow mode logged the reply instead of sending it. */
  suppressed: boolean;
}

/**
 * Delivers a stored reply plan, resuming exactly where the last attempt stopped.
 *
 * The rules, and why each one matters:
 *
 *   * a part already `sent` is never sent again — this is what stops a retry
 *     from showing the customer the same bubble twice;
 *   * a part already `failed` is skipped too — it was a 4xx, so the identical
 *     call cannot succeed and retrying it would only burn the queue's attempts;
 *   * a part that fails transiently is left `pending`, so the queue retry
 *     re-sends it under its original message id;
 *   * every send passes the number-wide token bucket and the human-like gap
 *     first, exactly as the single-shot path does.
 */
export async function deliverReplyPlan(
  context: ReplyPlanOutboundContext,
  chatJid: string,
  plan: StoredReplyPlan,
): Promise<ReplyPlanOutcome> {
  const { db, deliveryId } = context;
  const sleep = context.sleep ?? defaultSleep;
  const now = context.now ?? (() => new Date());
  const outcome: ReplyPlanOutcome = {
    sentIndexes: [],
    failedIndexes: [],
    pendingIndexes: [],
    failures: [],
    suppressed: false,
  };

  if (plan.messages.length === 0) return outcome;

  if (!context.deliver) {
    for (const part of plan.parts) {
      const message = plan.messages[part.index];
      if (!message) continue;
      context.log.info("outbound_suppressed_shadow", {
        chatJid,
        kind: message.kind,
        preview: describeOutbound(message),
        part: part.index,
        messageId: part.messageId,
      });
    }
    outcome.suppressed = true;
    return outcome;
  }

  const random = context.random ?? Math.random;
  let handled = 0;

  for (const part of plan.parts) {
    // `sent` is done; `failed` is a permanent 4xx already reported. Either way
    // the customer's copy of this part is settled and must not be re-sent.
    if (part.status !== "pending") continue;
    const message = plan.messages[part.index];
    if (!message) continue;

    // Human-like gap between the parts sent in this pass (never before the
    // first), so a resumed reply is still paced rather than burst out.
    if (handled > 0) {
      const gap = HUMAN_DELAY_MIN_MS + Math.trunc(random() * (HUMAN_DELAY_MAX_MS - HUMAN_DELAY_MIN_MS));
      await sleep(gap);
    }
    handled += 1;

    if (!(await waitForRateToken(context, sleep))) {
      outcome.failures.push({ message, error: "rate limited", attempts: 0, permanent: false });
      outcome.pendingIndexes.push(part.index);
      // A dry bucket also stops this pass: the remaining parts are still pending
      // in the ledger, and sending them now would put them ahead of this one.
      break;
    }

    const result = await sendOne(context, chatJid, message, part.messageId);
    if (result.ok) {
      await markReplyPartSent(db, deliveryId, part.index, now().getTime());
      outcome.sentIndexes.push(part.index);
      context.log.info("outbound_sent", {
        chatJid,
        kind: message.kind,
        part: part.index,
        messageId: part.messageId,
        waMessageId: result.messageId,
        attempts: result.attempts,
      });
      continue;
    }

    context.log.error("outbound_failed", {
      chatJid,
      kind: message.kind,
      part: part.index,
      messageId: part.messageId,
      status: result.status,
      attempts: result.attempts,
      permanent: result.permanent,
      error: result.error,
    });
    outcome.failures.push({
      message,
      error: result.error,
      attempts: result.attempts,
      permanent: result.permanent,
    });

    if (result.permanent) {
      // Parked forever, so it can never arrive late: the rest of the reply may
      // still go out in order.
      await markReplyPartFailed(db, deliveryId, part.index, result.error);
      outcome.failedIndexes.push(part.index);
      continue;
    }

    // Transient. Stop here instead of sending part N+1 ahead of part N — a
    // multi-bubble reply is a sequence, and the customer reading it out of order
    // is worse than reading it a minute later. The queue retry resumes from this
    // index, so the order they were written in is the order they arrive in.
    outcome.pendingIndexes.push(part.index);
    break;
  }

  return outcome;
}
