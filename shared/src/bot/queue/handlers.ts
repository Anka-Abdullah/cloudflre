/**
 * The bot pipeline: one queue message in, one answered customer (or one clear
 * reason why not) out.
 *
 * The order of the steps is the design:
 *
 *   filter → policy → lock → idempotency → history → answer → deliver → settle
 *
 *   * filter and policy are free and reject most traffic (groups, the bot's own
 *     echoes, `no_ai` chats) before anything costs money.
 *   * the lock is taken before the AI call so two redeliveries cannot both start
 *     a turn for the same chat.
 *   * the D1 claim is what makes a *failure* retryable and a *success*
 *     permanent, which is the only way at-least-once delivery stays correct.
 *   * a failure anywhere releases the lock without remembering the delivery, so
 *     the queue retry can re-claim it.
 */
import { type Env, type InstanceConfig, botReadiness } from "../../config";
import { type EnvelopeV1, type DlqRecord } from "../../envelope";
import { createLogger, type Logger } from "../../lib/logger";
import { flushOutbox } from "../outbox/flush";
import { paymentPayloadOf } from "../payment/events";
import { createTursoSqlClient, tursoConfigured } from "../payment/libsql-client";
import { settlePayment } from "../payment/settle";
import type { SqlClient } from "../payment/sql";
import { claimChat, releaseChat, DEFAULT_LOCK_TTL_MS } from "../coordinator/chat-lock";
import { resolveChatPolicy } from "../contacts/policy";
import { filterInbound, type FilterResult } from "../filter";
import { claimDelivery, finishDelivery, isDeliveryDone } from "../idempotency";
import {
  ensureChatState,
  loadHistory,
  recordInbound,
  recordOutbound,
  touchOutbound,
} from "../history";
import { deliverOutbound } from "../outbound";
import { createResponder, type Responder } from "../agent/run";
import type { ChatMessage, InboundMessage, OutboundMessage, ReplyContext } from "../types";
import { WuzapiClient } from "../wuzapi/client";

export type Disposition = { action: "ack"; reason?: string } | { action: "retry"; delaySeconds: number };

export interface BotDeps {
  now?: () => Date;
  log?: Logger;
  client?: WuzapiClient;
  /** Test seam: replaces `fetch` inside the default WuzAPI client. */
  fetchImpl?: typeof fetch;
  responder?: Responder;
  sleep?: (ms: number) => Promise<void>;
  sendDlq?: (record: DlqRecord) => Promise<unknown>;
  /** Test seam: replaces the Turso client used by the payment handlers. */
  sqlClient?: SqlClient;
}

export interface BotRuntime {
  env: Env;
  config: InstanceConfig;
  log: Logger;
  now: () => Date;
  client: WuzapiClient;
  responder: Responder;
  sleep: (ms: number) => Promise<void>;
  sendDlq: (record: DlqRecord) => Promise<unknown>;
  /** Null when Turso is not configured; the payment handlers degrade, not throw. */
  sql: SqlClient | null;
  /** True when the bot is allowed to send to customers (mode `on` and ready). */
  deliver: boolean;
}

export interface BotRuntimeOptions {
  env: Env;
  config: InstanceConfig;
  deps?: BotDeps;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds the per-batch runtime. All external seams (clock, logger, WuzAPI client,
 * responder) are injectable so tests can drive the pipeline without network.
 */
export function createBotRuntime(options: BotRuntimeOptions): BotRuntime {
  const { env, config } = options;
  const deps = options.deps ?? {};
  const log = deps.log ?? createLogger({ slug: config.slug, handler: "bot" });
  const now = deps.now ?? (() => new Date());
  const client =
    deps.client ??
    new WuzapiClient({
      baseUrl: config.bot.wuzapiApiBase,
      token: config.bot.wuzapiToken,
      // The WuzAPI client keeps its own 20 s default on purpose: AI_TIMEOUT_MS
      // governs how long the model may think, which is a different budget from
      // how long a send may take. Sharing one var made a slow model look like a
      // slow HTTP call.
      deps: {
        log,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
      },
    });

  return {
    env,
    config,
    log,
    now,
    client,
    responder:
      deps.responder ??
      createResponder({
        env,
        config,
        log,
        ...(deps.fetchImpl ? { deps: { fetchImpl: deps.fetchImpl } } : {}),
        ...(deps.sleep ? { deps: { ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), sleep: deps.sleep } } : {}),
      }),
    sleep: deps.sleep ?? defaultSleep,
    sendDlq: deps.sendDlq ?? ((record: DlqRecord) => env.DLQ.send(record, { contentType: "json" })),
    sql: sqlClientFor(config, deps.sqlClient),
    // A number whose configuration is incomplete stays silent (`deliver` false)
    // rather than sending a generic fallback to a real customer; see
    // docs/wuzip-bot-architecture.txt section 9.6.
    deliver: config.bot.mode === "on" && botReadiness(config, env).ready,
  };
}

/** Creates the Turso client once per batch, or null when it is not configured. */
function sqlClientFor(config: InstanceConfig, injected?: SqlClient): SqlClient | null {
  if (injected) return injected;
  if (!tursoConfigured({ url: config.bot.tursoDatabaseUrl, authToken: config.bot.tursoAuthToken })) return null;
  try {
    return createTursoSqlClient({ url: config.bot.tursoDatabaseUrl, authToken: config.bot.tursoAuthToken });
  } catch (error) {
    createLogger({ slug: config.slug, handler: "bot" }).error("turso_client_failed", { error: String(error) });
    return null;
  }
}

/** The payload of a wuzapi event, recovered from the media pointer when needed. */
function payloadOf(envelope: EnvelopeV1): unknown {
  if (envelope.event.payload !== null) return envelope.event.payload;
  return envelope.media?.fields ?? null;
}

/**
 * Handles one `wuzapi.event` envelope.
 *
 * Never throws: every failure becomes a retry or an ack plus a log line, because
 * an exception here would abort the whole queue batch.
 */
export async function handleWuzapiEvent(envelope: EnvelopeV1, runtime: BotRuntime): Promise<Disposition> {
  const { config, log } = runtime;
  const db = runtime.env.BOT_DB;
  const at = runtime.now();
  const mode = config.bot.mode;

  log.info("event_received", {
    deliveryId: envelope.deliveryId,
    kind: envelope.kind,
    eventType: envelope.event.type,
    mode,
  });

  const filtered: FilterResult = filterInbound(
    { type: envelope.event.type, payload: payloadOf(envelope) },
    { voiceEnabled: config.bot.voiceEnabled, now: runtime.now },
  );

  if (!filtered.ok) {
    log.info("event_filtered", { deliveryId: envelope.deliveryId, reason: filtered.reason, chatJid: filtered.chatJid });
    return { action: "ack", reason: filtered.reason };
  }

  const message = filtered.message;

  if (!db) {
    log.error("bot_misconfigured", { reason: "BOT_DB binding is missing", chatJid: message.chatJid });
    // Nothing can be recorded, so answering would risk a duplicate on the next
    // delivery. Acknowledge and let the DLQ/alert path surface the problem.
    return { action: "ack", reason: "missing_bot_db" };
  }

  const readiness = botReadiness(config, runtime.env);
  if (!readiness.ready) {
    log.error("bot_misconfigured", {
      chatJid: message.chatJid,
      missing: readiness.missing,
      missingBindings: readiness.missingBindings,
    });
  }

  // A half-configured number must not talk to customers: with `BOT_MODE=on` and a
  // missing secret the responder falls back to a generic reply, and sending that
  // to a real customer is worse than staying quiet. Degrading to shadow keeps the
  // pipeline observable — the reply is still logged, history is still written —
  // while an operator fixes the configuration.
  const degraded = mode === "on" && !readiness.ready;
  if (degraded) {
    log.error("bot_degraded_shadow", {
      chatJid: message.chatJid,
      reason: "configuration incomplete while BOT_MODE=on",
      missing: readiness.missing,
      missingBindings: readiness.missingBindings,
    });
  }
  const deliver = mode === "on" && !degraded;

  const policy = await resolveChatPolicy(db, { chatJid: message.chatJid, pushName: message.pushName });
  if (!policy.allowed) {
    log.info("event_suppressed", { deliveryId: envelope.deliveryId, chatJid: message.chatJid, reason: policy.reason });
    return { action: "ack", reason: policy.reason ?? "suppressed" };
  }

  // Fast path: a delivery already marked done never reaches the AI again.
  if (await isDeliveryDone(db, envelope.deliveryId)) {
    log.info("event_duplicate", { deliveryId: envelope.deliveryId, chatJid: message.chatJid });
    return { action: "ack", reason: "duplicate" };
  }

  const claim = await claimChat(runtime.env, message.chatJid, {
    deliveryId: envelope.deliveryId,
    lockTtlMs: DEFAULT_LOCK_TTL_MS,
  });
  if (claim && !claim.locked) {
    log.info("event_locked", {
      deliveryId: envelope.deliveryId,
      chatJid: message.chatJid,
      retryAfterMs: claim.retryAfterMs,
    });
    return { action: "retry", delaySeconds: Math.max(1, Math.ceil(claim.retryAfterMs / 1000)) };
  }
  if (claim?.duplicate === true) {
    log.info("event_duplicate", { deliveryId: envelope.deliveryId, chatJid: message.chatJid, source: "coordinator" });
    await releaseChat(runtime.env, message.chatJid, { deliveryId: envelope.deliveryId });
    return { action: "ack", reason: "duplicate" };
  }

  try {
    const claimed = await claimDelivery(db, {
      deliveryId: envelope.deliveryId,
      chatJid: message.chatJid,
      waMessageId: message.waMessageId === "" ? null : message.waMessageId,
      at: at.getTime(),
    });
    if (!claimed) {
      log.info("event_duplicate", { deliveryId: envelope.deliveryId, chatJid: message.chatJid, source: "d1" });
      await releaseChat(runtime.env, message.chatJid, { deliveryId: envelope.deliveryId, rememberDelivery: true });
      return { action: "ack", reason: "duplicate" };
    }

    log.info("event_processing", {
      deliveryId: envelope.deliveryId,
      chatJid: message.chatJid,
      kind: message.kind,
      mode,
    });

    await ensureChatState(db, message.chatJid, at.getTime());

    // History is read before the current message is stored, so the AI never sees
    // the question twice.
    const history = await loadHistory(db, message.chatJid, config.bot.knowledgeHistoryLimit);
    await recordInbound(db, message, envelope.deliveryId, safeJson(envelope.event.payload));

    const context: ReplyContext = {
      slug: config.slug,
      chatJid: message.chatJid,
      pushName: message.pushName,
      message,
      history: withoutCurrent(history, message),
      now: at,
    };

    const plan = await runtime.responder(context);

    // The typing bubble covers the model's thinking time. It is best-effort: a
    // wuzapi that refuses presence must not stop the answer itself.
    await setTyping(runtime, message.chatJid, "composing");

    const outbound = await deliverOutbound(
      {
        env: runtime.env,
        config,
        client: runtime.client,
        log,
        deliver,
        sleep: runtime.sleep,
      },
      message.chatJid,
      plan.messages,
    );
    await setTyping(runtime, message.chatJid, "paused");

    if (outbound.failures.length > 0) {
      const permanent = outbound.failures.every((failure) => failure.permanent);
      log.error("outbound_incomplete", {
        deliveryId: envelope.deliveryId,
        chatJid: message.chatJid,
        sent: outbound.sent,
        failed: outbound.failures.length,
        permanent,
      });
      if (permanent) {
        // wuzapi answered 4xx: the same call cannot succeed, so retrying the
        // queue message would only burn attempts. Ack it, but release the chat
        // lock — holding it would block the customer's next real message for the
        // whole lock TTL.
        log.error("outbound_permanent", {
          deliveryId: envelope.deliveryId,
          chatJid: message.chatJid,
          error: outbound.failures[0]?.error ?? "unknown",
        });
        await settle(runtime, envelope.deliveryId, "failed", "outbound permanently rejected", message.chatJid);
        return { action: "ack", reason: "outbound_permanent" };
      }
      await finishDelivery(db, envelope.deliveryId, "failed", at.getTime(), "outbound failed");
      await releaseChat(runtime.env, message.chatJid, {});
      return { action: "retry", delaySeconds: 15 };
    }

    if (!outbound.suppressed) {
      for (const sentMessage of plan.messages) await recordSent(db, message.chatJid, sentMessage, at.getTime());
      await touchOutbound(db, message.chatJid, at.getTime());
    }

    await settle(runtime, envelope.deliveryId, "done", undefined, message.chatJid);
    log.info("event_done", {
      deliveryId: envelope.deliveryId,
      chatJid: message.chatJid,
      replies: plan.messages.length,
      reason: plan.reason,
      shadow: outbound.suppressed,
    });
    return { action: "ack" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.error("event_failed", { deliveryId: envelope.deliveryId, chatJid: message.chatJid, error: detail });
    await finishDelivery(db, envelope.deliveryId, "failed", runtime.now().getTime(), detail);
    await releaseChat(runtime.env, message.chatJid, {});
    return { action: "retry", delaySeconds: 30 };
  }
}

/**
 * Shows or clears the "typing…" bubble. Only ever called when the bot is allowed
 * to deliver, and never fatal: presence is a courtesy, not a delivery.
 */
async function setTyping(runtime: BotRuntime, chatJid: string, state: "composing" | "paused"): Promise<void> {
  if (!runtime.deliver || chatJid === "") return;
  try {
    const result = await runtime.client.sendPresence(chatJid, state);
    if (!result.ok) runtime.log.debug("typing_unavailable", { chatJid, state, error: result.error });
  } catch (error) {
    runtime.log.debug("typing_failed", { chatJid, state, error: String(error) });
  }
}

async function settle(  runtime: BotRuntime,
  deliveryId: string,
  status: "done" | "failed",
  error?: string,
  chatJid?: string,
): Promise<void> {
  const db = runtime.env.BOT_DB;
  if (db) await finishDelivery(db, deliveryId, status, runtime.now().getTime(), error);
  if (chatJid) {
    await releaseChat(runtime.env, chatJid, {
      deliveryId,
      rememberDelivery: status === "done",
    });
  }
}

async function recordSent(
  db: D1Database,
  chatJid: string,
  message: OutboundMessage,
  at: number,
): Promise<void> {
  const body =
    message.kind === "text" ? message.body : message.kind === "image" ? message.caption : (message.caption ?? message.fileName);
  const kind = message.kind === "text" ? "text" : "caption";
  await recordOutbound(db, { chatJid, body, kind, at });
}

function safeJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    const serialised = JSON.stringify(value);
    return serialised.length > 200_000 ? null : serialised;
  } catch {
    return null;
  }
}

/**
 * Drops the message being answered from its own history.
 *
 * Needed on a queue retry: the previous attempt already wrote the inbound row, so
 * without this the second attempt would show the AI its own question twice.
 */
function withoutCurrent(history: ChatMessage[], message: InboundMessage): ChatMessage[] {
  return history.filter(
    (entry) =>
      !(entry.direction === "in" && entry.createdAt === message.timestamp && entry.body === message.body),
  );
}

/**
 * Handles one `payment.event` envelope: the only place an order can become
 * `paid`, `expired` or `failed`.
 *
 * The HTTP routes never touch the order tables; they enqueue this envelope
 * instead, so the queue is the single writer and a webhook retry is harmless.
 * Idempotency comes in two layers: `processed_events` (the frozen
 * `<order_ref>:<status>:<provider_ref|paid_at>` delivery id) and the outbox
 * `dedupe_key` on the receipt.
 *
 * Dispositions:
 *   applied / duplicate / final state → ack
 *   database or delivery failure       → retry, so the callback is not lost
 */
export async function handlePaymentEvent(envelope: EnvelopeV1, runtime: BotRuntime): Promise<Disposition> {
  const { log, config } = runtime;
  const db = runtime.env.BOT_DB;
  const at = runtime.now();

  const payload = paymentPayloadOf(envelope);
  if (!payload) {
    log.warn("payment_event_unreadable", { deliveryId: envelope.deliveryId });
    return { action: "ack", reason: "payment_event_unreadable" };
  }

  if (!runtime.sql) {
    // Turso is required to settle anything. Acknowledging would lose the event,
    // so it is retried; the cron/alert path surfaces the misconfiguration.
    log.error("payment_event_no_database", { orderRef: payload.orderRef, hint: "TURSO_DATABASE_URL / TURSO_AUTH_TOKEN" });
    return { action: "retry", delaySeconds: 60 };
  }

  if (db && !(await claimDelivery(db, { deliveryId: envelope.deliveryId, chatJid: null, waMessageId: null, at: at.getTime() }))) {
    log.info("payment_event_duplicate", { deliveryId: envelope.deliveryId, orderRef: payload.orderRef });
    return { action: "ack", reason: "duplicate" };
  }

  const result = await settlePayment(
    { env: runtime.env, sql: runtime.sql, log },
    {
      kodeBayar: payload.kodeBayar,
      orderRef: payload.orderRef,
      status: payload.status,
      amount: payload.amount,
      providerRef: payload.providerRef,
      metode: payload.metode,
      paidAt: payload.paidAt,
      raw: payload.raw,
      at: at.getTime(),
    },
  );

  log.info("payment_event", {
    deliveryId: envelope.deliveryId,
    orderRef: payload.orderRef,
    status: payload.status,
    applied: result.applied,
    reason: result.reason,
    source: payload.source,
  });

  if (result.error !== "" && result.reason === "settle_failed") {
    if (db) await finishDelivery(db, envelope.deliveryId, "failed", at.getTime(), result.error);
    return { action: "retry", delaySeconds: 30 };
  }

  // The confirmation text is delivered directly when the bot may talk (the
  // queue message is the only chance to answer quickly); the receipt always
  // travels through the outbox, already queued by `settlePayment`.
  if (result.applied && result.messages.length > 0) {
    const outcome = await deliverOutbound(
      { env: runtime.env, config, client: runtime.client, log, deliver: runtime.deliver, sleep: runtime.sleep },
      result.order?.waChatJid ?? "",
      result.messages,
    );
    if (result.order && !outcome.suppressed) {
      for (const message of result.messages) {
        if (message.kind === "text") {
          await recordOutbound(db as D1Database, {
            chatJid: result.order.waChatJid,
            body: message.body,
            kind: "text",
            at: at.getTime(),
          });
        }
      }
    }
    if (outcome.failures.length > 0 && !outcome.failures.every((failure) => failure.permanent)) {
      if (db) await finishDelivery(db, envelope.deliveryId, "failed", at.getTime(), "confirmation send failed");
      return { action: "retry", delaySeconds: 15 };
    }
  }

  if (result.applied) {
    // The receipt is queued (never sent inline), so it survives a wuzapi outage.
    // Flushing right away is what keeps "paid" and "nota" a second apart instead
    // of a cron tick apart; the cron remains the safety net for a failed flush.
    const flushed = await flushOutbox({
      env: runtime.env,
      config,
      client: runtime.client,
      log,
      now: runtime.now,
      limit: 5,
    });
    log.info("payment_nota_flush", { sent: flushed.sent, retried: flushed.retried, claimed: flushed.claimed });
  }

  if (db) await finishDelivery(db, envelope.deliveryId, "done", at.getTime());
  return { action: "ack", reason: result.reason };
}

/**
 * Handles one `outbox.tick` envelope: flush the outbox now.
 *
 * The cron does the same thing every minute; this exists so a test (or an
 * operator) does not have to wait, and so the flush has a path that does not
 * depend on the schedule being enabled.
 */
export async function handleOutboxTick(envelope: EnvelopeV1, runtime: BotRuntime): Promise<Disposition> {
  const result = await flushOutbox({
    env: runtime.env,
    config: runtime.config,
    client: runtime.client,
    log: runtime.log,
    now: runtime.now,
  });
  runtime.log.info("outbox_tick", { deliveryId: envelope.deliveryId, ...result });
  return { action: "ack", reason: `flushed:${result.sent}` };
}
