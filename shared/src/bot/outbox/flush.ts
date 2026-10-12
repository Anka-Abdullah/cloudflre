/**
 * The outbox flusher: claim → send → mark, once per row, ever.
 *
 * The three guarantees, and where each comes from:
 *
 *  1. **At most one send per row per lease.** `claimOutboxRows` hands the pass a
 *     random `leaseId`; every send is guarded by `WHERE lease_id = ? AND status =
 *     'claimed'`. A pass that lost the race never sees the row.
 *  2. **At most one message per business event.** The row's `dedupe_key` is
 *     unique, so re-running the code that enqueues (a redelivered payment event,
 *     a cron racing an `outbox.tick`) cannot create a second message.
 *  3. **A crash mid-send does not duplicate.** The WhatsApp message id is derived
 *     from the row id (`ob-<id>`), so a retry after the lease expired re-sends the
 *     *same* msgid — wuzapi passes `Id` straight to WhatsApp, which drops the
 *     duplicate instead of showing it twice.
 *
 * Retry policy mirrors the queue consumer: a 4xx from wuzapi is permanent (the
 * row is marked failed and stays visible for the operator), anything else backs
 * off exponentially and gives up after `OUTBOX_MAX_ATTEMPTS`.
 */
import type { Env, InstanceConfig } from "../../config";
import type { Logger } from "../../lib/logger";
import { retryDelaySeconds } from "../../lib/backoff";
import { takeRateToken } from "../send-throttle";
import type { WuzapiClient } from "../wuzapi/client";
import {
  claimOutboxRows,
  markOutboxFailed,
  markOutboxRetry,
  markOutboxSent,
  parseOutboxMessage,
  type OutboxRow,
} from "./store";

export interface FlushOptions {
  env: Pick<Env, "BOT_DB" | "CHAT_COORDINATOR">;
  config: InstanceConfig;
  client: WuzapiClient;
  log: Logger;
  /**
   * Whether this pass may actually put a message in front of a customer.
   *
   * The caller must compute it as
   * `config.bot.mode === "on" && botReadiness(config, env).ready`.
   *
   * It is required, and deliberately not derived here, because the two ways of
   * being unready are different faults — the mode is an operator switch, the
   * readiness is a missing secret or binding — and the caller already knows
   * which one applies. A required flag also means a new caller cannot forget it
   * and quietly blast a backlog the moment the number is switched to `on`.
   */
  deliver: boolean;
  now?: () => Date;
  /** Overrides OUTBOX_BATCH for one pass (the admin flush uses it). */
  limit?: number;
  /** Test seam: deterministic random for backoff jitter and lease ids. */
  random?: () => number;
  randomId?: () => string;
  /** Test seam: forces a fresh lease id, so a test can simulate a dead flusher. */
  leaseId?: string;
  /** Test seam: replaces the wait for a rate-limit token. */
  sleep?: (ms: number) => Promise<void>;
}

export interface FlushResult {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  /** Rows whose payload could not be parsed (poison rows). */
  dropped: number;
  /** Rows parked because BOT_MODE is not `on` (shadow/off: nothing is sent). */
  suppressed: number;
  /** Order refs that had at least one message sent, for logging/reconcile. */
  orderRefs: string[];
  /** Outbox row ids this pass claimed, in order. */
  rowIds: number[];
}

function newLeaseId(): string {
  return crypto.randomUUID();
}

/** The WhatsApp message id for one outbox row; deterministic so a retry dedupes. */
export function outboxMessageId(rowId: number): string {
  return `ob-${rowId}`;
}

export async function flushOutbox(options: FlushOptions): Promise<FlushResult> {
  const { env, config, client, log } = options;
  const db = env.BOT_DB;
  const result: FlushResult = {
    claimed: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    dropped: 0,
    suppressed: 0,
    orderRefs: [],
    rowIds: [],
  };
  if (!db) {
    log.error("outbox_misconfigured", { reason: "BOT_DB binding is missing" });
    return result;
  }

  const now = (options.now ?? (() => new Date()))().getTime();
  const leaseId = options.leaseId ?? (options.randomId ?? newLeaseId)();
  const rows = await claimOutboxRows(db, {
    now,
    limit: options.limit ?? config.bot.outboxBatch,
    leaseMs: config.bot.outboxLeaseSeconds * 1_000,
    leaseId,
  });

  result.claimed = rows.length;
  result.rowIds = rows.map((row) => row.id);
  if (rows.length === 0) return result;

  // Nothing leaves the worker unless the whole number is actually ready — mode
  // `on` *and* every prerequisite present. The direct path already stops at
  // `deliverOutbound`, but the flusher is reached by the cron too, so without
  // this check a half-provisioned number (`BOT_MODE=on`, missing AI_API_KEY)
  // stayed silent for replies while still blasting receipts out of the outbox.
  // Rows are claimed and parked as `failed` with an explicit reason, so nothing
  // is sent *and* nothing silently piles up to be delivered the moment the
  // operator fixes the configuration.
  if (!options.deliver) {
    const reason =
      config.bot.mode !== "on"
        ? `BOT_MODE=${config.bot.mode}: tidak dikirim`
        : "BOT_MODE=on but the bot is not ready (degraded): tidak dikirim";
    for (const row of rows) {
      await markOutboxFailed(db, { id: row.id, leaseId, error: reason });
      result.suppressed += 1;
      log.info("outbound_suppressed_shadow", {
        chatJid: row.chatJid,
        kind: row.kind,
        orderRef: row.orderRef,
        via: "outbox",
        mode: config.bot.mode,
        degraded: config.bot.mode === "on",
      });
    }
    return result;
  }

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index] as OutboxRow;
    const message = parseOutboxMessage(row);
    if (!message) {
      // Poison row: sending it is impossible, retrying it is pointless. Mark it
      // failed so it stops consuming the batch, and say so in the log.
      await markOutboxFailed(db, { id: row.id, leaseId, error: "payload tidak bisa dibaca" });
      result.dropped += 1;
      log.error("outbox_poison_payload", { id: row.id, chatJid: row.chatJid, orderRef: row.orderRef });
      continue;
    }

    // Every send draws from the same number-wide bucket as the direct reply
    // path, so a busy number cannot be drained through the outbox instead.
    if (!(await takeRateToken({ env, config, log, ...(options.sleep ? { sleep: options.sleep } : {}) }))) {
      const delaySeconds = retryDelaySeconds(row.attempts, {
        baseSeconds: config.retryBaseSeconds,
        maxSeconds: config.retryMaxSeconds,
        ...(options.random ? { random: options.random } : {}),
      });
      // The bucket is per number, so if it is empty for this row it is empty for
      // the rest of the batch. Park this row and every row after it and stop,
      // rather than sleeping through the whole batch: at ~2 s per refusal a
      // 20-row pass would otherwise spend a minute asleep inside one invocation.
      for (const pending of rows.slice(index)) {
        await markOutboxRetry(db, {
          id: pending.id,
          leaseId,
          nextAttemptAt: now + delaySeconds * 1_000,
          error: "rate limited",
        });
        result.retried += 1;
        log.warn("outbox_retry", {
          id: pending.id,
          chatJid: pending.chatJid,
          attempts: pending.attempts,
          delaySeconds,
          error: "rate limited",
        });
      }
      break;
    }

    const sendResult = await sendOutboxMessage(client, row, message, log);

    if (sendResult.ok) {
      // The pass's own clock, not `Date.now()`: the claim, the marks and the
      // backoff schedule all have to agree, or a test clock (and a clock skew in
      // production) would schedule a retry in the wrong era.
      const marked = await markOutboxSent(db, { id: row.id, leaseId, at: now });
      if (marked) {
        result.sent += 1;
        if (row.orderRef && !result.orderRefs.includes(row.orderRef)) result.orderRefs.push(row.orderRef);
        log.info("outbound_sent", {
          chatJid: row.chatJid,
          kind: row.kind,
          messageId: sendResult.messageId,
          attempts: row.attempts,
          orderRef: row.orderRef,
          via: "outbox",
        });
      }
      continue;
    }

    const attempts = row.attempts;
    const exhausted = attempts >= config.bot.outboxMaxAttempts;
    if (sendResult.permanent || exhausted) {
      await markOutboxFailed(db, { id: row.id, leaseId, error: sendResult.error });
      result.failed += 1;
      log.error("outbox_failed", {
        id: row.id,
        chatJid: row.chatJid,
        attempts,
        permanent: sendResult.permanent,
        error: sendResult.error,
      });
      continue;
    }

    const delaySeconds = retryDelaySeconds(attempts, {
      baseSeconds: config.retryBaseSeconds,
      maxSeconds: config.retryMaxSeconds,
      ...(options.random ? { random: options.random } : {}),
    });
    await markOutboxRetry(db, {
      id: row.id,
      leaseId,
      nextAttemptAt: now + delaySeconds * 1_000,
      error: sendResult.error,
    });
    result.retried += 1;
    log.warn("outbox_retry", {
      id: row.id,
      chatJid: row.chatJid,
      attempts,
      delaySeconds,
      error: sendResult.error,
    });
  }

  return result;
}

interface SendOutcome {
  ok: boolean;
  messageId: string | null;
  error: string;
  permanent: boolean;
}

async function sendOutboxMessage(
  client: WuzapiClient,
  row: OutboxRow,
  message: NonNullable<ReturnType<typeof parseOutboxMessage>>,
  log: Logger,
): Promise<SendOutcome> {
  const id = outboxMessageId(row.id);
  try {
    const result =
      message.kind === "text"
        ? await client.sendText(row.chatJid, message.body, { id })
        : message.kind === "image"
          ? await client.sendImage(row.chatJid, message.image, message.caption, {
              ...(message.mimeType ? { mimeType: message.mimeType } : {}),
              id,
            })
          : await client.sendDocument(row.chatJid, message.document, message.fileName, {
              ...(message.caption ? { caption: message.caption } : {}),
              ...(message.mimeType ? { mimeType: message.mimeType } : {}),
              id,
            });
    return { ok: result.ok, messageId: result.messageId, error: result.error, permanent: result.permanent };
  } catch (error) {
    // `WuzapiClient` returns results instead of throwing, but a future change
    // must not lose the row: an unexpected throw becomes a retryable failure.
    const detail = error instanceof Error ? error.message : String(error);
    log.error("outbox_send_crashed", { id: row.id, error: detail });
    return { ok: false, messageId: null, error: detail, permanent: false };
  }
}
