/**
 * D1 access for conversation state: message history and the per-chat switches.
 * The idempotency ledger lives in `idempotency.ts`.
 *
 * Every write is a single statement that is safe to re-run, because Cloudflare
 * Queues is at-least-once: a redelivered webhook must not add a second history
 * row, a second cart, or a second reply. Where a constraint can express that
 * (`messages.delivery_id`) it does, instead of relying on a read-then-write that
 * two concurrent consumers could interleave.
 *
 * No function here throws on a missing row: absent state is normal for a chat
 * that has never been seen.
 */
import type { ChatMessage, InboundMessage, MessageKind } from "./types";

export interface ChatStateRow {
  chat_jid: string;
  bot_enabled: number;
  lock_until: number;
  last_inbound_at: number | null;
  last_outbound_at: number | null;
  updated_at: number;
}

/**
 * Stores a customer message. `delivery_id` is UNIQUE, so a queue redelivery is
 * ignored by the database rather than by a race-prone pre-check.
 */
export async function recordInbound(
  db: D1Database,
  message: InboundMessage,
  deliveryId: string,
  rawJson: string | null,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO messages
         (id, delivery_id, chat_jid, wa_message_id, direction, kind, body, raw_json, created_at)
       VALUES (?, ?, ?, ?, 'in', ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      deliveryId,
      message.chatJid,
      message.waMessageId === "" ? null : message.waMessageId,
      message.kind,
      message.body,
      rawJson,
      message.timestamp,
    )
    .run();
}

export async function recordOutbound(
  db: D1Database,
  input: { chatJid: string; body: string; kind: MessageKind; at: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO messages (id, delivery_id, chat_jid, wa_message_id, direction, kind, body, raw_json, created_at)
       VALUES (?, NULL, ?, NULL, 'out', ?, ?, NULL, ?)`,
    )
    .bind(crypto.randomUUID(), input.chatJid, input.kind, input.body, input.at)
    .run();
}

/** Oldest-first history for the prompt, excluding the message being answered. */
export async function loadHistory(db: D1Database, chatJid: string, limit: number): Promise<ChatMessage[]> {
  if (limit <= 0) return [];
  const rows = await db
    .prepare(
      `SELECT direction, kind, body, created_at
         FROM messages
        WHERE chat_jid = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`,
    )
    .bind(chatJid, limit)
    .all<{ direction: string; kind: string; body: string; created_at: number }>();

  return rows.results
    .map((row) => ({
      direction: row.direction === "out" ? ("out" as const) : ("in" as const),
      kind: row.kind as MessageKind,
      body: row.body,
      createdAt: row.created_at,
    }))
    .reverse();
}

/** Retention sweep (90 days by default, work plan Q24). */
export async function pruneHistory(db: D1Database, before: number, limit = 500): Promise<number> {
  const result = await db
    .prepare("DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE created_at < ? LIMIT ?)")
    .bind(before, limit)
    .run();
  return result.meta.changes ?? 0;
}

export async function getChatState(db: D1Database, chatJid: string): Promise<ChatStateRow | null> {
  const row = await db
    .prepare("SELECT * FROM chat_state WHERE chat_jid = ?")
    .bind(chatJid)
    .first<ChatStateRow>();
  return row ?? null;
}

/** Creates the row on first contact, then only touches the requested columns. */
export async function ensureChatState(db: D1Database, chatJid: string, at: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO chat_state (chat_jid, bot_enabled, lock_until, last_inbound_at, last_outbound_at, updated_at)
       VALUES (?, 1, 0, ?, 0, ?)
       ON CONFLICT (chat_jid) DO UPDATE SET last_inbound_at = excluded.last_inbound_at, updated_at = excluded.updated_at`,
    )
    .bind(chatJid, at, at)
    .run();
}

export async function setChatEnabled(db: D1Database, chatJid: string, enabled: boolean, at: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO chat_state (chat_jid, bot_enabled, lock_until, last_inbound_at, last_outbound_at, updated_at)
       VALUES (?, ?, 0, NULL, NULL, ?)
       ON CONFLICT (chat_jid) DO UPDATE SET bot_enabled = excluded.bot_enabled, updated_at = excluded.updated_at`,
    )
    .bind(chatJid, enabled ? 1 : 0, at)
    .run();
}

export async function touchOutbound(db: D1Database, chatJid: string, at: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO chat_state (chat_jid, bot_enabled, lock_until, last_inbound_at, last_outbound_at, updated_at)
       VALUES (?, 1, 0, NULL, ?, ?)
       ON CONFLICT (chat_jid) DO UPDATE SET last_outbound_at = excluded.last_outbound_at, updated_at = excluded.updated_at`,
    )
    .bind(chatJid, at, at)
    .run();
}
