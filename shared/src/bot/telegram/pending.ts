/**
 * `telegram_pending`: cards that expect a *reply* instead of a button press.
 *
 * "Ubah Biaya" cannot be a button — the admin has to type an amount. Telegram
 * delivers that answer as an ordinary message whose `reply_to_message` points at
 * the card, so the card's message id is the only handle back to the order. This
 * table is that handle, and it is deleted as soon as the answer arrives so an old
 * card cannot be answered twice.
 */
export type PendingKind = "fee";

export interface PendingRow {
  chatId: string;
  messageId: number;
  orderRef: string;
  kind: PendingKind;
  createdAt: number;
}

export async function rememberPending(
  db: D1Database,
  input: { chatId: string; messageId: number; orderRef: string; kind: PendingKind; at: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO telegram_pending (chat_id, message_id, order_ref, kind, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (chat_id, message_id) DO UPDATE SET order_ref = excluded.order_ref, kind = excluded.kind`,
    )
    .bind(input.chatId, input.messageId, input.orderRef, input.kind, input.at)
    .run();
}

export async function findPending(
  db: D1Database,
  input: { chatId: string; messageId: number },
): Promise<PendingRow | null> {
  const row = await db
    .prepare("SELECT chat_id, message_id, order_ref, kind, created_at FROM telegram_pending WHERE chat_id = ? AND message_id = ?")
    .bind(input.chatId, input.messageId)
    .first<{ chat_id: string; message_id: number; order_ref: string; kind: string; created_at: number }>();
  if (!row) return null;
  return {
    chatId: row.chat_id,
    messageId: Number(row.message_id),
    orderRef: row.order_ref,
    kind: (row.kind === "fee" ? "fee" : "fee") as PendingKind,
    createdAt: Number(row.created_at),
  };
}

/** Removes the pending row; returns true when this call consumed it. */
export async function consumePending(db: D1Database, input: { chatId: string; messageId: number }): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM telegram_pending WHERE chat_id = ? AND message_id = ?")
    .bind(input.chatId, input.messageId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Housekeeping for cards nobody answered. */
export async function prunePending(db: D1Database, before: number): Promise<number> {
  const result = await db.prepare("DELETE FROM telegram_pending WHERE created_at < ?").bind(before).run();
  return result.meta.changes ?? 0;
}
