/**
 * The persisted reply plan: what the bot decided to say, and how much of it
 * already reached WhatsApp (WP-2B).
 *
 * Cloudflare Queues is at-least-once, so the consumer can be re-run after a
 * crash, an eviction or a WuzAPI outage. Without a stored plan a retry redid the
 * whole turn — it called the model a second time (different wording, paid for
 * twice) and re-sent every bubble, including the ones that had already arrived.
 *
 * The fix has two halves and both are needed:
 *
 *   * `processed_events.plan_json` freezes the **decision**, so a retry re-reads
 *     the same messages instead of consulting the model again.
 *   * `reply_parts` freezes the **progress**, one row per message and each with a
 *     deterministic WhatsApp id. A retry skips the parts already sent and
 *     re-sends an interrupted one under the *same* id, which WhatsApp discards as
 *     a duplicate rather than showing the customer a second bubble.
 *
 * Everything here is a single idempotent statement. D1 has no interactive
 * transactions in the Workers runtime, so the guarantees come from `INSERT OR
 * IGNORE`, a conditional `UPDATE`, and the composite primary key instead of from
 * application-level read-then-write.
 */
import type { OutboundMessage } from "./types";

export type ReplyPartStatus = "pending" | "sent" | "failed";

export interface ReplyPart {
  /** Index into `StoredReplyPlan.messages`. */
  index: number;
  status: ReplyPartStatus;
  /** Deterministic WhatsApp id; stable across every attempt of one delivery. */
  messageId: string;
  sentAt: number | null;
  lastError: string | null;
}

export interface StoredReplyPlan {
  messages: OutboundMessage[];
  /** One entry per message, always the same length and in index order. */
  parts: ReplyPart[];
}

/**
 * The WhatsApp message id for one part of one reply.
 *
 * Derived from the delivery id (the sha256 of the webhook body) rather than
 * generated with `crypto.randomUUID()`, because the id has to be *reproducible on
 * a later attempt* for WhatsApp to recognise a re-send as a duplicate. wuzapi
 * passes `Id` straight through to whatsmeow, which is the same mechanism the
 * outbox already relies on with `ob-<rowId>`.
 */
export function replyMessageId(deliveryId: string, index: number): string {
  return `rp-${deliveryId.slice(0, 24)}-${index}`;
}

function pendingPart(deliveryId: string, index: number): ReplyPart {
  return { index, status: "pending", messageId: replyMessageId(deliveryId, index), sentAt: null, lastError: null };
}

function pendingParts(deliveryId: string, count: number): ReplyPart[] {
  return Array.from({ length: Math.max(0, count) }, (_unused, index) => pendingPart(deliveryId, index));
}

/**
 * Creates the `pending` rows for a plan. `INSERT OR IGNORE` on the composite
 * primary key means a second attempt cannot reset progress that a first attempt
 * already recorded — that is the whole point of the table.
 */
async function ensureReplyParts(db: D1Database, deliveryId: string, count: number): Promise<void> {
  if (count <= 0) return;
  const statements = pendingParts(deliveryId, count).map((part) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO reply_parts (delivery_id, part_index, status, message_id, sent_at, last_error)
         VALUES (?, ?, 'pending', ?, NULL, NULL)`,
      )
      .bind(deliveryId, part.index, part.messageId),
  );
  await db.batch(statements);
}

/**
 * Reads the rows for a plan, healing gaps.
 *
 * A missing row means the previous attempt died between writing `plan_json` and
 * writing this part; it is reported as `pending` with the same deterministic id
 * it would have had, so the reply continues instead of stalling.
 */
async function loadReplyParts(db: D1Database, deliveryId: string, count: number): Promise<ReplyPart[]> {
  const rows = await db
    .prepare(
      `SELECT part_index, status, message_id, sent_at, last_error
         FROM reply_parts
        WHERE delivery_id = ?
        ORDER BY part_index`,
    )
    .bind(deliveryId)
    .all<{
      part_index: number;
      status: string;
      message_id: string;
      sent_at: number | null;
      last_error: string | null;
    }>();

  const stored = new Map<number, ReplyPart>();
  for (const row of rows.results) {
    stored.set(row.part_index, {
      index: row.part_index,
      status: row.status === "sent" ? "sent" : row.status === "failed" ? "failed" : "pending",
      messageId: row.message_id === "" ? replyMessageId(deliveryId, row.part_index) : row.message_id,
      sentAt: row.sent_at,
      lastError: row.last_error,
    });
  }

  return pendingParts(deliveryId, count).map((part) => stored.get(part.index) ?? part);
}

/**
 * Stores the messages the model produced, then returns the plan as it now exists
 * in the database.
 *
 * First writer wins: `WHERE plan_json IS NULL` means two attempts racing on one
 * delivery converge on a single plan, and the loser re-reads it below rather than
 * sending its own. The chat lock makes that race unlikely; this makes it
 * harmless.
 */
export async function saveReplyPlan(
  db: D1Database,
  deliveryId: string,
  chatJid: string,
  messages: readonly OutboundMessage[],
): Promise<StoredReplyPlan> {
  await db
    .prepare(
      `UPDATE processed_events
          SET plan_json = ?, chat_jid = COALESCE(chat_jid, ?)
        WHERE delivery_id = ? AND plan_json IS NULL`,
    )
    .bind(JSON.stringify(messages), chatJid, deliveryId)
    .run();

  await ensureReplyParts(db, deliveryId, messages.length);

  return (await loadReplyPlan(db, deliveryId)) ?? {
    messages: [...messages],
    parts: pendingParts(deliveryId, messages.length),
  };
}

/** The stored plan for a delivery, or null when nothing was decided yet. */
export async function loadReplyPlan(db: D1Database, deliveryId: string): Promise<StoredReplyPlan | null> {
  const row = await db
    .prepare("SELECT plan_json FROM processed_events WHERE delivery_id = ?")
    .bind(deliveryId)
    .first<{ plan_json: string | null }>();

  const raw = row?.plan_json;
  if (typeof raw !== "string" || raw === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A corrupt plan is treated as "no plan": the worst case is one extra AI
    // call, which is strictly better than dropping the customer's message.
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const messages = parsed as OutboundMessage[];
  return { messages, parts: await loadReplyParts(db, deliveryId, messages.length) };
}

/**
 * Records one part as delivered. The first success timestamp is kept, and a part
 * that was already parked as `failed` is never resurrected into `sent`, so a
 * stale attempt cannot rewrite a settled outcome.
 */
export async function markReplyPartSent(
  db: D1Database,
  deliveryId: string,
  index: number,
  at: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO reply_parts (delivery_id, part_index, status, message_id, sent_at, last_error)
       VALUES (?, ?, 'sent', ?, ?, NULL)
       ON CONFLICT (delivery_id, part_index) DO UPDATE SET
         status     = 'sent',
         sent_at    = COALESCE(reply_parts.sent_at, excluded.sent_at),
         last_error = NULL
       WHERE reply_parts.status <> 'failed'`,
    )
    .bind(deliveryId, index, replyMessageId(deliveryId, index), at)
    .run();
}

/**
 * Parks one part as permanently undeliverable (a 4xx from wuzapi).
 *
 * `WHERE reply_parts.status <> 'sent'` is the important clause: a part that
 * already reached the customer can never be downgraded, so a late failure for the
 * same index cannot make the ledger claim the message was lost.
 */
export async function markReplyPartFailed(
  db: D1Database,
  deliveryId: string,
  index: number,
  error: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO reply_parts (delivery_id, part_index, status, message_id, sent_at, last_error)
       VALUES (?, ?, 'failed', ?, NULL, ?)
       ON CONFLICT (delivery_id, part_index) DO UPDATE SET
         status     = 'failed',
         last_error = excluded.last_error
       WHERE reply_parts.status <> 'sent'`,
    )
    .bind(deliveryId, index, replyMessageId(deliveryId, index), error)
    .run();
}

export interface ReplyPartCounts {
  sent: number;
  pending: number;
  failed: number;
}

export function countReplyParts(parts: readonly ReplyPart[]): ReplyPartCounts {
  const counts: ReplyPartCounts = { sent: 0, pending: 0, failed: 0 };
  for (const part of parts) counts[part.status] += 1;
  return counts;
}
