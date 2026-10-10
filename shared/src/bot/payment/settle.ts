/**
 * Settling a payment callback: the only place an order becomes `paid`.
 *
 * The caller (the queue handler for `payment.event`, or the dry-run page) has
 * already claimed the delivery id, so this module can assume "this callback is
 * new". It still has to be safe when it is *not* — a gateway that retries its
 * webhook, a resumed queue message — because two things here are irreversible:
 * telling the customer "lunas" and attaching the receipt.
 *
 * Three guards, in order:
 *
 *  1. **The amount must match.** A callback that says "paid 1 rupiah" for a
 *     2.875.000 order must not mark it paid; it is logged and escalated instead
 *     (work plan Q9: nominal mismatch → no status change).
 *  2. **The transition is conditional.** `pending → paid` runs once; the second
 *     callback returns `applied: false` and nothing else happens.
 *  3. **The receipt is deduplicated by the outbox key** (`order:<ref>:nota`), so
 *     even a forced replay cannot send two receipts.
 */
import type { Logger } from "../../lib/logger";
import { buildNotaDocument } from "../nota/pdf";
import { enqueueOutbox } from "../outbox/store";
import type { OutboundMessage } from "../types";
import { expiredMessage, failedMessage, notaCaption, paidMessage } from "./messages";
import {
  findCustomerById,
  findOrderByKode,
  findPaymentByKodeBayar,
  listOrderItems,
  transitionOrder,
  updatePayment,
  type OrderRow,
  type PaymentRow,
} from "./turso";
import type { SqlClient } from "./sql";
import type { CallbackStatus } from "./provider";

export interface SettleInput {
  kodeBayar?: string | null;
  orderRef?: string | null;
  status: CallbackStatus;
  /** Integer rupiah as reported by the gateway; null when it did not say. */
  amount?: number | null;
  providerRef?: string | null;
  metode?: string | null;
  paidAt?: number | null;
  raw?: unknown;
  at: number;
}

export interface SettleResult {
  applied: boolean;
  reason: string;
  order: OrderRow | null;
  payment: PaymentRow | null;
  /** Messages to send right away (the direct path). */
  messages: OutboundMessage[];
  /** Documents to queue (the receipt). */
  documents: OutboundMessage[];
  error: string;
}

export interface SettleOptions {
  env: { BOT_DB?: D1Database };
  sql: SqlClient;
  log: Logger;
  /** Business name printed on the receipt, if configured. */
  businessName?: string;
}

function nothing(reason: string, error: string): SettleResult {
  return { applied: false, reason, order: null, payment: null, messages: [], documents: [], error };
}

/**
 * Applies one payment callback. Never throws: a failure is a `SettleResult` the
 * queue handler turns into an ack, a retry or an alert.
 */
export async function settlePayment(options: SettleOptions, input: SettleInput): Promise<SettleResult> {
  const { sql, log } = options;

  try {
    const payment = input.kodeBayar
      ? await findPaymentByKodeBayar(sql, input.kodeBayar)
      : null;
    const order = payment
      ? ((await findOrderByKodeById(sql, payment.orderId)) ?? (input.orderRef ? await findOrderByKode(sql, input.orderRef) : null))
      : input.orderRef
        ? await findOrderByKode(sql, input.orderRef)
        : null;

    if (!order) {
      log.error("payment_event_unknown_order", { kodeBayar: input.kodeBayar ?? null, orderRef: input.orderRef ?? null });
      return nothing("unknown_order", "order untuk callback ini tidak ditemukan");
    }

    const at = new Date(input.at);
    const paidAt = input.paidAt ?? input.at;

    switch (input.status) {
      case "paid": {
        if (order.status === "paid") {
          // Second delivery of the same success: nothing to do, and explicitly
          // NOT another receipt.
          log.info("payment_event_duplicate_paid", { order: order.kodePesanan });
          return { applied: false, reason: "already_paid", order, payment, messages: [], documents: [], error: "" };
        }

        if (input.amount !== null && input.amount !== undefined && input.amount !== order.grandTotal) {
          log.error("payment_amount_mismatch", {
            order: order.kodePesanan,
            expected: order.grandTotal,
            received: input.amount,
          });
          return {
            applied: false,
            reason: "amount_mismatch",
            order,
            payment,
            messages: [],
            documents: [],
            error: `nominal tidak cocok: diharapkan ${order.grandTotal}, diterima ${input.amount}`,
          };
        }

        const applied = await transitionOrder(sql, {
          kodePesanan: order.kodePesanan,
          from: ["pending", "approved", "awaiting_approval"],
          to: "paid",
          at,
          patch: { paidAt },
        });
        if (!applied) {
          const current = await findOrderByKode(sql, order.kodePesanan);
          log.warn("payment_event_not_applied", { order: order.kodePesanan, status: current?.status ?? "unknown" });
          return { applied: false, reason: "transition_refused", order: current ?? order, payment, messages: [], documents: [], error: "" };
        }

        if (payment) {
          await updatePayment(sql, {
            kodeBayar: payment.kodeBayar,
            at,
            patch: {
              status: "paid",
              paidAt,
              ...(input.providerRef ? { providerRef: input.providerRef } : {}),
              ...(input.metode ? { metode: input.metode } : {}),
              ...(input.raw === undefined ? {} : { rawJson: safeJson(input.raw) }),
            },
          });
        }

        const paid = (await findOrderByKode(sql, order.kodePesanan)) ?? order;
        const items = await listOrderItems(sql, paid.id);
        const customer = paid.customerId === null ? null : await findCustomerById(sql, paid.customerId);

        // Receipt: rendered here (so a render failure is caught before anything
        // is queued), then queued as a document with a dedupe key.
        const nota = await buildNotaDocument(
          { order: paid, items, customer, paidAt: new Date(paidAt), ...(options.businessName ? { businessName: options.businessName } : {}) },
          notaCaption(paid),
        );

        const queued = await queueDocument(options, {
          orderRef: paid.ref,
          chatJid: paid.waChatJid,
          document: nota.message,
          dedupeKey: `order:${paid.ref}:nota`,
          at: input.at,
        });

        log.info("payment_settled", {
          order: paid.kodePesanan,
          amount: paid.grandTotal,
          notaKind: nota.kind,
          notaBytes: nota.bytes,
          notaQueued: queued,
        });

        return {
          applied: true,
          reason: nota.kind === "pdf" ? "paid" : "paid_nota_text_fallback",
          order: paid,
          payment,
          messages: [{ kind: "text", body: paidMessage(paid) }],
          documents: [nota.message],
          error: "",
        };
      }

      case "expired": {
        const applied = await transitionOrder(sql, {
          kodePesanan: order.kodePesanan,
          from: ["pending", "awaiting_approval", "approved"],
          to: "expired",
          at,
        });
        if (payment) {
          await updatePayment(sql, { kodeBayar: payment.kodeBayar, at, patch: { status: "expired" } });
        }
        const current = (await findOrderByKode(sql, order.kodePesanan)) ?? order;
        log.info("payment_event_expired", { order: order.kodePesanan, applied });
        return {
          applied,
          reason: applied ? "expired" : "already_final",
          order: current,
          payment,
          messages: applied ? [{ kind: "text", body: expiredMessage(current) }] : [],
          documents: [],
          error: "",
        };
      }

      case "failed": {
        const applied = await transitionOrder(sql, {
          kodePesanan: order.kodePesanan,
          from: ["pending", "awaiting_approval", "approved"],
          to: "failed",
          at,
        });
        if (payment) {
          await updatePayment(sql, { kodeBayar: payment.kodeBayar, at, patch: { status: "failed" } });
        }
        const current = (await findOrderByKode(sql, order.kodePesanan)) ?? order;
        log.info("payment_event_failed", { order: order.kodePesanan, applied });
        return {
          applied,
          reason: applied ? "failed" : "already_final",
          order: current,
          payment,
          messages: applied ? [{ kind: "text", body: failedMessage(current) }] : [],
          documents: [],
          error: "",
        };
      }

      default: {
        log.warn("payment_event_unknown_status", { order: order.kodePesanan, status: input.status });
        return { applied: false, reason: "unknown_status", order, payment, messages: [], documents: [], error: "" };
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.error("payment_settle_failed", { error: detail, kodeBayar: input.kodeBayar ?? null });
    return nothing("settle_failed", detail);
  }
}

/** The receipt travels through the outbox, so a failed send is retried by cron. */
async function queueDocument(
  options: SettleOptions,
  input: { orderRef: string; chatJid: string; document: OutboundMessage; dedupeKey: string; at: number },
): Promise<boolean> {
  const db = options.env.BOT_DB;
  if (!db) return false;
  const queued = await enqueueOutbox(db, {
    message: input.document,
    chatJid: input.chatJid,
    orderRef: input.orderRef,
    dedupeKey: input.dedupeKey,
    at: input.at,
  });
  return !queued.deduped;
}

/** Small local helper: the repositories expose lookups by kode/ref/client_ref. */
async function findOrderByKodeById(sql: SqlClient, orderId: number): Promise<OrderRow | null> {
  const result = await sql.execute({ sql: "SELECT kode_pesanan FROM orders WHERE id = ?", args: [orderId] });
  const kode = result.rows[0]?.["kode_pesanan"];
  if (typeof kode !== "string" || kode === "") return null;
  return await findOrderByKode(sql, kode);
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
