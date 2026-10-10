/**
 * Cron jobs (`scheduled()`), i.e. everything that must happen even when no
 * customer writes in: flush the outbox, expire stale orders, reconcile payments,
 * refresh contacts, prune history, nudge chats that were never answered.
 *
 * Three rules shape the design:
 *
 *  1. **One failing job never cancels the others.** A wuzapi outage must not stop
 *     the outbox retry, and a Turso outage must not stop the contact sync. Each
 *     job returns its own result and the cron logs one line per job.
 *  2. **Interval jobs are claimed, not timed.** The trigger fires every minute,
 *     while a contact sync may be wanted every 10. The claim is a conditional
 *     UPDATE on `cron_state`, so two overlapping cron invocations cannot both run
 *     the same job — the same "decide in the database" rule the rest of the
 *     pipeline follows.
 *  3. **Reconciliation enqueues, it does not mutate.** When a payment looks stale
 *     or the gateway reports a status the worker never heard, the cron sends the
 *     same `payment.event` envelope a callback would, so the queue stays the only
 *     writer of order state and the accounting stays in one place.
 */
import type { Env, InstanceConfig } from "./config";
import { createLogger, type Logger } from "./lib/logger";
import type { EnvelopeV1 } from "./envelope";
import { pruneHistory } from "./bot/history";
import { enqueueOutbox } from "./bot/outbox/store";
import { flushOutbox } from "./bot/outbox/flush";
import { syncContacts, type ContactSyncResult } from "./bot/contacts/sync";
import { expiredMessage } from "./bot/payment/messages";
import { paymentEnvelope } from "./bot/payment/events";
import { createTursoSqlClient, tursoConfigured } from "./bot/payment/libsql-client";
import { createPaymentProvider, type PaymentProvider } from "./bot/payment/provider";
import { findPaymentForOrder, listOrdersDueForExpiry, listOrdersInStatus, transitionOrder, updatePayment } from "./bot/payment/turso";
import type { SqlClient } from "./bot/payment/sql";
import { prunePending } from "./bot/telegram/pending";
import { WuzapiClient } from "./bot/wuzapi/client";

export interface CronDeps {
  now?: () => Date;
  log?: Logger;
  client?: WuzapiClient;
  fetchImpl?: typeof fetch;
  /** Test seam: replaces the Turso client. */
  sqlClient?: SqlClient;
  /** Test seam: replaces the payment provider used by reconciliation. */
  provider?: PaymentProvider;
  /** Test seam: replaces `env.EVENTS.send`. */
  sendEnvelope?: (envelope: EnvelopeV1) => Promise<unknown>;
}

export interface CronOptions {
  env: Env;
  config: InstanceConfig;
  deps?: CronDeps;
  /** True when triggered by `outbox.tick` rather than the schedule. */
  forced?: boolean;
}

export interface CronResult {
  jobs: Record<string, unknown>;
}

/** How long history is kept (work plan Q24: 90 days). */
export const HISTORY_RETENTION_DAYS = 90;
/** Telegram cards are forgotten after this long if nobody answers them. */
export const PENDING_CARD_TTL_HOURS = 72;

/**
 * Atomically claims an interval job. Returns true when this invocation should
 * run it.
 *
 * `last_run_at <= before` is the whole mechanism: the UPDATE only touches the
 * row when the previous run is old enough, so the first caller wins and the
 * second sees `changes = 0`.
 */
export async function claimIntervalJob(
  db: D1Database,
  job: string,
  intervalMinutes: number,
  at: number,
  force = false,
): Promise<boolean> {
  if (force || intervalMinutes <= 0) return true;

  await db
    .prepare("INSERT OR IGNORE INTO cron_state (job, last_run_at, note) VALUES (?, 0, NULL)")
    .bind(job)
    .run();

  const before = at - intervalMinutes * 60_000;
  // `last_run_at = 0` is "never ran", which is always due — without this arm a
  // clock that is younger than one interval (tests, or a fresh deployment with a
  // mocked clock) would never claim the job.
  const claimed = await db
    .prepare("UPDATE cron_state SET last_run_at = ? WHERE job = ? AND (last_run_at = 0 OR last_run_at <= ?)")
    .bind(at, job, before)
    .run();
  return (claimed.meta.changes ?? 0) > 0;
}

async function runJob<T>(
  log: Logger,
  name: string,
  job: () => Promise<T>,
): Promise<T | { skipped: string }> {
  const started = Date.now();
  try {
    const result = await job();
    log.info("cron_job", { job: name, ms: Date.now() - started, result: summarise(result) });
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // A thrown job is reported, never rethrown: the remaining jobs still run and
    // the cron invocation still succeeds (Cloudflare would otherwise retry the
    // whole schedule, duplicating the jobs that did work).
    log.error("cron_job_failed", { job: name, ms: Date.now() - started, error: detail });
    return { skipped: detail };
  }
}

/** Keeps cron log lines small: counts, never payloads. */
function summarise(result: unknown): unknown {
  if (result === null || typeof result !== "object") return result;
  const entries = Object.entries(result as Record<string, unknown>).slice(0, 8);
  return Object.fromEntries(entries);
}

export async function runCronJobs(options: CronOptions): Promise<CronResult> {
  const { env, config } = options;
  const log = options.deps?.log ?? createLogger({ slug: config.slug, handler: "cron" });
  const at = (options.deps?.now?.() ?? new Date()).getTime();
  const db = env.BOT_DB;
  const jobs: Record<string, unknown> = {};

  if (!db) {
    log.error("cron_misconfigured", { reason: "BOT_DB binding is missing" });
    return { jobs: { skipped: "missing_bot_db" } };
  }

  const client =
    options.deps?.client ??
    new WuzapiClient({
      baseUrl: config.bot.wuzapiApiBase,
      token: config.bot.wuzapiToken,
      deps: { log, ...(options.deps?.fetchImpl ? { fetchImpl: options.deps.fetchImpl } : {}) },
    });

  const sql = resolveSql(options);
  const provider =
    options.deps?.provider ??
    createPaymentProvider({
      dryRun: config.bot.paymentDryRun,
      publicBaseUrl: config.bot.publicBaseUrl,
      provider: config.bot.paymentProvider,
      apiBase: config.bot.paymentApiBase,
      apiKey: config.bot.paymentApiKey,
      callbackSecret: config.bot.paymentCallbackSecret,
      createPath: config.bot.paymentCreatePath,
      statusPath: config.bot.paymentStatusPath,
      log,
    });

  const sendEnvelope =
    options.deps?.sendEnvelope ?? ((envelope: EnvelopeV1) => env.EVENTS.send(envelope, { contentType: "json" }));

  // ---- every minute --------------------------------------------------------

  jobs["outbox_flush"] = await runJob(log, "outbox_flush", async () => {
    const result = await flushOutbox({ env, config, client, log, now: options.deps?.now });
    return { claimed: result.claimed, sent: result.sent, retried: result.retried, failed: result.failed };
  });

  jobs["expire_orders"] = await runJob(log, "expire_orders", async (): Promise<Record<string, unknown>> => {
    if (!sql) return { skipped: "turso_not_configured" };
    const due = await listOrdersDueForExpiry(sql, { at, limit: 50 });
    let expired = 0;
    let notified = 0;

    for (const order of due) {
      const applied = await transitionOrder(sql, {
        kodePesanan: order.kodePesanan,
        from: ["pending", "awaiting_approval", "approved"],
        to: "expired",
        at,
      });
      if (!applied) continue;
      expired += 1;

      const payment = await findPaymentForOrder(sql, order.id);
      if (payment) {
        await updatePayment(sql, { kodeBayar: payment.kodeBayar, at, patch: { status: "expired" } });
      }

      // The customer is told through the outbox: the dedupe key is what stops a
      // second cron pass from sending a second "kedaluwarsa" message.
      const queued = await enqueueOutbox(db, {
        message: { kind: "text", body: expiredMessage(order) },
        chatJid: order.waChatJid,
        orderRef: order.ref,
        dedupeKey: `order:${order.ref}:expired`,
        at,
      });
      if (!queued.deduped) notified += 1;
      log.info("order_expired", { order: order.kodePesanan, chatJid: order.waChatJid });
    }

    return { due: due.length, expired, notified };
  });

  jobs["reconcile_payments"] = await runJob(log, "reconcile_payments", async (): Promise<Record<string, unknown>> => {
    if (!sql) return { skipped: "turso_not_configured" };
    if (config.bot.paymentDryRun) return { skipped: "dry_run" };

    const pending = await listOrdersInStatus(sql, ["pending"], 25);
    let checked = 0;
    let enqueued = 0;
    let skipped = 0;

    for (const order of pending) {
      const payment = await findPaymentForOrder(sql, order.id);
      if (!payment || payment.provider !== provider.name) {
        skipped += 1;
        continue;
      }
      checked += 1;

      const status = await provider.queryStatus({ kodeBayar: payment.kodeBayar, providerRef: payment.providerRef });
      if (!status.ok) {
        log.warn("reconcile_query_failed", { order: order.kodePesanan, error: status.error });
        skipped += 1;
        continue;
      }
      if (status.status === "unknown") {
        // Still waiting: report only orders that are old enough to worry about.
        if (order.expiresAt !== null && order.expiresAt < at) {
          log.warn("reconcile_stale_pending", { order: order.kodePesanan, expiresAt: order.expiresAt });
        }
        continue;
      }

      // The queue is the single writer: the cron only describes what the gateway
      // said, exactly like a callback would.
      const envelope = paymentEnvelope(
        {
          kodeBayar: payment.kodeBayar,
          orderRef: order.ref,
          status: status.status,
          amount: status.amount ?? null,
          providerRef: status.providerRef ?? payment.providerRef,
          metode: status.metode ?? payment.metode,
          paidAt: status.paidAt ?? null,
          source: "gateway",
          raw: status.raw,
        },
        { slug: config.slug, receivedAt: new Date(at) },
      );
      try {
        await sendEnvelope(envelope);
        enqueued += 1;
        log.info("reconcile_enqueued", { order: order.kodePesanan, status: status.status, deliveryId: envelope.deliveryId });
      } catch (error) {
        log.error("reconcile_enqueue_failed", { order: order.kodePesanan, error: String(error) });
      }
    }

    return { pending: pending.length, checked, enqueued, skipped };
  });

  // ---- interval jobs -------------------------------------------------------

  // Contact sync: the only job that talks to wuzapi, and the only one whose
  // interval is a var (CONTACT_SYNC_INTERVAL_MINUTES = 0 disables it).
  jobs["contact_sync"] = await runJob(
    log,
    "contact_sync",
    async (): Promise<ContactSyncResult | { disabled: true } | { skipped: string }> => {
      if (config.bot.contactSyncIntervalMinutes <= 0) return { disabled: true };
      if (!(await claimIntervalJob(db, "contact_sync", config.bot.contactSyncIntervalMinutes, at, options.forced))) {
        return { skipped: "not_due" };
      }
      return await syncContacts(db, client, { at, log });
    },
  );

  jobs["retry_unreplied"] = await runJob(log, "retry_unreplied", async (): Promise<Record<string, unknown>> => {
    if (config.bot.retryUnrepliedMinutes <= 0) return { disabled: true };
    const cutoff = at - config.bot.retryUnrepliedMinutes * 60_000;
    const rows = await db
      .prepare(
        `SELECT chat_jid, last_inbound_at, last_outbound_at
           FROM chat_state
          WHERE bot_enabled = 1
            AND last_inbound_at IS NOT NULL
            AND last_inbound_at <= ?
            AND (last_outbound_at IS NULL OR last_outbound_at < last_inbound_at)
          ORDER BY last_inbound_at
          LIMIT 20`,
      )
      .bind(cutoff)
      .all<{ chat_jid: string; last_inbound_at: number; last_outbound_at: number | null }>();

    let nudged = 0;
    for (const row of rows.results) {
      log.warn("unreplied_chat", {
        chatJid: row.chat_jid,
        lastInboundAt: row.last_inbound_at,
        lastOutboundAt: row.last_outbound_at,
      });
      const queued = await enqueueOutbox(db, {
        message: {
          kind: "text",
          body: "Mohon maaf atas keterlambatannya, pesan Kakak sedang kami proses. Admin kami akan segera membalas.",
        },
        chatJid: row.chat_jid,
        dedupeKey: `chat:${row.chat_jid}:nudge:${row.last_inbound_at}`,
        at,
      });
      if (!queued.deduped) nudged += 1;
    }
    return { candidates: rows.results.length, nudged };
  });

  // Retention sweep once a day; the claim keeps it from running every minute.
  jobs["prune_history"] = await runJob(log, "prune_history", async () => {
    if (!(await claimIntervalJob(db, "prune_history", 24 * 60, at, false))) return { skipped: "not_due" };
    const before = at - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
    const deleted = await pruneHistory(db, before, 500);
    const cards = await prunePending(db, at - PENDING_CARD_TTL_HOURS * 60 * 60 * 1_000);
    return { deleted, cards };
  });

  return { jobs };
}

/** The Turso client for the cron: injected in tests, from config in production. */
function resolveSql(options: CronOptions): SqlClient | null {
  if (options.deps?.sqlClient) return options.deps.sqlClient;
  const { config } = options;
  if (!tursoConfigured({ url: config.bot.tursoDatabaseUrl, authToken: config.bot.tursoAuthToken })) return null;
  try {
    return createTursoSqlClient({ url: config.bot.tursoDatabaseUrl, authToken: config.bot.tursoAuthToken });
  } catch {
    return null;
  }
}
