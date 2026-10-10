/**
 * FASE 5b/6 acceptance tests: checkout → approval → payment → receipt, with the
 * outbox as the single delivery path.
 *
 * What is real here: the order/payment SQL (through `D1SqlClient`, i.e. the real
 * SQLite engine), the checkout state machine, the outbox (claim lease, dedupe
 * keys, retries), the receipt renderer (`pdf-lib`), and the queue handler that
 * settles a payment event. What is injected: the payment provider (Mock/DryRun),
 * the Telegram client's HTTP, and the WuzAPI client's HTTP — the three第三方
 * boundaries.
 *
 * The assertions that matter are the ones about money and duplication:
 *   - a dry-run checkout produces a link and moves the order to `pending`;
 *   - "Terima" issues exactly one link message, even if the callback repeats;
 *   - a paid event produces exactly one receipt, and the second one is a no-op;
 *   - a receipt is queued (not sent inline), so a wuzapi outage cannot lose it.
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Env, type InstanceConfig } from "../src/config";
import type { ResolvedProduct } from "../src/bot/knowledge/catalog";
import { D1SqlClient } from "./d1-sql-client";
import {
  approveOrder,
  createCheckoutContext,
  priceItems,
  rejectOrder,
  startCheckout,
} from "../src/bot/payment/checkout";
import { settlePayment } from "../src/bot/payment/settle";
import { ensureTursoSchema, findOrderByKode, findPaymentForOrder } from "../src/bot/payment/turso";
import { enqueueOutbox, listOutboxForOrder, outboxStats, parseOutboxMessage } from "../src/bot/outbox/store";
import { flushOutbox } from "../src/bot/outbox/flush";
import { buildNotaDocument, renderNotaPdf, renderNotaText, sanitise } from "../src/bot/nota/pdf";
import { TelegramClient } from "../src/bot/telegram/client";
import { parseFeeAmount } from "../src/bot/telegram/cards";
import { WuzapiClient } from "../src/bot/wuzapi/client";
import { createLogger } from "../src/lib/logger";
import { stubRoutes } from "./helpers";

const db = (env as unknown as { BOT_DB: D1Database }).BOT_DB;
const baseConfig = loadConfig(env as unknown as Env);
const sql = new D1SqlClient(db);
const quiet = createLogger({ handler: "test" }, () => {});
const CHAT = "628111@s.whatsapp.net";
const AT = new Date("2026-10-10T03:00:00.000Z");

/** Two products: one with ongkir included, one that needs the admin. */
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
  {
    kode: "116964",
    nama: "Castelli Entrata",
    harga: 1_400_000,
    ordinal: 2,
    templateId: "116964",
    sku: "G 4520009",
    ongkirFromKnowledge: null,
    ongkirRaw: null,
    ongkirKnown: false,
    ongkirIncluded: false,
    ongkirSource: "default",
  },
];

function config(overrides: Partial<InstanceConfig["bot"]> = {}, root: Partial<InstanceConfig> = {}): InstanceConfig {
  return {
    ...baseConfig,
    ...root,
    bot: {
      ...baseConfig.bot,
      mode: "on",
      paymentDryRun: true,
      publicBaseUrl: "https://wuzapi-test.example.workers.dev",
      telegramEnabled: true,
      telegramBotToken: "tg-token",
      telegramChatId: "-1001234567890",
      telegramWebhookSecret: "tg-secret",
      ...overrides,
    },
  };
}

/** A Telegram client whose HTTP is stubbed and whose calls are recorded. */
function telegramStub(routes: Record<string, { body?: unknown; status?: number }> = {}) {
  const { stub, calls } = stubRoutes({
    "/sendMessage": { body: { ok: true, result: { message_id: 101 } } },
    "/editMessageText": { body: { ok: true, result: { message_id: 101 } } },
    "/answerCallbackQuery": { body: { ok: true, result: true } },
    ...routes,
  });
  const client = new TelegramClient({
    botToken: "tg-token",
    chatId: "-1001234567890",
    apiBase: "https://api.telegram.test",
    deps: { fetchImpl: stub, log: quiet, sleep: async () => {} },
  });
  return { client, calls };
}

/** A WuzAPI client whose HTTP is stubbed and whose calls are recorded. */
function wuzapiStub(fail = false) {
  const { stub, calls } = stubRoutes({
    "/chat/send/text": fail
      ? { status: 500, body: { code: 500, success: false, error: "down" } }
      : { body: { code: 200, success: true, data: { Id: "WA-1" } } },
    "/chat/send/document": { body: { code: 200, success: true, data: { Id: "WA-DOC" } } },
    "/chat/presence": { body: { code: 200, success: true, data: {} } },
  });
  const client = new WuzapiClient({
    baseUrl: "https://wuzapi.test",
    token: "wuzapi-token",
    deps: { fetchImpl: stub, log: quiet, sleep: async () => {}, retryDelaysMs: [] },
  });
  return { client, calls };
}

async function reset(): Promise<void> {
  await sql.batch([
    { sql: "DELETE FROM payments" },
    { sql: "DELETE FROM order_items" },
    { sql: "DELETE FROM orders" },
    { sql: "DELETE FROM customers" },
  ]);
  await db.batch([
    db.prepare("DELETE FROM outbox"),
    db.prepare("DELETE FROM processed_events"),
    db.prepare("DELETE FROM messages"),
  ]);
}

beforeEach(async () => {
  // The Turso schema lives in the same D1 database in tests (see D1SqlClient).
  await ensureTursoSchema(sql);
  await reset();
});

describe("priceItems", () => {
  it("re-prices from the catalogue and refuses unknown codes", () => {
    const priced = priceItems([{ kode: "100370", qty: 2 }], catalog);
    expect(priced.ok).toBe(true);
    if (!priced.ok) return;
    expect(priced.items[0]).toMatchObject({ kode: "100370", harga: 75_000, qty: 2 });
    expect(priced.ongkirIncluded).toBe(true);

    const refused = priceItems([{ kode: "TIDAK-ADA", qty: 1 }], catalog);
    expect(refused.ok).toBe(false);

    // Mixed basket: one item without an explicit ongkir decision → admin path.
    const mixed = priceItems([{ kode: "100370", qty: 1 }, { kode: "116964", qty: 1 }], catalog);
    expect(mixed.ok).toBe(true);
    if (mixed.ok) expect(mixed.ongkirIncluded).toBe(false);
  });
});

describe("startCheckout — ongkir included", () => {
  it("creates the order, issues a dry-run link and moves it to pending", async () => {
    const outcome = await startCheckout({
      env: { BOT_DB: db },
      config: config(),
      chatJid: CHAT,
      pushName: "Budi",
      customer: { nama: "Budi", alamat: "Jl. Merdeka 1" },
      items: [{ kode: "100370", qty: 2 }],
      catalog,
      deps: { sqlClient: sql, log: quiet, now: () => AT },
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toBe("payment_link");
    expect(outcome.status).toBe("pending");
    expect(outcome.order?.grandTotal).toBe(150_000);
    expect(outcome.payment?.url).toContain("/dry-run/");
    expect(outcome.messages.join("\n")).toContain("https://wuzapi-test.example.workers.dev/dry-run/");
    expect(outcome.messages.join("\n")).toContain("Rp 150.000");
  });

  it("resumes the same order when the customer asks twice", async () => {
    const first = await startCheckout({
      env: { BOT_DB: db },
      config: config(),
      chatJid: CHAT,
      customer: { nama: "Budi", alamat: "Jl. Merdeka 1" },
      items: [{ kode: "100370", qty: 2 }],
      catalog,
      deps: { sqlClient: sql, log: quiet, now: () => AT },
    });
    const second = await startCheckout({
      env: { BOT_DB: db },
      config: config(),
      chatJid: CHAT,
      customer: { nama: "Budi", alamat: "Jl. Merdeka 1" },
      items: [{ kode: "100370", qty: 2 }],
      catalog,
      deps: { sqlClient: sql, log: quiet, now: () => new Date(AT.getTime() + 60_000) },
    });

    expect(second.reason).toBe("payment_link_resumed");
    expect(second.order?.kodePesanan).toBe(first.order?.kodePesanan);
    expect(second.order?.paymentUrl).toBe(first.order?.paymentUrl);
    const rows = await sql.execute("SELECT COUNT(*) AS n FROM orders");
    expect(Number(rows.rows[0]?.["n"])).toBe(1);
  });

  it("supersedes the previous order when the basket changes", async () => {
    const first = await startCheckout({
      env: { BOT_DB: db },
      config: config(),
      chatJid: CHAT,
      customer: { nama: "Budi", alamat: "Jl. Merdeka 1" },
      items: [{ kode: "100370", qty: 2 }],
      catalog,
      deps: { sqlClient: sql, log: quiet, now: () => AT },
    });
    const second = await startCheckout({
      env: { BOT_DB: db },
      config: config(),
      chatJid: CHAT,
      customer: { nama: "Budi", alamat: "Jl. Merdeka 1" },
      items: [{ kode: "100370", qty: 5 }],
      catalog,
      deps: { sqlClient: sql, log: quiet, now: () => new Date(AT.getTime() + 60_000) },
    });

    expect(second.order?.kodePesanan).not.toBe(first.order?.kodePesanan);
    const older = await findOrderByKode(sql, first.order?.kodePesanan ?? "");
    expect(older).toMatchObject({ status: "superseded", supersededBy: second.order?.kodePesanan });
  });

  it("never takes the price from the cart row", async () => {
    const outcome = await startCheckout({
      env: { BOT_DB: db },
      config: config(),
      chatJid: CHAT,
      customer: { nama: "Budi", alamat: "Jl. Merdeka 1" },
      // A tampered price on the line must be ignored: the catalogue wins.
      items: [{ kode: "116964", qty: 1, harga: 1 } as unknown as { kode: string; qty: number }],
      catalog,
      deps: { sqlClient: sql, log: quiet, now: () => AT },
    });

    expect(outcome.order?.totalHarga).toBe(1_400_000);
  });

  it("reports a missing database instead of throwing", async () => {
    const outcome = await startCheckout({
      env: { BOT_DB: db },
      config: config({ tursoDatabaseUrl: "", tursoAuthToken: "" }),
      chatJid: CHAT,
      customer: { nama: "Budi", alamat: "Jl. Merdeka 1" },
      items: [{ kode: "100370", qty: 1 }],
      catalog,
      deps: { log: quiet, now: () => AT },
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("turso_not_configured");
  });
});

describe("startCheckout — ongkir not included (admin card)", () => {
  it("sends one approval card and waits", async () => {
    const telegram = telegramStub();
    const outcome = await startCheckout({
      env: { BOT_DB: db },
      config: config(),
      chatJid: CHAT,
      pushName: "Budi",
      customer: { nama: "Budi", alamat: "Jl. Merdeka 1" },
      items: [{ kode: "116964", qty: 1 }],
      catalog,
      deps: { sqlClient: sql, log: quiet, now: () => AT, telegram: telegram.client },
    });

    expect(outcome.status).toBe("awaiting_approval");
    expect(outcome.messages.join("\n")).toContain("dikonfirmasi admin");

    const cardCall = telegram.calls.find((call) => call.url.endsWith("/sendMessage"));
    expect(cardCall).toBeDefined();
    const body = cardCall?.body as Record<string, unknown>;
    expect(String(body["text"])).toContain("MENUNGGU PERSETUJUAN");
    const markup = body["reply_markup"] as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    expect(markup.inline_keyboard[0]?.[0]?.callback_data).toContain(":a");
    expect(markup.inline_keyboard[1]?.[0]?.callback_data).toContain(":f");

    // The card's message id is remembered so the card can be edited later.
    const payment = await findPaymentForOrder(sql, outcome.order?.id ?? 0);
    expect(payment?.telegramMessageId).toBe(101);
  });

  it("does not send a second card when the checkout is repeated", async () => {
    const telegram = telegramStub();
    const deps = { sqlClient: sql, log: quiet, now: () => AT, telegram: telegram.client };
    await startCheckout({
      env: { BOT_DB: db },
      config: config(),
      chatJid: CHAT,
      customer: { nama: "Budi", alamat: "Jl. Merdeka 1" },
      items: [{ kode: "116964", qty: 1 }],
      catalog,
      deps,
    });
    await startCheckout({
      env: { BOT_DB: db },
      config: config(),
      chatJid: CHAT,
      customer: { nama: "Budi", alamat: "Jl. Merdeka 1" },
      items: [{ kode: "116964", qty: 1 }],
      catalog,
      deps,
    });

    expect(telegram.calls.filter((call) => call.url.endsWith("/sendMessage"))).toHaveLength(1);
  });

  it("still records the order when Telegram is not configured", async () => {
    const outcome = await startCheckout({
      env: { BOT_DB: db },
      config: config({ telegramEnabled: false }),
      chatJid: CHAT,
      customer: { nama: "Budi", alamat: "Jl. Merdeka 1" },
      items: [{ kode: "116964", qty: 1 }],
      catalog,
      deps: { sqlClient: sql, log: quiet, now: () => AT },
    });

    expect(outcome.status).toBe("awaiting_approval");
    expect(outcome.order).not.toBeNull();
  });
});

describe("approve / reject", () => {
  async function awaitingOrder(): Promise<string> {
    const outcome = await startCheckout({
      env: { BOT_DB: db },
      config: config({ telegramEnabled: false }),
      chatJid: CHAT,
      customer: { nama: "Budi", alamat: "Jl. Merdeka 1" },
      items: [{ kode: "116964", qty: 1 }],
      catalog,
      deps: { sqlClient: sql, log: quiet, now: () => AT },
    });
    return outcome.order?.kodePesanan ?? "";
  }

  it("approves with an additional fee and issues the link once", async () => {
    const kode = await awaitingOrder();
    const context = createCheckoutContext({
      env: { BOT_DB: db },
      config: config(),
      deps: { sqlClient: sql, log: quiet, now: () => AT },
    });

    const first = await approveOrder(context, { kodePesanan: kode, additionalFee: 25_000, by: "test" });
    expect(first.ok).toBe(true);
    expect(first.order?.status).toBe("pending");
    expect(first.order?.grandTotal).toBe(1_425_000);
    expect(first.messages.join("\n")).toContain("Rp 1.425.000");

    const second = await approveOrder(context, { kodePesanan: kode, additionalFee: 25_000, by: "test" });
    expect(second.ok).toBe(true);
    // Re-approving reuses the same link instead of creating a second payment row.
    expect(second.order?.paymentUrl).toBe(first.order?.paymentUrl);

    const payments = await sql.execute("SELECT COUNT(*) AS n FROM payments");
    expect(Number(payments.rows[0]?.["n"])).toBe(1);
  });

  it("rejects with a reason and stops the order", async () => {
    const kode = await awaitingOrder();
    const context = createCheckoutContext({
      env: { BOT_DB: db },
      config: config(),
      deps: { sqlClient: sql, log: quiet, now: () => AT },
    });

    const result = await rejectOrder(context, { kodePesanan: kode, reason: "stok habis" });
    expect(result.rejected).toBe(true);
    expect(result.order?.status).toBe("rejected");
    expect(result.messages[0]).toContain("stok habis");

    // A rejected order cannot be approved afterwards.
    const after = await approveOrder(context, { kodePesanan: kode });
    expect(after.ok).toBe(false);
  });
});

describe("settlePayment", () => {
  async function paidReadyOrder(): Promise<{ kodePesanan: string; kodeBayar: string; grandTotal: number }> {
    const outcome = await startCheckout({
      env: { BOT_DB: db },
      config: config(),
      chatJid: CHAT,
      customer: { nama: "Budi", alamat: "Jl. Merdeka 1" },
      items: [{ kode: "100370", qty: 2 }],
      catalog,
      deps: { sqlClient: sql, log: quiet, now: () => AT },
    });
    return {
      kodePesanan: outcome.order?.kodePesanan ?? "",
      kodeBayar: outcome.payment?.kodeBayar ?? "",
      grandTotal: outcome.order?.grandTotal ?? 0,
    };
  }

  it("marks the order paid and queues exactly one receipt", async () => {
    const order = await paidReadyOrder();
    const result = await settlePayment(
      { env: { BOT_DB: db }, sql, log: quiet },
      { kodeBayar: order.kodeBayar, status: "paid", amount: order.grandTotal, providerRef: "PR-1", paidAt: AT.getTime() + 1_000, at: AT.getTime() + 1_000 },
    );

    expect(result.applied).toBe(true);
    expect(result.order?.status).toBe("paid");
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.kind).toBe("document");
    if (result.documents[0]?.kind === "document") {
      expect(result.documents[0].fileName).toContain("Nota-");
      expect(result.documents[0].mimeType).toBe("application/pdf");
    }

    const queued = await listOutboxForOrder(db, result.order?.ref ?? "");
    expect(queued).toHaveLength(1);
    expect(parseOutboxMessage(queued[0]!)?.kind).toBe("document");
  });

  it("is a no-op on the second paid callback, with no second receipt", async () => {
    const order = await paidReadyOrder();
    const event = {
      kodeBayar: order.kodeBayar,
      status: "paid" as const,
      amount: order.grandTotal,
      providerRef: "PR-1",
      paidAt: AT.getTime() + 1_000,
      at: AT.getTime() + 1_000,
    };
    await settlePayment({ env: { BOT_DB: db }, sql, log: quiet }, event);
    const second = await settlePayment({ env: { BOT_DB: db }, sql, log: quiet }, event);

    expect(second.applied).toBe(false);
    expect(second.reason).toBe("already_paid");
    expect(await listOutboxForOrder(db, second.order?.ref ?? "")).toHaveLength(1);
  });

  it("refuses a callback whose amount does not match", async () => {
    const order = await paidReadyOrder();
    const result = await settlePayment(
      { env: { BOT_DB: db }, sql, log: quiet },
      { kodeBayar: order.kodeBayar, status: "paid", amount: 1, at: AT.getTime() + 1_000 },
    );

    expect(result.applied).toBe(false);
    expect(result.reason).toBe("amount_mismatch");
    const stored = await findOrderByKode(sql, order.kodePesanan);
    expect(stored?.status).toBe("pending");
    expect(await listOutboxForOrder(db, stored?.ref ?? "")).toHaveLength(0);
  });

  it("expires an order and tells the customer", async () => {
    const order = await paidReadyOrder();
    const result = await settlePayment(
      { env: { BOT_DB: db }, sql, log: quiet },
      { kodeBayar: order.kodeBayar, status: "expired", at: AT.getTime() + 86_400_000 },
    );

    expect(result.applied).toBe(true);
    expect(result.order?.status).toBe("expired");
    expect(result.messages[0]).toMatchObject({ kind: "text" });
  });

  it("reports an unknown order instead of guessing", async () => {
    const result = await settlePayment(
      { env: { BOT_DB: db }, sql, log: quiet },
      { kodeBayar: "PAY-TIDAK-ADA", status: "paid", amount: 1, at: AT.getTime() },
    );
    expect(result.applied).toBe(false);
    expect(result.reason).toBe("unknown_order");
  });
});

describe("outbox", () => {
  it("dedupes by business key", async () => {
    const first = await enqueueOutbox(db, {
      message: { kind: "text", body: "halo" },
      chatJid: CHAT,
      orderRef: "PAY-1",
      dedupeKey: "order:PAY-1:link",
      at: 1_000,
    });
    const second = await enqueueOutbox(db, {
      message: { kind: "text", body: "halo" },
      chatJid: CHAT,
      orderRef: "PAY-1",
      dedupeKey: "order:PAY-1:link",
      at: 2_000,
    });

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.id).toBe(first.id);
    expect((await outboxStats(db)).pending).toBe(1);
  });

  it("sends once, with a deterministic message id, and marks the row sent", async () => {
    const wuzapi = wuzapiStub();
    await enqueueOutbox(db, { message: { kind: "text", body: "halo" }, chatJid: CHAT, dedupeKey: "k1", at: 1_000 });

    const result = await flushOutbox({
      env: { BOT_DB: db },
      config: config(),
      client: wuzapi.client,
      log: quiet,
      now: () => new Date(2_000),
    });

    expect(result).toMatchObject({ claimed: 1, sent: 1, retried: 0, failed: 0 });
    const send = wuzapi.calls.find((call) => call.url.endsWith("/chat/send/text"));
    // The msgid is derived from the row id, so a retry after a crash dedupes on
    // WhatsApp's side instead of showing the message twice.
    expect((send?.body as Record<string, unknown>)["Id"]).toBe(`ob-${result.rowIds[0]}`);
    expect((await outboxStats(db)).sent).toBe(1);

    // A second flush has nothing to do: the row is not pending any more.
    const again = await flushOutbox({
      env: { BOT_DB: db },
      config: config(),
      client: wuzapi.client,
      log: quiet,
      now: () => new Date(3_000),
    });
    expect(again.claimed).toBe(0);
    expect(wuzapi.calls.filter((call) => call.url.endsWith("/chat/send/text"))).toHaveLength(1);
  });

  it("retries a transient failure with backoff and keeps the row pending", async () => {
    const wuzapi = wuzapiStub(true);
    await enqueueOutbox(db, { message: { kind: "text", body: "halo" }, chatJid: CHAT, dedupeKey: "k2", at: 1_000 });

    const result = await flushOutbox({
      env: { BOT_DB: db },
      config: config({}, { retryBaseSeconds: 15 }),
      client: wuzapi.client,
      log: quiet,
      now: () => new Date(2_000),
      random: () => 0,
    });

    expect(result).toMatchObject({ claimed: 1, sent: 0, retried: 1 });
    const stats = await outboxStats(db);
    expect(stats.pending).toBe(1);
    expect(stats.claimed).toBe(0);
  });

  it("lets a second flusher take over a lease that expired", async () => {
    const wuzapi = wuzapiStub();
    await enqueueOutbox(db, { message: { kind: "text", body: "halo" }, chatJid: CHAT, dedupeKey: "k3", at: 1_000 });

    // First pass claims the row but "dies" before sending (leaseId forced, no send).
    const claimed = await flushOutbox({
      env: { BOT_DB: db },
      config: config({ outboxLeaseSeconds: 60 }),
      client: { sendText: async () => ({ ok: false, messageId: null, status: 500, error: "died", permanent: false, attempts: 1 }) } as unknown as WuzapiClient,
      log: quiet,
      now: () => new Date(2_000),
      random: () => 0,
    });
    expect(claimed.retried).toBe(1);

    // The lease is live, so another pass must not steal the row yet.
    const tooEarly = await flushOutbox({
      env: { BOT_DB: db },
      config: config({ outboxLeaseSeconds: 60 }),
      client: wuzapi.client,
      log: quiet,
      now: () => new Date(3_000),
    });
    expect(tooEarly.claimed).toBe(0);

    // After the backoff window it is picked up again.
    const later = await flushOutbox({
      env: { BOT_DB: db },
      config: config({ outboxLeaseSeconds: 60 }),
      client: wuzapi.client,
      log: quiet,
      now: () => new Date(2_000 + 60_000),
    });
    expect(later.sent).toBe(1);
  });

  it("marks a poison row failed instead of retrying forever", async () => {
    await db
      .prepare(
        `INSERT INTO outbox (kind, chat_jid, payload, status, attempts, next_attempt_at, claimed_until, created_at, dedupe_key)
         VALUES ('text', ?, '{bukan json', 'pending', 0, 0, 0, 1, 'poison')`,
      )
      .bind(CHAT)
      .run();

    const result = await flushOutbox({
      env: { BOT_DB: db },
      config: config(),
      client: wuzapiStub().client,
      log: quiet,
      now: () => new Date(2_000),
    });
    expect(result.dropped).toBe(1);
    expect((await outboxStats(db)).failed).toBe(1);
  });

  it("sends nothing in shadow mode, and parks the row instead of piling up", async () => {
    const wuzapi = wuzapiStub();
    await enqueueOutbox(db, { message: { kind: "text", body: "halo" }, chatJid: CHAT, dedupeKey: "k-shadow", at: 1_000 });

    const result = await flushOutbox({
      env: { BOT_DB: db },
      config: { ...config(), bot: { ...config().bot, mode: "shadow" } },
      client: wuzapi.client,
      log: quiet,
      now: () => new Date(2_000),
    });

    expect(result).toMatchObject({ claimed: 1, sent: 0, suppressed: 1 });
    expect(wuzapi.calls.filter((call) => call.url.includes("/chat/send/"))).toHaveLength(0);
    const stats = await outboxStats(db);
    expect(stats.failed).toBe(1);
    expect(stats.pending).toBe(0);
  });

  it("gives up after OUTBOX_MAX_ATTEMPTS", async () => {
    const wuzapi = wuzapiStub(true);
    await enqueueOutbox(db, { message: { kind: "text", body: "halo" }, chatJid: CHAT, dedupeKey: "k4", at: 1_000 });
    await db.prepare("UPDATE outbox SET attempts = 5 WHERE dedupe_key = 'k4'").run();

    const result = await flushOutbox({
      env: { BOT_DB: db },
      config: config({ outboxMaxAttempts: 6 }),
      client: wuzapi.client,
      log: quiet,
      now: () => new Date(2_000),
    });
    expect(result.failed).toBe(1);
    expect((await outboxStats(db)).failed).toBe(1);
  });
});

describe("receipt (nota)", () => {
  const order = {
    id: 1,
    ref: "PAY-20261010-AAAAAA",
    clientRef: "cr_1",
    kodePesanan: "INV-20261010-AAAAAA",
    waChatJid: CHAT,
    customerId: 1,
    alamatKirim: "Jl. Merdeka 1",
    totalHarga: 1_400_000,
    additionalFee: 25_000,
    grandTotal: 1_425_000,
    ongkirIncluded: true,
    status: "paid" as const,
    paymentUrl: "https://pay.test/x",
    expiresAt: null,
    paidAt: AT.getTime(),
    supersededBy: null,
    createdAt: AT.toISOString(),
    updatedAt: AT.toISOString(),
  };
  const items = [
    { id: 1, orderId: 1, kode: "116964", namaProduk: "Castelli Entrata", harga: 1_400_000, qty: 1, subtotal: 1_400_000 },
  ];

  it("renders a real PDF", async () => {
    const bytes = await renderNotaPdf({ order, items, paidAt: AT, customer: { nama: "Budi" } });
    const header = String.fromCharCode(...bytes.subarray(0, 5));
    expect(header).toBe("%PDF-");
    expect(bytes.byteLength).toBeGreaterThan(500);
  });

  it("survives characters the standard fonts cannot encode", async () => {
    const nasty = { ...order, alamatKirim: "Jl. Merdeka 1 — No. 2 • RT 3/4 😀 “rumah”" };
    const bytes = await renderNotaPdf({ order: nasty, items, paidAt: AT, customer: { nama: "Budi 😀" } });
    expect(bytes.byteLength).toBeGreaterThan(500);
    expect(sanitise("a—b•c😀")).toBe("a-b-c");
  });

  it("renders the text fallback with every money field", () => {
    const text = renderNotaText({ order, items, paidAt: AT, customer: { nama: "Budi" } });
    expect(text).toContain("NOTA PEMBAYARAN");
    expect(text).toContain("INV-20261010-AAAAAA");
    expect(text).toContain("Rp 1.425.000");
    expect(text).toContain("LUNAS");
  });

  it("falls back to a text document when the PDF renderer fails", async () => {
    // An order whose fields make pdf-lib throw (undefined is not a valid input).
    const broken = { ...order, ref: undefined as unknown as string };
    const result = await buildNotaDocument({ order: broken, items, paidAt: AT }, "Nota");
    expect(result.kind).toBe("text");
    expect(result.message.kind).toBe("document");
    if (result.message.kind === "document") {
      expect(result.message.fileName.endsWith(".txt")).toBe(true);
      const decoded = atob(result.message.document);
      expect(decoded).toContain("NOTA PEMBAYARAN");
    }
  });
});

describe("parseFeeAmount", () => {
  it("accepts the shapes a human types and refuses nonsense", () => {
    expect(parseFeeAmount("25000")).toBe(25_000);
    expect(parseFeeAmount("25.000")).toBe(25_000);
    expect(parseFeeAmount("Rp 25.000")).toBe(25_000);
    expect(parseFeeAmount("0")).toBe(0);
    expect(parseFeeAmount("25 ribu")).toBeNull();
    expect(parseFeeAmount("")).toBeNull();
    expect(parseFeeAmount("-500")).toBeNull();
  });
});
