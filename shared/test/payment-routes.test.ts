/**
 * FASE 5b acceptance tests for the two HTTP doors into the worker:
 * `POST /webhooks/telegram` and `POST /payment/callback`, plus the dry-run page.
 *
 * The handlers are called directly with injected deps (Turso → D1, Telegram HTTP
 * → a stub, `env.EVENTS.send` → an array). That keeps the assertions on the
 * behaviour that matters — 401 on a bad secret, exactly one card edit per update,
 * one envelope per callback — while still exercising the real parsing, the real
 * signature check and the real order state machine.
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Env, type InstanceConfig } from "../src/config";
import type { EnvelopeV1 } from "../src/envelope";
import { D1SqlClient } from "./d1-sql-client";
import { stubRoutes } from "./helpers";
import { TelegramClient } from "../src/bot/telegram/client";
import { handleTelegramWebhook } from "../src/bot/telegram/webhook";
import { consumePending, findPending } from "../src/bot/telegram/pending";
import { handleDryRunAction, handleDryRunPage, handlePaymentCallback } from "../src/bot/payment/routes";
import { startCheckout } from "../src/bot/payment/checkout";
import { ensureTursoSchema, findOrderByKode, findPaymentForOrder } from "../src/bot/payment/turso";
import { listOutboxForOrder } from "../src/bot/outbox/store";
import { hmacSha256Hex } from "../src/lib/hmac";
import { handleAdmin } from "../src/admin/routes";
import { WuzapiClient } from "../src/bot/wuzapi/client";
import { createLogger } from "../src/lib/logger";
import type { ResolvedProduct } from "../src/bot/knowledge/catalog";

const db = (env as unknown as { BOT_DB: D1Database }).BOT_DB;
const baseConfig = loadConfig(env as unknown as Env);
const sql = new D1SqlClient(db);
const quiet = createLogger({ handler: "test" }, () => {});
const CHAT = "628111@s.whatsapp.net";
const ADMIN_CHAT = "-1001234567890";

const catalog: ResolvedProduct[] = [
  {
    kode: "116964",
    nama: "Castelli Entrata",
    harga: 1_400_000,
    ordinal: 1,
    templateId: "116964",
    sku: "",
    ongkirFromKnowledge: null,
    ongkirRaw: null,
    ongkirKnown: false,
    ongkirIncluded: false,
    ongkirSource: "default",
  },
];

function config(bot: Partial<InstanceConfig["bot"]> = {}): InstanceConfig {
  return {
    ...baseConfig,
    bot: {
      ...baseConfig.bot,
      mode: "on",
      paymentDryRun: true,
      paymentCallbackSecret: "callback-secret",
      publicBaseUrl: "https://wuzapi-test.example.workers.dev",
      telegramEnabled: true,
      telegramBotToken: "tg-token",
      telegramChatId: ADMIN_CHAT,
      telegramWebhookSecret: "tg-secret",
      ...bot,
    },
  };
}

/** A WuzAPI client stub for the admin flush route. */
function wuzapiStubForOutbox() {
  const { stub, calls } = stubRoutes({
    "/chat/send/text": { body: { code: 200, success: true, data: { Id: "WA-1" } } },
    "/chat/send/document": { body: { code: 200, success: true, data: { Id: "WA-2" } } },
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

function telegramStub(routes: Record<string, { body?: unknown; status?: number }> = {}) {
  const { stub, calls } = stubRoutes({
    "/sendMessage": { body: { ok: true, result: { message_id: 555 } } },
    "/editMessageText": { body: { ok: true, result: { message_id: 555 } } },
    "/answerCallbackQuery": { body: { ok: true, result: true } },
    ...routes,
  });
  return {
    client: new TelegramClient({
      botToken: "tg-token",
      chatId: ADMIN_CHAT,
      apiBase: "https://api.telegram.test",
      deps: { fetchImpl: stub, log: quiet, sleep: async () => {}, retryDelaysMs: [] },
    }),
    calls,
  };
}

/** A request as Telegram sends it. */
function updateRequest(body: unknown, secret = "tg-secret"): Request {
  return new Request("https://wuzapi-test.example.workers.dev/webhooks/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret === "" ? {} : { "x-telegram-bot-api-secret-token": secret }),
    },
    body: JSON.stringify(body),
  });
}

function callbackUpdate(updateId: number, data: string, chatId = ADMIN_CHAT): unknown {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      data,
      from: { id: 42 },
      message: { message_id: 555, chat: { id: Number(chatId) } },
    },
  };
}

function replyUpdate(updateId: number, text: string, replyTo = 555, chatId = ADMIN_CHAT): unknown {
  return {
    update_id: updateId,
    message: { message_id: 900 + updateId, text, chat: { id: Number(chatId) }, reply_to_message: { message_id: replyTo } },
  };
}

/**
 * An order waiting for the admin, with its payment row and a card id — the card
 * is actually sent (through a stub), because the admin's callback edits it and
 * `telegramMessageId` is what makes that possible.
 */
async function awaitingOrder(): Promise<string> {
  const telegram = telegramStub();
  const outcome = await startCheckout({
    env: { BOT_DB: db },
    config: config(),
    chatJid: CHAT,
    customer: { nama: "Budi", alamat: "Jl. Merdeka 1" },
    items: [{ kode: "116964", qty: 1 }],
    catalog,
    deps: { sqlClient: sql, log: quiet, telegram: telegram.client },
  });
  return outcome.order?.kodePesanan ?? "";
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
    db.prepare("DELETE FROM telegram_pending"),
    db.prepare("DELETE FROM messages"),
  ]);
});

describe("POST /webhooks/telegram — authentication", () => {
  it("refuses a missing or wrong secret token", async () => {
    const telegram = telegramStub();
    const wrong = await handleTelegramWebhook(updateRequest({ update_id: 1 }, "salah"), {
      env: env as unknown as Env,
      config: config(),
      deps: { sqlClient: sql, telegram: telegram.client, log: quiet },
    });
    expect(wrong.status).toBe(401);

    const missing = await handleTelegramWebhook(updateRequest({ update_id: 2 }, ""), {
      env: env as unknown as Env,
      config: config(),
      deps: { sqlClient: sql, telegram: telegram.client, log: quiet },
    });
    expect(missing.status).toBe(401);
    expect(telegram.calls).toHaveLength(0);
  });

  it("fails closed when the worker has no secret configured", async () => {
    const response = await handleTelegramWebhook(updateRequest({ update_id: 3 }), {
      env: env as unknown as Env,
      config: config({ telegramWebhookSecret: "" }),
      deps: { sqlClient: sql, log: quiet },
    });
    expect(response.status).toBe(401);
  });

  it("refuses a non-POST method", async () => {
    const response = await handleTelegramWebhook(
      new Request("https://x/webhooks/telegram", { method: "GET", headers: { "x-telegram-bot-api-secret-token": "tg-secret" } }),
      { env: env as unknown as Env, config: config(), deps: { sqlClient: sql, log: quiet } },
    );
    expect(response.status).toBe(405);
  });

  it("ignores a callback from a chat that is not the configured admin", async () => {
    const telegram = telegramStub();
    const kode = await awaitingOrder();
    const response = await handleTelegramWebhook(updateRequest(callbackUpdate(10, `o:${kode}:a`, "-100999")), {
      env: env as unknown as Env,
      config: config(),
      deps: { sqlClient: sql, telegram: telegram.client, log: quiet },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { ignored?: string }).ignored).toContain("chat");
    expect((await findOrderByKode(sql, kode))?.status).toBe("awaiting_approval");
  });
});

describe("POST /webhooks/telegram — approval", () => {
  it("approves, edits the card once and queues exactly one link message", async () => {
    const telegram = telegramStub();
    const kode = await awaitingOrder();
    const deps = { sqlClient: sql, telegram: telegram.client, wuzapi: wuzapiStubForOutbox().client, log: quiet };

    const response = await handleTelegramWebhook(updateRequest(callbackUpdate(20, `o:${kode}:a`)), {
      env: env as unknown as Env,
      config: config(),
      deps,
    });
    expect(response.status).toBe(200);

    const order = await findOrderByKode(sql, kode);
    expect(order?.status).toBe("pending");
    expect(order?.paymentUrl).toContain("/dry-run/");

    const edits = telegram.calls.filter((call) => call.url.endsWith("/editMessageText"));
    expect(edits).toHaveLength(1);
    expect(String((edits[0]?.body as Record<string, unknown>)["text"])).toContain("DISETUJUI");

    const queued = await listOutboxForOrder(db, order?.ref ?? "");
    expect(queued).toHaveLength(1);
    expect(queued[0]?.dedupeKey).toBe(`order:${order?.ref}:link`);
  });

  it("does not approve twice when Telegram redelivers the same update", async () => {
    const telegram = telegramStub();
    const kode = await awaitingOrder();
    const deps = { sqlClient: sql, telegram: telegram.client, wuzapi: wuzapiStubForOutbox().client, log: quiet };
    const update = callbackUpdate(21, `o:${kode}:a`);

    await handleTelegramWebhook(updateRequest(update), { env: env as unknown as Env, config: config(), deps });
    const second = await handleTelegramWebhook(updateRequest(update), {
      env: env as unknown as Env,
      config: config(),
      deps,
    });

    expect(((await second.json()) as { duplicate?: boolean }).duplicate).toBe(true);
    expect(telegram.calls.filter((call) => call.url.endsWith("/editMessageText"))).toHaveLength(1);
    const order = await findOrderByKode(sql, kode);
    expect(await listOutboxForOrder(db, order?.ref ?? "")).toHaveLength(1);
  });

  it("rejects with the reason the customer will read", async () => {
    const telegram = telegramStub();
    const kode = await awaitingOrder();
    const response = await handleTelegramWebhook(updateRequest(callbackUpdate(22, `o:${kode}:r`)), {
      env: env as unknown as Env,
      config: config(),
      deps: { sqlClient: sql, telegram: telegram.client, wuzapi: wuzapiStubForOutbox().client, log: quiet },
    });
    expect(response.status).toBe(200);

    const order = await findOrderByKode(sql, kode);
    expect(order?.status).toBe("rejected");
    const queued = await listOutboxForOrder(db, order?.ref ?? "");
    expect(queued).toHaveLength(1);
    expect(queued[0]?.dedupeKey).toBe(`order:${order?.ref}:rejected`);
  });

  it("asks for the new fee with force_reply and applies the admin's answer", async () => {
    const telegram = telegramStub();
    const kode = await awaitingOrder();
    const deps = { sqlClient: sql, telegram: telegram.client, wuzapi: wuzapiStubForOutbox().client, log: quiet };

    // 1. "Ubah Biaya" → the bot asks for a number, with force_reply.
    await handleTelegramWebhook(updateRequest(callbackUpdate(30, `o:${kode}:f`)), {
      env: env as unknown as Env,
      config: config(),
      deps,
    });
    const prompt = telegram.calls.find((call) => call.url.endsWith("/sendMessage"));
    const markup = (prompt?.body as Record<string, unknown>)["reply_markup"] as { force_reply?: boolean };
    expect(markup.force_reply).toBe(true);

    const pending = await findPending(db, { chatId: ADMIN_CHAT, messageId: 555 });
    expect(pending).toMatchObject({ orderRef: kode, kind: "fee" });
    expect(await findOrderByKode(sql, kode)).toMatchObject({ status: "awaiting_approval" });

    // 2. The admin replies with an amount.
    await handleTelegramWebhook(updateRequest(replyUpdate(31, "Rp 25.000")), {
      env: env as unknown as Env,
      config: config(),
      deps,
    });

    const order = await findOrderByKode(sql, kode);
    expect(order?.status).toBe("pending");
    expect(order?.additionalFee).toBe(25_000);
    expect(order?.grandTotal).toBe(1_425_000);

    // …and the pending row was consumed with the answer, so an old card cannot be
    // answered twice.
    expect(await findPending(db, { chatId: ADMIN_CHAT, messageId: 555 })).toBeNull();
    expect(await consumePending(db, { chatId: ADMIN_CHAT, messageId: 555 })).toBe(false);
  });

  it("answers /start with the chat id, which is how TELEGRAM_CHAT_ID is filled", async () => {
    const telegram = telegramStub();
    await handleTelegramWebhook(updateRequest({ update_id: 40, message: { message_id: 1, text: "/start", chat: { id: Number(ADMIN_CHAT) } } }), {
      env: env as unknown as Env,
      config: config(),
      deps: { sqlClient: sql, telegram: telegram.client, log: quiet },
    });

    const sent = telegram.calls.find((call) => call.url.endsWith("/sendMessage"));
    expect(String((sent?.body as Record<string, unknown>)["text"])).toContain(`TELEGRAM_CHAT_ID=${ADMIN_CHAT}`);
  });

  it("stays 200 when Telegram itself fails, so the update is not retried forever", async () => {
    const telegram = telegramStub({ "/editMessageText": { status: 400, body: { ok: false, description: "message is not modified" } } });
    const kode = await awaitingOrder();
    const response = await handleTelegramWebhook(updateRequest(callbackUpdate(41, `o:${kode}:a`)), {
      env: env as unknown as Env,
      config: config(),
      deps: { sqlClient: sql, telegram: telegram.client, wuzapi: wuzapiStubForOutbox().client, log: quiet },
    });

    // The order still moved: a failing card edit must not undo the decision.
    expect(response.status).toBe(200);
    expect((await findOrderByKode(sql, kode))?.status).toBe("pending");
  });
});

describe("POST /payment/callback", () => {
  function callbackRequest(body: unknown, signature: string | null): Request {
    return new Request("https://wuzapi-test.example.workers.dev/payment/callback", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(signature === null ? {} : { "x-callback-signature": signature }),
      },
      body: JSON.stringify(body),
    });
  }

  async function sign(body: unknown, secret = "callback-secret"): Promise<string> {
    const encoder = new TextEncoder();
    return await hmacSha256Hex(encoder.encode(secret), encoder.encode(JSON.stringify(body)));
  }

  it("refuses an unsigned or wrongly signed callback", async () => {
    const options = { env: env as unknown as Env, config: config(), deps: { log: quiet, sqlClient: sql } };
    expect((await handlePaymentCallback(callbackRequest({ status: "paid" }, null), options)).status).toBe(401);
    expect((await handlePaymentCallback(callbackRequest({ status: "paid" }, "deadbeef"), options)).status).toBe(401);
  });

  it("refuses everything when the secret is not configured", async () => {
    const body = { kode_bayar: "PAY-1", status: "paid", amount: 1000 };
    const response = await handlePaymentCallback(callbackRequest(body, await sign(body)), {
      env: env as unknown as Env,
      config: config({ paymentCallbackSecret: "" }),
      deps: { log: quiet, sqlClient: sql },
    });
    expect(response.status).toBe(503);
  });

  it("accepts a signed callback and enqueues the frozen envelope", async () => {
    const sent: EnvelopeV1[] = [];
    const body = { kode_bayar: "PAY-20261010-AAAAAA-P1", status: "PAID", amount: 1_400_000, provider_ref: "PR-9", paid_at: 1_760_000_000 };
    const response = await handlePaymentCallback(callbackRequest(body, await sign(body)), {
      env: env as unknown as Env,
      config: config(),
      deps: { log: quiet, sqlClient: sql, send: async (envelope) => void sent.push(envelope) },
    });

    expect(response.status).toBe(202);
    expect(sent).toHaveLength(1);
    const envelope = sent[0]!;
    expect(envelope.kind).toBe("payment.event");
    expect(envelope.event.payload).toMatchObject({
      kodeBayar: "PAY-20261010-AAAAAA-P1",
      status: "paid",
      amount: 1_400_000,
      providerRef: "PR-9",
      source: "gateway",
    });
    // Normalised epoch seconds → milliseconds.
    expect((envelope.event.payload as { paidAt: number }).paidAt).toBe(1_760_000_000_000);
    // The frozen delivery id, so a resent webhook is a duplicate.
    expect(envelope.deliveryId).toBe("PAY-20261010-AAAAAA-P1:paid:PR-9");
  });

  it("answers 503 when the queue write fails, so the gateway retries", async () => {
    const body = { kode_bayar: "PAY-1", status: "paid" };
    const response = await handlePaymentCallback(callbackRequest(body, await sign(body)), {
      env: env as unknown as Env,
      config: config(),
      deps: {
        log: quiet,
        sqlClient: sql,
        send: async () => {
          throw new Error("queue unavailable");
        },
      },
    });
    expect(response.status).toBe(503);
  });

  it("rejects a payload it cannot read", async () => {
    const body = { sesuatu: "lain" };
    const response = await handlePaymentCallback(callbackRequest(body, await sign(body)), {
      env: env as unknown as Env,
      config: config(),
      deps: { log: quiet, sqlClient: sql },
    });
    expect(response.status).toBe(400);
  });
});

describe("dry-run page", () => {
  async function paidReady(): Promise<{ kodeBayar: string; kodePesanan: string }> {
    const outcome = await startCheckout({
      env: { BOT_DB: db },
      config: config({ telegramEnabled: false }),
      chatJid: CHAT,
      customer: { nama: "Budi", alamat: "Jl. Merdeka 1" },
      items: [{ kode: "116964", qty: 1 }],
      catalog,
      deps: { sqlClient: sql, log: quiet, telegram: undefined },
    });
    return { kodeBayar: outcome.payment?.kodeBayar ?? "", kodePesanan: outcome.order?.kodePesanan ?? "" };
  }

  it("shows the amount and offers the simulation buttons", async () => {
    // An order that goes straight to a link needs an ongkir-included product.
    const withOngkir: ResolvedProduct[] = [{ ...catalog[0]!, ongkirIncluded: true, ongkirKnown: true, ongkirSource: "knowledge" }];
    const outcome = await startCheckout({
      env: { BOT_DB: db },
      config: config({ telegramEnabled: false }),
      chatJid: CHAT,
      customer: { nama: "Budi", alamat: "Jl. Merdeka 1" },
      items: [{ kode: "116964", qty: 1 }],
      catalog: withOngkir,
      deps: { sqlClient: sql, log: quiet },
    });

    const response = await handleDryRunPage(
      { env: env as unknown as Env, config: config(), deps: { log: quiet, sqlClient: sql } },
      outcome.payment?.kodeBayar ?? "",
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("Rp 1.400.000");
    expect(html).toContain(`/dry-run/${outcome.payment?.kodeBayar}/pay`);
    expect(html).toContain("Bayar sekarang");
  });

  it("reports an unknown payment instead of a blank page", async () => {
    const response = await handleDryRunPage(
      { env: env as unknown as Env, config: config(), deps: { log: quiet, sqlClient: sql } },
      "PAY-TIDAK-ADA",
    );
    expect(response.status).toBe(404);
  });

  it("enqueues the same payment event a real callback would", async () => {
    const { kodeBayar } = await paidReady();
    const sent: EnvelopeV1[] = [];
    const request = new Request(`https://x/dry-run/${kodeBayar}/pay`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "action=paid",
    });

    const options = {
      env: env as unknown as Env,
      config: config(),
      deps: { log: quiet, sqlClient: sql, send: async (envelope: EnvelopeV1) => void sent.push(envelope) },
    };
    const response = await handleDryRunAction(request.clone() as Request, options, kodeBayar);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Pembayaran diterima");
    expect(sent[0]?.event.payload).toMatchObject({ status: "paid", source: "dry-run" });
    expect(sent[0]?.deliveryId).toBe(`${kodeBayar}:paid:dry-run`);

    // Pressing the button twice produces the same delivery id, so the consumer
    // sees a duplicate instead of a second payment.
    await handleDryRunAction(request.clone() as Request, options, kodeBayar);
    expect(sent[1]?.deliveryId).toBe(sent[0]?.deliveryId);
  });

  it("refuses the dry-run action when dry-run is disabled", async () => {
    const { kodeBayar } = await paidReady();
    const response = await handleDryRunAction(
      new Request("https://x/pay", { method: "POST", body: "action=paid" }),
      { env: env as unknown as Env, config: config({ paymentDryRun: false }), deps: { log: quiet, sqlClient: sql } },
      kodeBayar,
    );
    expect(response.status).toBe(403);
  });
});

describe("payment row linkage", () => {
  it("keeps one payment row per order, with the card id attached", async () => {
    const kode = await awaitingOrder();
    const order = await findOrderByKode(sql, kode);
    const payment = await findPaymentForOrder(sql, order?.id ?? 0);
    expect(payment?.kodeBayar.startsWith(order?.ref ?? "")).toBe(true);
    expect(payment?.status).toBe("awaiting_approval");
  });
});

describe("/admin order routes — the path without Telegram", () => {
  function adminRequest(path: string, body: unknown = {}, method = "POST"): Request {
    return new Request(`https://wuzapi-test.example.workers.dev${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${baseConfig.bot.adminApiKey}` },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    });
  }

  it("approves an order over HTTP, with an extra fee, and queues the link once", async () => {
    const kode = await awaitingOrder();
    const options = {
      env: env as unknown as Env,
      config: config(),
      deps: { log: quiet, sqlClient: sql, wuzapi: wuzapiStubForOutbox().client },
    };

    const first = await handleAdmin(adminRequest(`/admin/orders/${kode}/approve`, { additionalFee: 10_000 }), `/admin/orders/${kode}/approve`, options);
    expect(first?.status).toBe(200);
    const body = (await first!.json()) as { ok: boolean; order: { status: string; grandTotal: number }; queued: boolean[] };
    expect(body.ok).toBe(true);
    expect(body.order.status).toBe("pending");
    expect(body.order.grandTotal).toBe(1_410_000);
    expect(body.queued).toEqual([true]);

    // A second approval resumes: the link exists, so nothing new is queued.
    const second = await handleAdmin(adminRequest(`/admin/orders/${kode}/approve`, {}), `/admin/orders/${kode}/approve`, options);
    expect(second?.status).toBe(200);
    const order = await findOrderByKode(sql, kode);
    expect(await listOutboxForOrder(db, order?.ref ?? "")).toHaveLength(1);
  });

  it("rejects an order over HTTP", async () => {
    const kode = await awaitingOrder();
    const response = await handleAdmin(
      adminRequest(`/admin/orders/${kode}/reject`, { reason: "alamat di luar jangkauan" }),
      `/admin/orders/${kode}/reject`,
      { env: env as unknown as Env, config: config(), deps: { log: quiet, sqlClient: sql, wuzapi: wuzapiStubForOutbox().client } },
    );
    expect(response?.status).toBe(200);
    expect((await findOrderByKode(sql, kode))?.status).toBe("rejected");
  });

  it("reads an order back with its items and payment", async () => {
    const kode = await awaitingOrder();
    const response = await handleAdmin(adminRequest(`/admin/orders/${kode}`, {}, "GET"), `/admin/orders/${kode}`, {
      env: env as unknown as Env,
      config: config(),
      deps: { log: quiet, sqlClient: sql },
    });
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as { order: { kodePesanan: string }; items: unknown[]; payment: { kodeBayar: string } };
    expect(body.order.kodePesanan).toBe(kode);
    expect(body.items).toHaveLength(1);
    expect(body.payment.kodeBayar).toContain("PAY-");
  });

  it("flushes the outbox on demand and reports the stats", async () => {
    const telegram = telegramStub();
    void telegram;
    const response = await handleAdmin(adminRequest("/admin/outbox/flush"), "/admin/outbox/flush", {
      env: env as unknown as Env,
      config: config(),
      deps: { log: quiet, sqlClient: sql, client: wuzapiStubForOutbox().client },
    });
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as { ok: boolean; stats: { pending: number } };
    expect(body.ok).toBe(true);
    expect(body.stats).toBeDefined();
  });

  it("reports status without leaking secrets", async () => {
    const response = await handleAdmin(adminRequest("/admin/status", {}, "GET"), "/admin/status", {
      env: env as unknown as Env,
      config: config(),
      deps: { log: quiet, sqlClient: sql },
    });
    expect(response?.status).toBe(200);
    const text = await response!.text();
    expect(text).toContain("tursoConfigured");
    expect(text).not.toContain("callback-secret");
    expect(text).not.toContain("tg-token");
  });

  it("answers 404 for an unknown order", async () => {
    const response = await handleAdmin(adminRequest("/admin/orders/INV-TIDAK-ADA", {}, "GET"), "/admin/orders/INV-TIDAK-ADA", {
      env: env as unknown as Env,
      config: config(),
      deps: { log: quiet, sqlClient: sql },
    });
    expect(response?.status).toBe(404);
  });
});
