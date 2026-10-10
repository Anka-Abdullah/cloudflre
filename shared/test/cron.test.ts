/**
 * FASE 7 acceptance tests: the cron jobs, the DLQ alert and the two queue kinds
 * that are not wuzapi events.
 *
 * The cron is where "nothing is lost" is actually enforced — an order that nobody
 * paid, a receipt whose send failed, a chat that was never answered — so the
 * assertions here are about *not doing things twice* as much as about doing them:
 * a second cron pass must not send a second expiry notice, and a reconciled
 * payment must arrive as an envelope (the queue stays the only writer of order
 * state) rather than as a direct update.
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Env, type InstanceConfig } from "../src/config";
import { ENVELOPE_VERSION, type EnvelopeV1 } from "../src/envelope";
import { D1SqlClient } from "./d1-sql-client";
import { stubRoutes } from "./helpers";
import { runCronJobs } from "../src/cron";
import { handleDlqBatch } from "../src/consumer/dlq";
import { createMessageBatch } from "cloudflare:test";
import { startCheckout } from "../src/bot/payment/checkout";
import { ensureTursoSchema, findOrderByKode, findPaymentForOrder } from "../src/bot/payment/turso";
import { enqueueOutbox, listOutboxForOrder, outboxStats } from "../src/bot/outbox/store";
import { MockPaymentProvider } from "../src/bot/payment/provider";
import { TelegramClient } from "../src/bot/telegram/client";
import { WuzapiClient } from "../src/bot/wuzapi/client";
import { handleBotBatch } from "../src/bot/queue/router";
import { rememberPending } from "../src/bot/telegram/pending";
import { createLogger } from "../src/lib/logger";
import type { ResolvedProduct } from "../src/bot/knowledge/catalog";

const db = (env as unknown as { BOT_DB: D1Database }).BOT_DB;
const baseConfig = loadConfig(env as unknown as Env);
const sql = new D1SqlClient(db);
const quiet = createLogger({ handler: "test" }, () => {});
const CHAT = "628111@s.whatsapp.net";
const NOW = new Date("2026-10-10T03:00:00.000Z");

const catalog: ResolvedProduct[] = [
  {
    kode: "100370",
    nama: "Kaos Polos",
    harga: 75_000,
    ordinal: 1,
    templateId: "100370",
    sku: "",
    ongkirFromKnowledge: true,
    ongkirRaw: "termasuk",
    ongkirKnown: true,
    ongkirIncluded: true,
    ongkirSource: "knowledge",
  },
];

function config(bot: Partial<InstanceConfig["bot"]> = {}): InstanceConfig {
  return { ...baseConfig, bot: { ...baseConfig.bot, mode: "on", paymentDryRun: true, ...bot } };
}

function wuzapiStub() {
  const { stub, calls } = stubRoutes({
    "/chat/send/text": { body: { code: 200, success: true, data: { Id: "WA-1" } } },
    "/chat/send/document": { body: { code: 200, success: true, data: { Id: "WA-2" } } },
    "/user/contacts": { body: { code: 200, success: true, data: {} } },
  });
  return {
    client: new WuzapiClient({
      baseUrl: "https://wuzapi.test",
      token: "t",
      deps: { fetchImpl: stub, log: quiet, sleep: async () => {}, retryDelaysMs: [] },
    }),
    calls,
  };
}

function telegramStub() {
  const { stub, calls } = stubRoutes({
    "/sendMessage": { body: { ok: true, result: { message_id: 777 } } },
  });
  return {
    client: new TelegramClient({ botToken: "t", chatId: "-100", apiBase: "https://api.telegram.test", deps: { fetchImpl: stub, log: quiet, sleep: async () => {} } }),
    calls,
  };
}

async function createPendingOrder(
  expiresInMs = 60_000,
  overrides: { provider?: MockPaymentProvider } = {},
): Promise<{ ref: string; kodePesanan: string; kodeBayar: string; id: number }> {
  const outcome = await startCheckout({
    env: { BOT_DB: db },
    config: config({ telegramEnabled: false, paymentDryRun: overrides.provider === undefined }),
    chatJid: CHAT,
    customer: { nama: "Budi", alamat: "Jl. Merdeka 1" },
    items: [{ kode: "100370", qty: 2 }],
    catalog,
    deps: {
      sqlClient: sql,
      log: quiet,
      now: () => NOW,
      ...(overrides.provider ? { provider: overrides.provider } : {}),
    },
  });
  const order = outcome.order!;
  const expiresAt = NOW.getTime() + expiresInMs;
  await sql.execute({ sql: "UPDATE orders SET expires_at = ? WHERE id = ?", args: [expiresAt, order.id] });
  return { ref: order.ref, kodePesanan: order.kodePesanan, kodeBayar: outcome.payment?.kodeBayar ?? "", id: order.id };
}

beforeEach(async () => {
  await ensureTursoSchema(sql);
  await sql.batch([
    { sql: "DELETE FROM payments" },
    { sql: "DELETE FROM order_items" },
    { sql: "DELETE FROM orders" },
    { sql: "DELETE FROM customers" },
  ]);
  await db.batch([
    db.prepare("DELETE FROM outbox"),
    db.prepare("DELETE FROM processed_events"),
    db.prepare("DELETE FROM cron_state"),
    db.prepare("DELETE FROM chat_state"),
    db.prepare("DELETE FROM telegram_pending"),
    db.prepare("DELETE FROM messages"),
  ]);
});

describe("cron — outbox flush", () => {
  it("sends a pending row and reports it", async () => {
    const wuzapi = wuzapiStub();
    await enqueueOutbox(db, { message: { kind: "text", body: "halo" }, chatJid: CHAT, dedupeKey: "cron-flush", at: 1_000 });

    const result = await runCronJobs({
      env: env as unknown as Env,
      config: config(),
      deps: { sqlClient: sql, client: wuzapi.client, log: quiet, now: () => new Date(2_000) },
    });

    expect(result.jobs["outbox_flush"]).toMatchObject({ claimed: 1, sent: 1 });
    expect((await outboxStats(db)).sent).toBe(1);
  });

  it("keeps going into the other jobs after a job fails", async () => {
    const result = await runCronJobs({
      env: env as unknown as Env,
      config: config(),
      deps: {
        sqlClient: sql,
        log: quiet,
        now: () => new Date(2_000),
        client: {
          sendText: async () => {
            throw new Error("wuzapi down");
          },
          getContacts: async () => {
            throw new Error("wuzapi down");
          },
        } as unknown as WuzapiClient,
      },
    });

    // The flush reports the failure, and the jobs after it still ran.
    expect(result.jobs["outbox_flush"]).toBeDefined();
    expect(result.jobs["expire_orders"]).toBeDefined();
    expect(result.jobs["reconcile_payments"]).toBeDefined();
  });
});

describe("cron — expire orders", () => {
  it("expires a stale pending order once and tells the customer once", async () => {
    const order = await createPendingOrder(-1_000);
    const deps = { sqlClient: sql, log: quiet, now: () => NOW, client: wuzapiStub().client };

    const first = await runCronJobs({ env: env as unknown as Env, config: config(), deps });
    expect(first.jobs["expire_orders"]).toMatchObject({ due: 1, expired: 1, notified: 1 });
    expect((await findOrderByKode(sql, order.kodePesanan))?.status).toBe("expired");

    const second = await runCronJobs({ env: env as unknown as Env, config: config(), deps });
    expect(second.jobs["expire_orders"]).toMatchObject({ due: 0, expired: 0 });

    // One notice, not two: the outbox dedupe key is what makes the cron safe to
    // run every minute.
    const rows = await listOutboxForOrder(db, order.ref);
    expect(rows.filter((row) => row.dedupeKey === `order:${order.ref}:expired`)).toHaveLength(1);
  });

  it("leaves a live order alone", async () => {
    await createPendingOrder(3_600_000);
    const result = await runCronJobs({
      env: env as unknown as Env,
      config: config(),
      deps: { sqlClient: sql, log: quiet, now: () => NOW, client: wuzapiStub().client },
    });
    expect(result.jobs["expire_orders"]).toMatchObject({ due: 0 });
  });
});

describe("cron — reconcile payments", () => {
  it("enqueues the same envelope a callback would when the gateway says paid", async () => {
    const sent: EnvelopeV1[] = [];
    const provider = new MockPaymentProvider({ status: { status: "paid", amount: 150_000, providerRef: "PR-REC" } });
    const order = await createPendingOrder(3_600_000, { provider });

    const result = await runCronJobs({
      env: env as unknown as Env,
      config: config({ paymentDryRun: false }),
      deps: {
        sqlClient: sql,
        provider,
        client: wuzapiStub().client,
        log: quiet,
        now: () => NOW,
        sendEnvelope: async (envelope) => void sent.push(envelope),
      },
    });

    expect(result.jobs["reconcile_payments"]).toMatchObject({ checked: 1, enqueued: 1 });
    expect(sent[0]?.kind).toBe("payment.event");
    expect(sent[0]?.event.payload).toMatchObject({ status: "paid", kodeBayar: order.kodeBayar, source: "gateway" });
    // The cron does not touch the order: the queued event does that.
    expect((await findOrderByKode(sql, order.kodePesanan))?.status).toBe("pending");
  });

  it("does nothing while the gateway reports no final status", async () => {
    const provider = new MockPaymentProvider({ status: { status: "unknown" } });
    await createPendingOrder(3_600_000, { provider });
    const sent: EnvelopeV1[] = [];
    const result = await runCronJobs({
      env: env as unknown as Env,
      config: config({ paymentDryRun: false }),
      deps: {
        sqlClient: sql,
        provider,
        client: wuzapiStub().client,
        log: quiet,
        now: () => NOW,
        sendEnvelope: async (envelope) => void sent.push(envelope),
      },
    });

    expect(result.jobs["reconcile_payments"]).toMatchObject({ checked: 1, enqueued: 0 });
    expect(sent).toHaveLength(0);
  });

  it("skips reconciliation in dry-run mode (there is no gateway to ask)", async () => {
    await createPendingOrder(3_600_000);
    const result = await runCronJobs({
      env: env as unknown as Env,
      config: config({ paymentDryRun: true }),
      deps: { sqlClient: sql, client: wuzapiStub().client, log: quiet, now: () => NOW },
    });
    expect(result.jobs["reconcile_payments"]).toEqual({ skipped: "dry_run" });
  });
});

describe("cron — unreplied chats", () => {
  it("is off by default", async () => {
    const result = await runCronJobs({
      env: env as unknown as Env,
      config: config(),
      deps: { sqlClient: sql, client: wuzapiStub().client, log: quiet, now: () => NOW },
    });
    expect(result.jobs["retry_unreplied"]).toEqual({ disabled: true });
  });

  it("nudges a chat that was never answered, exactly once per inbound message", async () => {
    await db
      .prepare(
        `INSERT INTO chat_state (chat_jid, bot_enabled, lock_until, last_inbound_at, last_outbound_at, updated_at)
         VALUES (?, 1, 0, ?, NULL, ?)`,
      )
      .bind(CHAT, NOW.getTime() - 30 * 60_000, NOW.getTime())
      .run();

    const deps = { sqlClient: sql, client: wuzapiStub().client, log: quiet, now: () => NOW };
    const first = await runCronJobs({
      env: env as unknown as Env,
      config: config({ retryUnrepliedMinutes: 10 }),
      deps,
    });
    expect(first.jobs["retry_unreplied"]).toMatchObject({ candidates: 1, nudged: 1 });

    const second = await runCronJobs({
      env: env as unknown as Env,
      config: config({ retryUnrepliedMinutes: 10 }),
      deps,
    });
    expect(second.jobs["retry_unreplied"]).toMatchObject({ candidates: 1, nudged: 0 });
  });
});

describe("DLQ alerts", () => {
  function dlqBatch(): MessageBatch<unknown> {
    return createMessageBatch("wuzip-shared-test-dlq", [
      {
        id: "dlq-1",
        timestamp: NOW,
        attempts: 3,
        body: {
          v: ENVELOPE_VERSION,
          failedAt: NOW.toISOString(),
          stage: "relay",
          reason: "downstream 503",
          queue: "wuzip-shared-test-events",
          messageId: "m-1",
          attempts: 3,
          envelope: null,
        },
      },
    ]);
  }

  it("archives to R2 and alerts Telegram once", async () => {
    const telegram = telegramStub();
    const archived: string[] = [];
    await handleDlqBatch(dlqBatch(), {
      env: env as unknown as Env,
      config: config(),
      deps: {
        log: quiet,
        now: () => NOW,
        put: async (key) => void archived.push(key),
        telegram: telegram.client,
      },
    });

    expect(archived).toHaveLength(1);
    const alert = telegram.calls.find((call) => call.url.endsWith("/sendMessage"));
    expect(String((alert?.body as Record<string, unknown>)["text"])).toContain("DLQ");
    expect(String((alert?.body as Record<string, unknown>)["text"])).toContain("downstream 503");
  });

  it("retries the message when the archive write fails", async () => {
    const batch = dlqBatch();
    await handleDlqBatch(batch, {
      env: env as unknown as Env,
      config: config(),
      deps: {
        log: quiet,
        put: async () => {
          throw new Error("R2 down");
        },
      },
    });
    // The message is not acked, so the queue redelivers it.
    const acked = batch.messages.filter((message) => (message as unknown as { acked?: boolean }).acked === true);
    expect(acked).toHaveLength(0);
  });
});

describe("queue handlers — payment.event", () => {
  function paymentEnvelopeFor(kodeBayar: string, amount: number, deliveryId: string): EnvelopeV1 {
    return {
      v: ENVELOPE_VERSION,
      kind: "payment.event",
      receivedAt: NOW.toISOString(),
      deliveryId,
      contentType: "application/json",
      hmac: { verified: false, reason: "disabled" },
      event: {
        type: "Payment",
        userID: null,
        instanceName: "test",
        payload: {
          kodeBayar,
          orderRef: null,
          status: "paid",
          amount,
          providerRef: "PR-1",
          metode: "qris",
          paidAt: NOW.getTime(),
          source: "gateway",
        },
      },
      source: { worker: "test", slug: "test", ua: null, ip: null, rawSize: null },
    };
  }

  it("settles the order and queues the receipt, once per delivery id", async () => {
    const order = await createPendingOrder(3_600_000);
    const wuzapi = wuzapiStub();

    const run = async (deliveryId: string) => {
      const batch = createMessageBatch("wuzip-shared-test-events", [
        { id: `m-${deliveryId}`, timestamp: NOW, attempts: 1, body: paymentEnvelopeFor(order.kodeBayar, 150_000, deliveryId) },
      ]);
      await handleBotBatch(batch, {
        env: env as unknown as Env,
        config: config(),
        deps: { sqlClient: sql, client: wuzapi.client, log: quiet, now: () => NOW, sleep: async () => {} },
      });
      return batch;
    };

    await run("INV:paid:PR-1");
    expect((await findOrderByKode(sql, order.kodePesanan))?.status).toBe("paid");
    const afterFirst = await listOutboxForOrder(db, order.ref);
    expect(afterFirst.filter((row) => row.dedupeKey === `order:${order.ref}:nota`)).toHaveLength(1);

    // Redelivery of the *same* event id: nothing new happens.
    await run("INV:paid:PR-1");
    const afterSecond = await listOutboxForOrder(db, order.ref);
    expect(afterSecond).toHaveLength(afterFirst.length);
  });
});

describe("queue handlers — outbox.tick", () => {
  it("flushes the outbox on demand", async () => {
    const wuzapi = wuzapiStub();
    await enqueueOutbox(db, { message: { kind: "text", body: "halo" }, chatJid: CHAT, dedupeKey: "tick-1", at: 1_000 });

    const batch = createMessageBatch("wuzip-shared-test-events", [
      {
        id: "tick-1",
        timestamp: NOW,
        attempts: 1,
        body: {
          v: ENVELOPE_VERSION,
          kind: "outbox.tick",
          receivedAt: NOW.toISOString(),
          deliveryId: "outbox.tick:1",
          contentType: "application/json",
          hmac: { verified: false, reason: "disabled" },
          event: { type: "OutboxTick", userID: null, instanceName: "test", payload: { reason: "test" } },
          source: { worker: "test", slug: "test", ua: null, ip: null, rawSize: null },
        } satisfies EnvelopeV1,
      },
    ]);

    await handleBotBatch(batch, {
      env: env as unknown as Env,
      config: config(),
      deps: { client: wuzapi.client, log: quiet, now: () => new Date(2_000), sleep: async () => {} },
    });

    expect((await outboxStats(db)).sent).toBe(1);
  });
});

describe("telegram pending housekeeping", () => {
  it("forgets cards nobody answered after the TTL", async () => {
    await rememberPending(db, { chatId: "-100", messageId: 5, orderRef: "INV-1", kind: "fee", at: 1 });
    const result = await runCronJobs({
      env: env as unknown as Env,
      config: config(),
      deps: { sqlClient: sql, client: wuzapiStub().client, log: quiet, now: () => NOW },
    });

    expect(result.jobs["prune_history"]).toMatchObject({ cards: 1 });
    const left = await db.prepare("SELECT COUNT(*) AS n FROM telegram_pending").first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});

describe("payment row consistency after expiry", () => {
  it("marks the payment expired with the order", async () => {
    const order = await createPendingOrder(-1_000);
    await runCronJobs({
      env: env as unknown as Env,
      config: config(),
      deps: { sqlClient: sql, client: wuzapiStub().client, log: quiet, now: () => NOW },
    });

    const payment = await findPaymentForOrder(sql, order.id);
    expect(payment?.status).toBe("expired");
  });
});
