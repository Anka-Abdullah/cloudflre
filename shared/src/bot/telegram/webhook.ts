/**
 * `POST /webhooks/telegram` — the admin's side of the approval card.
 *
 * Security and idempotency, in this order:
 *
 *  1. **`X-Telegram-Bot-Api-Secret-Token` must match `TELEGRAM_WEBHOOK_SECRET`.**
 *     Telegram sends it on every update; without the check, anyone who guesses the
 *     URL could approve orders. An instance with no secret configured answers 401
 *     for everything (fail closed).
 *  2. **Only the configured admin chat is obeyed.** `TELEGRAM_CHAT_ID` is the
 *     single allowed author, so a leaked bot token cannot be used by a third
 *     party who happened to start the bot.
 *  3. **`update_id` is the idempotency key** (`tg:<update_id>` in
 *     `processed_events`). Telegram retries an update when it does not see 2xx,
 *     and a duplicate "Terima" must not issue a second payment link.
 *
 * What the handler does *not* do: touch the order tables directly. It calls the
 * same checkout functions the automatic path uses, and the customer-facing
 * message goes through the outbox with a `dedupe_key`, so "approved" can only ever
 * produce one link message.
 */
import type { Env, InstanceConfig } from "../../config";
import { createLogger, type Logger } from "../../lib/logger";
import { timingSafeEqualString } from "../../lib/hmac";
import { claimDelivery, finishDelivery } from "../idempotency";
import {
  approveOrder,
  createCheckoutContext,
  editApprovalCard,
  queueCustomerMessage,
  rejectOrder,
  type CheckoutDeps,
} from "../payment/checkout";
import type { SqlClient } from "../payment/sql";
import { findOrderByKode, findPaymentForOrder, listOrderItems } from "../payment/turso";
import { TelegramClient } from "./client";
import { parseCallbackData, parseFeeAmount, renderDecidedCard, renderFeePrompt } from "./cards";
import { consumePending, findPending, rememberPending } from "./pending";

export interface TelegramWebhookDeps extends CheckoutDeps {
  /** Test seam: replaces the Telegram client. */
  telegram?: TelegramClient;
  sqlClient?: SqlClient;
}

export interface TelegramWebhookOptions {
  env: Env;
  config: InstanceConfig;
  deps?: TelegramWebhookDeps;
}

interface TelegramUpdate {
  update_id?: number;
  callback_query?: {
    id?: string;
    data?: string;
    from?: { id?: number };
    message?: { message_id?: number; chat?: { id?: number } };
  };
  message?: {
    message_id?: number;
    text?: string;
    chat?: { id?: number };
    reply_to_message?: { message_id?: number };
  };
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

export async function handleTelegramWebhook(request: Request, options: TelegramWebhookOptions): Promise<Response> {
  const { env, config } = options;
  const deps = options.deps ?? {};
  const log = deps.log ?? createLogger({ slug: config.slug, handler: "telegram" });
  const now = deps.now ?? (() => new Date());

  if (request.method !== "POST") return json(405, { error: "method not allowed" });

  if (config.bot.telegramWebhookSecret === "") {
    log.error("telegram_webhook_misconfigured", { reason: "TELEGRAM_WEBHOOK_SECRET is empty" });
    return json(401, { error: "telegram webhook is not configured" });
  }
  const provided = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!(await timingSafeEqualString(provided, config.bot.telegramWebhookSecret))) {
    log.warn("telegram_webhook_unauthorized", { ip: request.headers.get("cf-connecting-ip") });
    return json(401, { error: "invalid telegram secret token" });
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return json(400, { error: "invalid json" });
  }

  const db = env.BOT_DB;
  const at = now();
  const updateId = typeof update.update_id === "number" ? update.update_id : null;
  const deliveryId = updateId === null ? `tg:${at.getTime()}` : `tg:${updateId}`;

  if (db) {
    const claimed = await claimDelivery(db, { deliveryId, chatJid: null, waMessageId: null, at: at.getTime() });
    if (!claimed) {
      log.info("telegram_update_duplicate", { updateId });
      return json(200, { ok: true, duplicate: true });
    }
  }

  const context = createCheckoutContext({
    env: { BOT_DB: env.BOT_DB },
    config,
    deps: {
      ...(deps.sqlClient ? { sqlClient: deps.sqlClient } : {}),
      ...(deps.provider ? { provider: deps.provider } : {}),
      ...(deps.wuzapi ? { wuzapi: deps.wuzapi } : {}),
      ...(deps.telegram ? { telegram: deps.telegram } : {}),
      now,
      log,
    },
  });

  const telegram = context.telegram;
  let outcome: Record<string, unknown> = { ok: true };

  try {
    if (update.callback_query) {
      outcome = await handleCallback(context, update.callback_query, log, at.getTime());
    } else if (update.message) {
      outcome = await handleMessage(context, update.message, log);
    } else {
      outcome = { ok: true, ignored: "unsupported update" };
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.error("telegram_update_failed", { updateId, error: detail });
    if (db) await finishDelivery(db, deliveryId, "failed", at.getTime(), detail);
    // 200 on purpose: Telegram retries a non-2xx update, and a poisons update
    // would retry forever. The order state is unchanged and the operator sees
    // the error in the log.
    return json(200, { ok: false, error: detail });
  }

  if (db) await finishDelivery(db, deliveryId, "done", at.getTime());
  void telegram;
  return json(200, outcome);
}

/** Only the configured admin chat may drive an approval. */
function isAdminChat(config: InstanceConfig, chatId: number | undefined): boolean {
  if (chatId === undefined) return false;
  const configured = config.bot.telegramChatId.trim();
  return configured !== "" && String(chatId) === configured;
}

async function handleCallback(
  context: ReturnType<typeof createCheckoutContext>,
  query: NonNullable<TelegramUpdate["callback_query"]>,
  log: Logger,
  at: number,
): Promise<Record<string, unknown>> {
  const { config, telegram } = context;
  const chatId = query.message?.chat?.id;

  if (!isAdminChat(config, chatId)) {
    log.warn("telegram_callback_wrong_chat", { chatId: chatId ?? null });
    return { ok: true, ignored: "chat not allowed" };
  }

  const parsed = parseCallbackData(query.data ?? "");
  if (!parsed) {
    if (telegram && query.id) await telegram.answerCallbackQuery(query.id, { text: "Tombol tidak dikenal" });
    return { ok: true, ignored: "unknown callback data" };
  }

  const order = context.sql ? await findOrderByKode(context.sql, parsed.kodePesanan) : null;
  const payment = order && context.sql ? await findPaymentForOrder(context.sql, order.id) : null;

  if (parsed.action === "fee") {
    if (telegram && query.id) await telegram.answerCallbackQuery(query.id, { text: "Balas pesan berikut dengan angka biaya" });
    if (telegram && order) {
      const sent = await telegram.sendMessage(renderFeePrompt(order), { replyMarkup: { force_reply: true, selective: true } });
      if (sent.ok && sent.messageId !== null && context.env.BOT_DB) {
        await rememberPending(context.env.BOT_DB, {
          chatId: String(chatId),
          messageId: sent.messageId,
          orderRef: order.kodePesanan,
          kind: "fee",
          at,
        });
      }
    }
    return { ok: true, action: "fee_prompt" };
  }

  if (telegram && query.id) {
    await telegram.answerCallbackQuery(query.id, {
      text: parsed.action === "approve" ? "Pesanan disetujui" : "Pesanan ditolak",
    });
  }

  if (!order || !context.sql) return { ok: true, action: parsed.action, error: "order tidak ditemukan" };
  const items = await listOrderItems(context.sql, order.id);

  if (parsed.action === "approve") {
    const performed = await approveOrder(context, { kodePesanan: order.kodePesanan, by: `telegram:${chatId}` });
    await editApprovalCard(
      context,
      payment,
      renderDecidedCard({ order: performed.order ?? order, items, decision: "approved" }),
    );
    if (performed.ok && performed.order) {
      for (const text of performed.messages) {
        await queueCustomerMessage(context, {
          orderRef: performed.order.ref,
          chatJid: performed.order.waChatJid,
          text,
          dedupeSuffix: "link",
        });
      }
    }
    log.info("telegram_approved", { order: order.kodePesanan, ok: performed.ok, error: performed.error });
    return { ok: performed.ok, action: "approve", error: performed.error };
  }

  const performed = await rejectOrder(context, { kodePesanan: order.kodePesanan, by: `telegram:${chatId}` });
  await editApprovalCard(context, payment, renderDecidedCard({ order: performed.order ?? order, items, decision: "rejected" }));
  if (performed.order) {
    for (const text of performed.messages) {
      await queueCustomerMessage(context, {
        orderRef: performed.order.ref,
        chatJid: performed.order.waChatJid,
        text,
        dedupeSuffix: "rejected",
      });
    }
  }
  log.info("telegram_rejected", { order: order.kodePesanan });
  return { ok: true, action: "reject" };
}

async function handleMessage(
  context: ReturnType<typeof createCheckoutContext>,
  message: NonNullable<TelegramUpdate["message"]>,
  log: Logger,
): Promise<Record<string, unknown>> {
  const { config, telegram } = context;
  const chatId = message.chat?.id;
  const text = (message.text ?? "").trim();

  if (!isAdminChat(config, chatId)) {
    log.warn("telegram_message_wrong_chat", { chatId: chatId ?? null });
    return { ok: true, ignored: "chat not allowed" };
  }

  // `/start` answers with the chat id: that is how the operator fills
  // TELEGRAM_CHAT_ID without guessing, and it is also the "bot is reachable" test.
  if (text.startsWith("/start")) {
    if (telegram) await telegram.sendMessage(`Bot aktif. TELEGRAM_CHAT_ID=${chatId}`);
    return { ok: true, action: "start", chatId };
  }

  const replyTo = message.reply_to_message?.message_id;
  const db = context.env.BOT_DB;
  if (replyTo === undefined || !db) return { ok: true, ignored: "not a reply" };

  const pending = await findPending(db, { chatId: String(chatId), messageId: replyTo });
  if (!pending) return { ok: true, ignored: "no pending card" };

  const fee = parseFeeAmount(text);
  if (fee === null) {
    if (telegram) await telegram.sendMessage("Angka biaya tidak terbaca. Balas lagi dengan angka rupiah, mis. 25000.", { replyToMessageId: message.message_id });
    return { ok: true, action: "fee_invalid" };
  }
  if (!(await consumePending(db, { chatId: String(chatId), messageId: replyTo }))) {
    return { ok: true, ignored: "pending already consumed" };
  }

  const order = context.sql ? await findOrderByKode(context.sql, pending.orderRef) : null;
  if (!order || !context.sql) return { ok: true, action: "fee", error: "order tidak ditemukan" };
  const items = await listOrderItems(context.sql, order.id);
  const payment = await findPaymentForOrder(context.sql, order.id);

  const performed = await approveOrder(context, {
    kodePesanan: order.kodePesanan,
    additionalFee: fee,
    reason: `biaya diubah admin menjadi ${fee}`,
    by: `telegram:${chatId}`,
  });
  await editApprovalCard(
    context,
    payment,
    renderDecidedCard({ order: performed.order ?? order, items, decision: "approved", reason: `Biaya tambahan ${fee}` }),
  );
  if (performed.ok && performed.order) {
    for (const messageText of performed.messages) {
      await queueCustomerMessage(context, {
        orderRef: performed.order.ref,
        chatJid: performed.order.waChatJid,
        text: messageText,
        dedupeSuffix: "link",
      });
    }
    if (telegram) await telegram.sendMessage(`Biaya tambahan ${fee} disimpan untuk ${order.kodePesanan}.`);
  }

  log.info("telegram_fee_updated", { order: order.kodePesanan, fee, ok: performed.ok });
  return { ok: performed.ok, action: "fee", fee, error: performed.error };
}
