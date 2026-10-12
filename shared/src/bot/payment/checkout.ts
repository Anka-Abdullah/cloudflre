/**
 * Checkout: cart → order → (admin approval) → payment link.
 *
 * This is the only place an order is created, and three rules are enforced here
 * rather than asked for:
 *
 *  1. **Prices come from the catalogue, never from the cart row and never from
 *     the model.** Every item is re-priced against the parsed catalogue as the
 *     order is built, so a stale cart row or a hallucinated discount cannot
 *     change what is charged.
 *  2. **The order row is written before anything else can fail.** `client_ref` is
 *     derived from the chat and the basket, so a second `create_payment_link`
 *     call — or a queue retry — resumes the same order instead of creating a
 *     second one.
 *  3. **One payment row per order.** It is created when the approval card goes
 *     out (so the card can be edited later) and reused when the link is issued,
 *     which keeps `kode_bayar` stable from the admin's screen to the customer's
 *     link. `attachPayment` is INSERT OR IGNORE on `kode_bayar`, so a resumed
 *     checkout cannot create a second one.
 *
 * The ongkir rule is the frozen one (work plan Q7): the payment link is issued
 * automatically only when *every* item is explicitly `Ongkir: termasuk`;
 * otherwise the order goes to `awaiting_approval` and waits for the Telegram card
 * or `POST /admin/orders/<kode>/approve`.
 */
import { botReadiness, type Env, type InstanceConfig } from "../../config";
import type { Logger } from "../../lib/logger";
import type { ResolvedProduct } from "../knowledge/catalog";
import type { OutboundMessage } from "../types";
import { WuzapiClient } from "../wuzapi/client";
import { flushOutbox } from "../outbox/flush";
import { enqueueOutbox } from "../outbox/store";
import { TelegramClient } from "../telegram/client";
import { approvalKeyboard, renderApprovalCard } from "../telegram/cards";
import { awaitingApprovalMessage, paymentLinkMessage, rejectedMessage } from "./messages";
import { createTursoSqlClient, tursoConfigured } from "./libsql-client";
import { createPaymentProvider, type PaymentProvider } from "./provider";
import {
  attachPayment,
  createOrder,
  ensureTursoSchemaOnce,
  findActiveOrderForChat,
  findCustomerById,
  findOrderByKode,
  findPaymentForOrder,
  listOrderItems,
  supersedeOrder,
  transitionOrder,
  updatePayment,
  upsertCustomer,
  type OrderItemInput,
  type OrderItemRow,
  type OrderRow,
  type PaymentRow,
} from "./turso";
import type { SqlClient } from "./sql";

export interface CheckoutDeps {
  /** Test seam: replaces the Turso client (a D1-backed one in tests). */
  sqlClient?: SqlClient;
  /** Test seam: replaces the payment provider. */
  provider?: PaymentProvider;
  /** Test seam: replaces the Telegram client. */
  telegram?: TelegramClient;
  /** Test seam: replaces `fetch` inside the default provider/client. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: Logger;
  /** Used to deliver a queued message immediately when the outbox allows it. */
  wuzapi?: WuzapiClient;
}

export interface CheckoutContext {
  /** CHAT_COORDINATOR is needed so an immediate flush shares the number's rate bucket. */
  env: Pick<Env, "BOT_DB" | "CHAT_COORDINATOR">;
  config: InstanceConfig;
  log: Logger;
  now: () => Date;
  sql: SqlClient | null;
  provider: PaymentProvider;
  telegram: TelegramClient | null;
  wuzapi: WuzapiClient | null;
}

export interface CheckoutOutcome {
  ok: boolean;
  /** Machine-readable label for logs and for the guidance handed to the model. */
  reason: string;
  status: OrderRow["status"] | "unavailable";
  order: OrderRow | null;
  items: OrderItemRow[];
  payment: PaymentRow | null;
  /** Customer-facing texts, in order. */
  messages: string[];
  error: string;
}

const SILENT_LOGGER: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Builds the per-call context. Everything environment-dependent is created once
 * here, so the flow below reads as the business rules only.
 */
export function createCheckoutContext(options: {
  env: Pick<Env, "BOT_DB">;
  config: InstanceConfig;
  deps?: CheckoutDeps;
}): CheckoutContext {
  const { env, config } = options;
  const deps = options.deps ?? {};
  const log = deps.log ?? SILENT_LOGGER;
  const now = deps.now ?? (() => new Date());

  let sql = deps.sqlClient ?? null;
  if (!sql && tursoConfigured({ url: config.bot.tursoDatabaseUrl, authToken: config.bot.tursoAuthToken })) {
    try {
      sql = createTursoSqlClient({ url: config.bot.tursoDatabaseUrl, authToken: config.bot.tursoAuthToken });
    } catch (error) {
      log.error("turso_client_failed", { error: String(error) });
      sql = null;
    }
  }

  const provider =
    deps.provider ??
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

  const telegram =
    deps.telegram ??
    (config.bot.telegramEnabled && config.bot.telegramBotToken !== "" && config.bot.telegramChatId !== ""
      ? new TelegramClient({
          botToken: config.bot.telegramBotToken,
          chatId: config.bot.telegramChatId,
          apiBase: config.bot.telegramApiBase,
          deps: { log },
        })
      : null);

  // The WuzAPI client is built here (not left null) so `queueCustomerMessage` can
  // flush immediately: an approved order's payment link must reach the customer
  // now, not on the next cron tick. The outbox row stays pending if the send
  // fails, so the cron is still the safety net.
  const wuzapi =
    deps.wuzapi ??
    new WuzapiClient({
      baseUrl: config.bot.wuzapiApiBase,
      token: config.bot.wuzapiToken,
      deps: { log, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) },
    });

  return { env, config, log, now, sql, provider, telegram, wuzapi };
}

/** Canonical, stable identity of "this customer's basket at this moment". */
export async function computeClientRef(input: {
  slug: string;
  chatJid: string;
  items: readonly { kode: string; qty: number }[];
  nama: string;
  alamat: string;
}): Promise<string> {
  const basket = [...input.items]
    .map((item) => `${item.kode}x${Math.trunc(item.qty)}`)
    .sort()
    .join(",");
  const material = [input.slug, input.chatJid, basket, input.nama.trim(), input.alamat.trim()].join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `cr_${hex.slice(0, 40)}`;
}

/** `PAY-20261010-A1B2C3` / `INV-20261010-A1B2C3` in WIB, not UTC. */
export function orderCodes(now: Date, random: () => number = Math.random): { ref: string; kodePesanan: string } {
  const wib = new Date(now.getTime() + 7 * 60 * 60 * 1_000);
  const ymd = wib.toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = Math.trunc(random() * 0xffffff)
    .toString(16)
    .padStart(6, "0")
    .toUpperCase();
  return { ref: `PAY-${ymd}-${suffix}`, kodePesanan: `INV-${ymd}-${suffix}` };
}

/** Re-prices the basket against the catalogue; unknown codes are refused. */
export function priceItems(
  items: readonly { kode: string; qty: number }[],
  catalog: readonly ResolvedProduct[],
): { ok: true; items: OrderItemInput[]; ongkirIncluded: boolean } | { ok: false; error: string } {
  if (items.length === 0) return { ok: false, error: "keranjang kosong" };

  const byCode = new Map(catalog.map((product) => [product.kode, product]));
  const priced: OrderItemInput[] = [];
  for (const item of items) {
    const product = byCode.get(item.kode);
    if (!product) return { ok: false, error: `produk ${item.kode} tidak ada di katalog` };
    const qty = Math.trunc(item.qty);
    if (!Number.isFinite(qty) || qty <= 0) return { ok: false, error: `jumlah ${item.kode} tidak sah` };
    priced.push({ kode: product.kode, nama: product.nama, harga: product.harga, qty });
  }

  // The frozen ongkir rule: automatic link only when every item is explicit.
  return { ok: true, items: priced, ongkirIncluded: priced.every((item) => byCode.get(item.kode)?.ongkirIncluded === true) };
}

export interface StartCheckoutInput {
  env: Pick<Env, "BOT_DB">;
  config: InstanceConfig;
  chatJid: string;
  pushName?: string;
  customer: { nama: string; alamat: string; noHp?: string | null; email?: string | null };
  /** Basket lines; any price on them is ignored and re-read from `catalog`. */
  items: readonly { kode: string; qty: number }[];
  catalog: readonly ResolvedProduct[];
  deps?: CheckoutDeps;
}

function unavailable(reason: string, error: string, status: CheckoutOutcome["status"] = "unavailable"): CheckoutOutcome {
  return { ok: false, reason, status, order: null, items: [], payment: null, messages: [], error };
}

/**
 * The main entry point, called by the `create_payment_link` tool.
 *
 * Returns a *result*, never a throw: the tool hands `messages` to the customer
 * and `error`/`reason` to the model as guidance.
 */
export async function startCheckout(input: StartCheckoutInput): Promise<CheckoutOutcome> {
  const context = createCheckoutContext({
    env: input.env,
    config: input.config,
    ...(input.deps ? { deps: input.deps } : {}),
  });
  const { config, log } = context;

  if (!context.sql) {
    log.error("checkout_unavailable", { reason: "Turso is not configured" });
    return unavailable(
      "turso_not_configured",
      "TURSO_DATABASE_URL / TURSO_AUTH_TOKEN belum diisi, jadi pesanan tidak bisa dibuat.",
    );
  }
  const sql = context.sql;

  const priced = priceItems(input.items, input.catalog);
  if (!priced.ok) return unavailable("invalid_cart", priced.error, "creating");

  const at = context.now();
  const codes = orderCodes(at);

  try {
    await ensureTursoSchemaOnce(sql);

    const customer = await upsertCustomer(sql, {
      nama: input.customer.nama,
      noHp: input.customer.noHp ?? input.chatJid.split("@")[0] ?? null,
      email: input.customer.email ?? null,
      alamat: input.customer.alamat,
      at,
    });

    const clientRef = await computeClientRef({
      slug: config.slug,
      chatJid: input.chatJid,
      items: priced.items,
      nama: input.customer.nama,
      alamat: input.customer.alamat,
    });

    // Supersede what this chat had in flight, but only for a different basket —
    // otherwise a resumed checkout would supersede its own order.
    const active = await findActiveOrderForChat(sql, input.chatJid);
    if (active && active.clientRef !== clientRef) {
      await supersedeOrder(sql, { kodePesanan: active.kodePesanan, byKode: codes.kodePesanan, at });
      log.info("order_superseded", { chatJid: input.chatJid, order: active.kodePesanan, by: codes.kodePesanan });
    }

    const created = await createOrder(sql, {
      ref: codes.ref,
      clientRef,
      kodePesanan: codes.kodePesanan,
      waChatJid: input.chatJid,
      customerId: customer.id,
      alamatKirim: input.customer.alamat,
      items: priced.items,
      ongkirIncluded: priced.ongkirIncluded,
      at,
    });

    const order = created.order;
    const items = created.items;
    log.info("order_created", {
      chatJid: input.chatJid,
      order: order.kodePesanan,
      created: created.created,
      ongkirIncluded: order.ongkirIncluded,
      grandTotal: order.grandTotal,
    });

    // Resume: an order that already has a live link answers with the same link
    // instead of creating a second payment row.
    if (order.status === "pending" && order.paymentUrl) {
      return {
        ok: true,
        reason: "payment_link_resumed",
        status: order.status,
        order,
        items,
        payment: await findPaymentForOrder(sql, order.id),
        messages: [paymentLinkMessage(order, items, { url: order.paymentUrl, expiresAt: order.expiresAt })],
        error: "",
      };
    }
    if (order.status === "paid") {
      return { ok: false, reason: "already_paid", status: order.status, order, items, payment: null, messages: [], error: "pesanan ini sudah dibayar" };
    }
    if (order.status === "rejected" || order.status === "expired" || order.status === "failed") {
      return {
        ok: false,
        reason: `order_${order.status}`,
        status: order.status,
        order,
        items,
        payment: null,
        messages: [],
        error: `pesanan ini sudah ${order.status}`,
      };
    }

    if (!order.ongkirIncluded) {
      const reached = await transitionOrder(sql, {
        kodePesanan: order.kodePesanan,
        from: ["creating"],
        to: "awaiting_approval",
        at,
      });
      const current = (await findOrderByKode(sql, order.kodePesanan)) ?? order;
      // The card is sent once: on the first transition, or on a resume where the
      // first attempt failed before Telegram answered.
      if (reached || (await findPaymentForOrder(sql, current.id))?.telegramMessageId == null) {
        await sendApprovalCard(context, current, items, input.pushName ?? "");
      }
      return {
        ok: true,
        reason: "awaiting_approval",
        status: current.status,
        order: current,
        items,
        payment: await findPaymentForOrder(sql, current.id),
        messages: [awaitingApprovalMessage(current, items)],
        error: "",
      };
    }

    await transitionOrder(sql, { kodePesanan: order.kodePesanan, from: ["creating"], to: "approved", at });
    const issued = await issuePaymentLink(context, order.kodePesanan);
    return {
      ok: issued.ok,
      reason: issued.ok ? "payment_link" : "payment_failed",
      status: issued.order?.status ?? "approved",
      order: issued.order,
      items: issued.items,
      payment: issued.payment,
      messages: issued.messages,
      error: issued.error,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.error("checkout_failed", { chatJid: input.chatJid, error: detail });
    return unavailable("checkout_failed", detail);
  }
}

/** The `kode_bayar` an order keeps for its whole life. */
export function kodeBayarFor(order: Pick<OrderRow, "ref">): string {
  return `${order.ref}-P1`;
}

/**
 * Ensures the order has its single payment row, created at approval-card time.
 * Returns the row and whether it was created by this call.
 */
export async function ensurePaymentRow(
  context: CheckoutContext,
  order: OrderRow,
): Promise<{ payment: PaymentRow | null; created: boolean }> {
  const sql = context.sql;
  if (!sql) return { payment: null, created: false };

  const existing = await findPaymentForOrder(sql, order.id);
  if (existing) return { payment: existing, created: false };

  const attached = await attachPayment(sql, {
    orderId: order.id,
    kodeBayar: kodeBayarFor(order),
    provider: context.provider.name,
    jumlah: order.grandTotal,
    status: order.status === "awaiting_approval" ? "awaiting_approval" : "creating",
    at: context.now(),
  });
  return { payment: attached.payment, created: attached.created };
}

/**
 * Sends the admin approval card and remembers its message id on the payment row,
 * so `editMessageText` can replace the buttons once the admin decides.
 */
export async function sendApprovalCard(
  context: CheckoutContext,
  order: OrderRow,
  items: readonly OrderItemRow[],
  pushName: string,
): Promise<{ sent: boolean; messageId: number | null; error: string }> {
  const { log, telegram, sql } = context;
  const row = await ensurePaymentRow(context, order);

  if (!telegram) {
    log.warn("approval_card_skipped", {
      order: order.kodePesanan,
      reason: "TELEGRAM_ENABLED=false atau token/chat belum diisi",
      hint: `setujui lewat POST /admin/orders/${order.kodePesanan}/approve`,
    });
    return { sent: false, messageId: null, error: "telegram_not_configured" };
  }

  const result = await telegram.sendMessage(renderApprovalCard({ order, items, pushName }), {
    replyMarkup: approvalKeyboard(order.kodePesanan),
    disablePreview: true,
  });
  if (!result.ok) {
    log.error("approval_card_failed", { order: order.kodePesanan, error: result.error, permanent: result.permanent });
    return { sent: false, messageId: null, error: result.error };
  }

  if (sql && row.payment && result.messageId !== null) {
    await updatePayment(sql, {
      kodeBayar: row.payment.kodeBayar,
      at: context.now(),
      patch: { telegramMessageId: result.messageId },
    });
  }
  log.info("approval_card_sent", { order: order.kodePesanan, messageId: result.messageId });
  return { sent: true, messageId: result.messageId, error: "" };
}

/** Rewrites the card in place once the admin decided; failure is only logged. */
export async function editApprovalCard(
  context: CheckoutContext,
  payment: PaymentRow | null,
  text: string,
): Promise<boolean> {
  if (!context.telegram || !payment || payment.telegramMessageId === null) return false;
  const result = await context.telegram.editMessageText(payment.telegramMessageId, text);
  if (!result.ok) {
    context.log.warn("approval_card_edit_failed", {
      kodeBayar: payment.kodeBayar,
      messageId: payment.telegramMessageId,
      error: result.error,
    });
  }
  return result.ok;
}

export interface IssuePaymentLinkResult {
  ok: boolean;
  order: OrderRow | null;
  items: OrderItemRow[];
  payment: PaymentRow | null;
  messages: string[];
  error: string;
}

/**
 * Creates the link (or returns the existing one) and moves the order to `pending`.
 *
 * Called from two places — the automatic path and the admin approval — so the
 * "already has a link" case is handled here instead of at both call sites.
 */
export async function issuePaymentLink(context: CheckoutContext, kodePesanan: string): Promise<IssuePaymentLinkResult> {
  const { sql, log, provider, config } = context;
  if (!sql) return { ok: false, order: null, items: [], payment: null, messages: [], error: "turso_not_configured" };

  const order = await findOrderByKode(sql, kodePesanan);
  if (!order) return { ok: false, order: null, items: [], payment: null, messages: [], error: "order tidak ditemukan" };
  const items = await listOrderItems(sql, order.id);
  const paymentRow = await findPaymentForOrder(sql, order.id);

  if (order.status === "pending" && order.paymentUrl) {
    return {
      ok: true,
      order,
      items,
      payment: paymentRow,
      messages: [paymentLinkMessage(order, items, { url: order.paymentUrl, expiresAt: order.expiresAt })],
      error: "",
    };
  }
  if (order.status === "paid") {
    return { ok: false, order, items, payment: paymentRow, messages: [], error: "pesanan sudah dibayar" };
  }
  if (order.status !== "approved" && order.status !== "pending") {
    return {
      ok: false,
      order,
      items,
      payment: paymentRow,
      messages: [],
      error: `pesanan berstatus ${order.status}, link tidak bisa dibuat`,
    };
  }

  const at = context.now();
  const expiresAt = at.getTime() + config.bot.paymentExpiresHours * 60 * 60 * 1_000;
  const kodeBayar = paymentRow?.kodeBayar ?? kodeBayarFor(order);
  const callbackUrl = config.bot.publicBaseUrl === "" ? "" : `${config.bot.publicBaseUrl}/payment/callback`;
  const customer = order.customerId === null ? null : await findCustomerById(sql, order.customerId);

  const link = await provider.createLink({
    kodeBayar,
    orderRef: order.ref,
    kodePesanan: order.kodePesanan,
    amount: order.grandTotal,
    description: `Pesanan ${order.kodePesanan}`,
    customer: {
      nama: customer?.nama ?? "Pelanggan",
      noHp: customer?.noHp ?? order.waChatJid.split("@")[0] ?? null,
      email: customer?.email ?? null,
    },
    expiresAt,
    callbackUrl,
  });

  if (!link.ok) {
    await transitionOrder(sql, { kodePesanan: order.kodePesanan, from: ["approved", "pending"], to: "failed", at });
    log.error("payment_link_failed", { order: order.kodePesanan, error: link.error, permanent: link.permanent });
    const failed = await findOrderByKode(sql, order.kodePesanan);
    return { ok: false, order: failed ?? order, items, payment: paymentRow, messages: [], error: link.error };
  }

  const created = await ensurePaymentRow(context, order);
  const payment = created.payment ?? paymentRow;
  if (payment) {
    await updatePayment(sql, {
      kodeBayar: payment.kodeBayar,
      at,
      patch: {
        provider: provider.name,
        providerRef: link.providerRef,
        metode: link.metode,
        url: link.url,
        jumlah: order.grandTotal,
        status: "pending",
        approvalStatus: "approved",
        rawJson: safeJson(link.raw),
        expiresAt,
      },
    });
  }

  await transitionOrder(sql, {
    kodePesanan: order.kodePesanan,
    from: ["approved", "pending"],
    to: "pending",
    at,
    patch: { paymentUrl: link.url, expiresAt },
  });

  const updated = (await findOrderByKode(sql, order.kodePesanan)) ?? order;
  log.info("payment_link_created", {
    order: updated.kodePesanan,
    kodeBayar: payment?.kodeBayar ?? kodeBayar,
    provider: provider.name,
    dryRun: provider.dryRun,
    url: link.url,
  });

  return {
    ok: true,
    order: updated,
    items,
    payment: payment ? { ...payment, url: link.url, status: "pending" } : null,
    messages: [paymentLinkMessage(updated, items, { url: link.url, expiresAt })],
    error: "",
  };
}

/** Admin decision: approved (with an optional extra fee), then the link is issued. */
export async function approveOrder(
  context: CheckoutContext,
  input: { kodePesanan: string; additionalFee?: number; reason?: string; by?: string },
): Promise<IssuePaymentLinkResult & { approved: boolean }> {
  const { sql, log } = context;
  if (!sql) {
    return { approved: false, ok: false, order: null, items: [], payment: null, messages: [], error: "turso_not_configured" };
  }

  const order = await findOrderByKode(sql, input.kodePesanan);
  if (!order) {
    return { approved: false, ok: false, order: null, items: [], payment: null, messages: [], error: "order tidak ditemukan" };
  }
  if (order.status === "rejected" || order.status === "paid" || order.status === "superseded") {
    return {
      approved: false,
      ok: false,
      order,
      items: [],
      payment: null,
      messages: [],
      error: `pesanan sudah ${order.status}`,
    };
  }

  const additionalFee = Math.max(0, Math.trunc(input.additionalFee ?? order.additionalFee));
  const at = context.now();
  // A second "Terima" (or a resume after the link was already issued) must not
  // try to move an approved order to approved again: the frozen table has no
  // self-transition, so it is skipped instead.
  if (order.status !== "approved") {
    await transitionOrder(sql, {
      kodePesanan: order.kodePesanan,
      from: ["awaiting_approval", "pending"],
      to: "approved",
      at,
      patch: { additionalFee, grandTotal: order.totalHarga + additionalFee },
    });
  } else if (additionalFee !== order.additionalFee) {
    await transitionOrder(sql, {
      kodePesanan: order.kodePesanan,
      from: ["approved"],
      to: "pending",
      at,
      patch: { additionalFee, grandTotal: order.totalHarga + additionalFee },
    });
  }

  const row = await findPaymentForOrder(sql, order.id);
  if (row) {
    await updatePayment(sql, {
      kodeBayar: row.kodeBayar,
      at,
      patch: {
        jumlah: order.totalHarga + additionalFee,
        approvalStatus: "approved",
        ...(input.reason ? { approvalReason: input.reason } : {}),
      },
    });
  }

  log.info("order_approved", { order: order.kodePesanan, additionalFee, by: input.by ?? "admin" });
  const issued = await issuePaymentLink(context, order.kodePesanan);
  return { ...issued, approved: true };
}

/** Admin decision: rejected, with a reason that is sent to the customer once. */
export async function rejectOrder(
  context: CheckoutContext,
  input: { kodePesanan: string; reason?: string; by?: string },
): Promise<{ rejected: boolean; order: OrderRow | null; payment: PaymentRow | null; messages: string[]; error: string }> {
  const { sql, log } = context;
  if (!sql) return { rejected: false, order: null, payment: null, messages: [], error: "turso_not_configured" };

  const order = await findOrderByKode(sql, input.kodePesanan);
  if (!order) return { rejected: false, order: null, payment: null, messages: [], error: "order tidak ditemukan" };

  const at = context.now();
  // The frozen transition table allows `creating|awaiting_approval → rejected`;
  // an order that was already approved has a link out, so cancelling it is a
  // different operation (mark failed) and not a rejection.
  const changed = await transitionOrder(sql, {
    kodePesanan: order.kodePesanan,
    from: ["creating", "awaiting_approval"],
    to: "rejected",
    at,
  });
  const row = await findPaymentForOrder(sql, order.id);
  if (row) {
    await updatePayment(sql, {
      kodeBayar: row.kodeBayar,
      at,
      patch: {
        status: "cancelled",
        approvalStatus: "rejected",
        ...(input.reason ? { approvalReason: input.reason } : {}),
      },
    });
  }
  const current = (await findOrderByKode(sql, order.kodePesanan)) ?? order;
  log.info("order_rejected", { order: order.kodePesanan, changed, by: input.by ?? "admin", reason: input.reason ?? "" });

  return {
    rejected: changed,
    order: current,
    payment: row,
    // Returned even when the transition was a no-op: the caller dedupes it with
    // the outbox key, so a retry still delivers the message exactly once.
    messages: current.status === "rejected" ? [rejectedMessage(current, input.reason ?? "")] : [],
    error: "",
  };
}

/**
 * Puts a customer message in the outbox and tries to flush it immediately.
 *
 * Flushing inline keeps the conversation snappy; the row stays pending if the
 * flush fails, so the cron picks it up. `dedupeKey` is what makes this safe to
 * call from a webhook Telegram may deliver twice.
 */
export async function queueCustomerMessage(
  context: Pick<CheckoutContext, "env" | "config" | "log" | "wuzapi">,
  input: { orderRef: string; chatJid: string; text: string; dedupeSuffix: string },
): Promise<{ enqueued: boolean; deduped: boolean; sent: boolean }> {
  const db = context.env.BOT_DB;
  if (!db) return { enqueued: false, deduped: false, sent: false };

  const queued = await enqueueOutbox(db, {
    message: { kind: "text", body: input.text },
    chatJid: input.chatJid,
    orderRef: input.orderRef,
    dedupeKey: `order:${input.orderRef}:${input.dedupeSuffix}`,
    at: Date.now(),
  });
  if (queued.deduped) return { enqueued: false, deduped: true, sent: false };
  if (!context.wuzapi) return { enqueued: true, deduped: false, sent: false };

  const flushed = await flushOutbox({
    env: { BOT_DB: db, CHAT_COORDINATOR: context.env.CHAT_COORDINATOR },
    config: context.config,
    client: context.wuzapi,
    log: context.log,
    limit: 5,
    // Queued confirmations are customer-facing too, so they obey the same gate as
    // everything else: mode `on` *and* a fully configured number.
    deliver: context.config.bot.mode === "on" && botReadiness(context.config, context.env).ready,
  });
  return { enqueued: true, deduped: false, sent: flushed.sent > 0 };
}

function safeJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    const text = JSON.stringify(value);
    return text.length > 100_000 ? text.slice(0, 100_000) : text;
  } catch {
    return null;
  }
}

/** Messages the tool layer can hand to `deliverOutbound` unchanged. */
export function textsToOutbound(messages: readonly string[]): OutboundMessage[] {
  return messages.filter((text) => text !== "").map((body) => ({ kind: "text", body }));
}
