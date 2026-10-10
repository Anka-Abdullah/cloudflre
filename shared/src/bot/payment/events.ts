/**
 * Envelope builders for the two non-wuzapi queue kinds.
 *
 * Both were frozen in phase 0 (`envelope.ts`) and are produced here so the shape
 * lives in exactly one place:
 *
 *   `payment.event`  "the gateway (or the dry-run page, or an admin) decided
 *                    something about a payment". The Worker never mutates an
 *                    order from an HTTP request directly — it enqueues this, and
 *                    the queue consumer owns the state change. That is what makes
 *                    a webhook retry harmless: the queue is the single writer.
 *   `outbox.tick`    "flush the outbox now" (used by tests and by an operator who
 *                    does not want to wait for the cron).
 *
 * `paymentDeliveryId` implements the frozen idempotency key
 * (`<order_ref>:<status>:<provider_ref|paid_at|''>`, architecture section 6g):
 * the same business event always produces the same delivery id, so a resent
 * webhook is dropped by `processed_events` even if its JSON field order changed.
 */
import { ENVELOPE_VERSION, type EnvelopeV1 } from "../../envelope";
import type { CallbackStatus } from "./provider";

export interface PaymentEventPayload {
  kodeBayar: string | null;
  orderRef: string | null;
  status: CallbackStatus;
  amount: number | null;
  providerRef: string | null;
  metode: string | null;
  paidAt: number | null;
  /** Where the event came from: the gateway, the dry-run page, or an admin. */
  source: "gateway" | "dry-run" | "admin" | "telegram";
  raw?: unknown;
}

/** The frozen idempotency key of a payment event. */
export function paymentDeliveryId(payload: Pick<PaymentEventPayload, "orderRef" | "kodeBayar" | "status" | "providerRef" | "paidAt">): string {
  const order = payload.orderRef ?? payload.kodeBayar ?? "unknown";
  const tail = payload.providerRef ?? (payload.paidAt === null ? "" : String(payload.paidAt));
  return `${order}:${payload.status}:${tail}`;
}

export interface EnvelopeContext {
  slug: string;
  receivedAt: Date;
  /** Defaults to the frozen business key. */
  deliveryId?: string;
}

export function paymentEnvelope(payload: PaymentEventPayload, context: EnvelopeContext): EnvelopeV1 {
  return {
    v: ENVELOPE_VERSION,
    kind: "payment.event",
    receivedAt: context.receivedAt.toISOString(),
    deliveryId: context.deliveryId ?? paymentDeliveryId(payload),
    contentType: "application/json",
    hmac: { verified: false, reason: "disabled" },
    event: {
      type: "Payment",
      userID: null,
      instanceName: context.slug,
      payload,
    },
    source: {
      worker: context.slug,
      slug: context.slug,
      ua: null,
      ip: null,
      rawSize: null,
    },
  };
}

export function outboxTickEnvelope(context: EnvelopeContext & { reason?: string }): EnvelopeV1 {
  return {
    v: ENVELOPE_VERSION,
    kind: "outbox.tick",
    receivedAt: context.receivedAt.toISOString(),
    deliveryId: context.deliveryId ?? `outbox.tick:${context.receivedAt.toISOString()}`,
    contentType: "application/json",
    hmac: { verified: false, reason: "disabled" },
    event: {
      type: "OutboxTick",
      userID: null,
      instanceName: context.slug,
      payload: { reason: context.reason ?? "manual" },
    },
    source: {
      worker: context.slug,
      slug: context.slug,
      ua: null,
      ip: null,
      rawSize: null,
    },
  };
}

/** Reads a payment payload out of an envelope, tolerating a media pointer. */
export function paymentPayloadOf(envelope: EnvelopeV1): PaymentEventPayload | null {
  const payload = envelope.event.payload ?? envelope.media?.fields ?? null;
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const status = record["status"];
  if (typeof status !== "string") return null;
  const asString = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
  const asNumber = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
  return {
    kodeBayar: asString(record["kodeBayar"]),
    orderRef: asString(record["orderRef"]),
    status: status as PaymentEventPayload["status"],
    amount: asNumber(record["amount"]),
    providerRef: asString(record["providerRef"]),
    metode: asString(record["metode"]),
    paidAt: asNumber(record["paidAt"]),
    source: (asString(record["source"]) as PaymentEventPayload["source"] | null) ?? "gateway",
    raw: record["raw"],
  };
}
