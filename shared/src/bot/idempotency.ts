/**
 * The durable idempotency ledger.
 *
 * Cloudflare Queues is at-least-once, so "the same webhook arrives twice" is a
 * normal event, not an edge case. Two failure modes have to be told apart:
 *
 *   * a redelivery of a message whose reply was already sent must be dropped;
 *   * a redelivery after a crash or a WuzAPI outage must be allowed to try again.
 *
 * The only way to distinguish them is to record the outcome, which is what
 * `processed_events` does: `done` blocks a retry, while `processing` and `failed`
 * stay re-claimable. The Durable Object's seen-set (`coordinator/chat-lock.ts`)
 * is a fast path in front of this, never a replacement — it is only written after
 * the work really finished, so it can never strand a message that never ran.
 *
 * Both statements are single round-trips that are safe to run concurrently: the
 * INSERT OR IGNORE and the conditional UPDATE both decide in the database.
 */
export interface ProcessedEventInput {
  deliveryId: string;
  chatJid: string | null;
  waMessageId: string | null;
  at: number;
}

/**
 * Returns true when this delivery still has to be processed, false when it is
 * already `done`.
 */
export async function claimDelivery(db: D1Database, input: ProcessedEventInput): Promise<boolean> {
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO processed_events (delivery_id, chat_jid, wa_message_id, status, error, processed_at)
       VALUES (?, ?, ?, 'processing', NULL, ?)`,
    )
    .bind(input.deliveryId, input.chatJid, input.waMessageId, input.at)
    .run();
  if ((inserted.meta.changes ?? 0) > 0) return true;

  const reclaimed = await db
    .prepare(
      `UPDATE processed_events
          SET status = 'processing', error = NULL, processed_at = ?, chat_jid = ?, wa_message_id = ?
        WHERE delivery_id = ? AND status <> 'done'`,
    )
    .bind(input.at, input.chatJid, input.waMessageId, input.deliveryId)
    .run();
  return (reclaimed.meta.changes ?? 0) > 0;
}

/** True when this delivery id is on record as fully handled. */
export async function isDeliveryDone(db: D1Database, deliveryId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT status FROM processed_events WHERE delivery_id = ?")
    .bind(deliveryId)
    .first<{ status: string }>();
  return row?.status === "done";
}

/** Records the outcome of a claimed delivery. Only ever moves the row forward. */
export async function finishDelivery(
  db: D1Database,
  deliveryId: string,
  status: "done" | "failed",
  at: number,
  error?: string,
): Promise<void> {
  await db
    .prepare("UPDATE processed_events SET status = ?, error = ?, processed_at = ? WHERE delivery_id = ?")
    .bind(status, error ?? null, at, deliveryId)
    .run();
}

/**
 * Clears the ledger for one chat. Used by tests and by the admin tooling that
 * needs to replay a conversation after a fix.
 */
export async function forgetDeliveries(db: D1Database, chatJid: string): Promise<number> {
  const result = await db.prepare("DELETE FROM processed_events WHERE chat_jid = ?").bind(chatJid).run();
  return result.meta.changes ?? 0;
}
