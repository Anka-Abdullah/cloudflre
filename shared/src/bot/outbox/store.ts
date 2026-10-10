/**
 * The outbox: the only place a customer-bound message is allowed to wait.
 *
 * Why a table instead of "just send it": a send can fail (wuzapi down, 429,
 * WhatsApp rejecting), and the reply must not be lost — but it also must not be
 * sent twice when the queue redelivers. The outbox gives both properties with
 * two mechanisms, and they cover different failures:
 *
 *   `dedupe_key` UNIQUE   stops a *second row* for the same business event
 *                         (`order:INV-1:link`, `order:INV-1:nota`). A redelivered
 *                         payment event enqueues nothing new.
 *   lease (`lease_id`)    stops two *flushers* from sending the same row. The
 *                         claim is a conditional UPDATE, so exactly one pass owns
 *                         the row until `claimed_until` expires; if the worker
 *                         dies mid-send the lease expires and the next pass
 *                         retries — with the same WhatsApp message id, because
 *                         `flushOutbox` derives it from the row id.
 *
 * `kind` and `payload` hold an `OutboundMessage` as JSON, so the flusher and the
 * direct path (`deliverOutbound`) speak the same shape.
 */
import type { OutboundMessage } from "../types";

export type OutboxKind = "text" | "image" | "document";
export type OutboxStatus = "pending" | "claimed" | "sent" | "failed";

export interface OutboxRow {
  id: number;
  kind: OutboxKind;
  orderRef: string | null;
  chatJid: string;
  payload: string;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: number;
  claimedUntil: number;
  createdAt: number;
  sentAt: number | null;
  dedupeKey: string | null;
  leaseId: string | null;
  lastError: string | null;
}

const OUTBOX_COLUMNS = `id, kind, order_ref, chat_jid, payload, status, attempts, next_attempt_at,
   claimed_until, created_at, sent_at, dedupe_key, lease_id, last_error`;

function mapRow(row: Record<string, unknown>): OutboxRow {
  return {
    id: Number(row["id"] ?? 0),
    kind: String(row["kind"] ?? "text") as OutboxKind,
    orderRef: row["order_ref"] === null || row["order_ref"] === undefined ? null : String(row["order_ref"]),
    chatJid: String(row["chat_jid"] ?? ""),
    payload: String(row["payload"] ?? ""),
    status: String(row["status"] ?? "pending") as OutboxStatus,
    attempts: Number(row["attempts"] ?? 0),
    nextAttemptAt: Number(row["next_attempt_at"] ?? 0),
    claimedUntil: Number(row["claimed_until"] ?? 0),
    createdAt: Number(row["created_at"] ?? 0),
    sentAt: row["sent_at"] === null || row["sent_at"] === undefined ? null : Number(row["sent_at"]),
    dedupeKey: row["dedupe_key"] === null || row["dedupe_key"] === undefined ? null : String(row["dedupe_key"]),
    leaseId: row["lease_id"] === null || row["lease_id"] === undefined ? null : String(row["lease_id"]),
    lastError: row["last_error"] === null || row["last_error"] === undefined ? null : String(row["last_error"]),
  };
}

export interface EnqueueInput {
  message: OutboundMessage;
  chatJid: string;
  orderRef?: string | null;
  /** Business identity of this message; a second enqueue with it is a no-op. */
  dedupeKey?: string | null;
  at: number;
  nextAttemptAt?: number;
}

/** Enqueues one message. Returns `deduped: true` when it was already queued. */
export async function enqueueOutbox(db: D1Database, input: EnqueueInput): Promise<{ id: number | null; deduped: boolean }> {
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO outbox
         (kind, order_ref, chat_jid, payload, status, attempts, next_attempt_at, claimed_until, created_at, dedupe_key, lease_id, last_error)
       VALUES (?, ?, ?, ?, 'pending', 0, ?, 0, ?, ?, NULL, NULL)`,
    )
    .bind(
      input.message.kind,
      input.orderRef ?? null,
      input.chatJid,
      JSON.stringify(input.message),
      input.nextAttemptAt ?? input.at,
      input.at,
      input.dedupeKey ?? null,
    )
    .run();

  if ((inserted.meta.changes ?? 0) > 0) {
    return { id: Number(inserted.meta.last_row_id ?? 0) || null, deduped: false };
  }
  if (!input.dedupeKey) return { id: null, deduped: false };

  const existing = await db
    .prepare("SELECT id FROM outbox WHERE dedupe_key = ?")
    .bind(input.dedupeKey)
    .first<{ id: number }>();
  return { id: existing?.id ?? null, deduped: true };
}

export interface ClaimInput {
  now: number;
  limit: number;
  leaseMs: number;
  /** Unique per flush pass; makes "the rows I own" exact. */
  leaseId: string;
}

/**
 * Claims up to `limit` ready rows for this pass and returns them.
 *
 * Three statements, all conditional, in this order:
 *   1. pick candidate ids (pending and due, or claimed with an expired lease);
 *   2. try to claim each one — `WHERE status='pending' OR (status='claimed' AND
 *      claimed_until <= now)` is what makes a lost race a no-op;
 *   3. read back only the rows that carry this pass's lease id.
 *
 * Rows left in `claimed` with a live lease are invisible here on purpose: the
 * flusher that owns them is still working.
 */
export async function claimOutboxRows(db: D1Database, input: ClaimInput): Promise<OutboxRow[]> {
  const candidates = await db
    .prepare(
      `SELECT id FROM outbox
        WHERE (status = 'pending' AND next_attempt_at <= ?)
           OR (status = 'claimed' AND claimed_until <= ?)
        ORDER BY next_attempt_at, id
        LIMIT ?`,
    )
    .bind(input.now, input.now, input.limit)
    .all<{ id: number }>();

  const ids = candidates.results.map((row) => row.id);
  if (ids.length === 0) return [];

  await db.batch(
    ids.map((id) =>
      db
        .prepare(
          `UPDATE outbox
              SET status = 'claimed', lease_id = ?, claimed_until = ?, attempts = attempts + 1
            WHERE id = ? AND (status = 'pending' OR (status = 'claimed' AND claimed_until <= ?))`,
        )
        .bind(input.leaseId, input.now + input.leaseMs, id, input.now),
    ),
  );

  const claimed = await db
    .prepare(`SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE lease_id = ? AND status = 'claimed' ORDER BY id`)
    .bind(input.leaseId)
    .all<Record<string, unknown>>();

  return claimed.results.map(mapRow);
}

export async function markOutboxSent(
  db: D1Database,
  input: { id: number; leaseId: string; at: number },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE outbox SET status = 'sent', sent_at = ?, lease_id = NULL, claimed_until = 0, last_error = NULL
        WHERE id = ? AND lease_id = ? AND status = 'claimed'`,
    )
    .bind(input.at, input.id, input.leaseId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function markOutboxRetry(
  db: D1Database,
  input: { id: number; leaseId: string; nextAttemptAt: number; error: string },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE outbox SET status = 'pending', next_attempt_at = ?, lease_id = NULL, claimed_until = 0, last_error = ?
        WHERE id = ? AND lease_id = ? AND status = 'claimed'`,
    )
    .bind(input.nextAttemptAt, input.error.slice(0, 400), input.id, input.leaseId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function markOutboxFailed(
  db: D1Database,
  input: { id: number; leaseId: string; error: string },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE outbox SET status = 'failed', lease_id = NULL, claimed_until = 0, last_error = ?
        WHERE id = ? AND lease_id = ? AND status = 'claimed'`,
    )
    .bind(input.error.slice(0, 400), input.id, input.leaseId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Rows for one order, newest first — the audit trail behind a receipt. */
export async function listOutboxForOrder(db: D1Database, orderRef: string): Promise<OutboxRow[]> {
  const result = await db
    .prepare(`SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE order_ref = ? ORDER BY id DESC`)
    .bind(orderRef)
    .all<Record<string, unknown>>();
  return result.results.map(mapRow);
}

export interface OutboxStats {
  pending: number;
  claimed: number;
  sent: number;
  failed: number;
}

export async function outboxStats(db: D1Database): Promise<OutboxStats> {
  const rows = await db
    .prepare("SELECT status, COUNT(*) AS n FROM outbox GROUP BY status")
    .all<{ status: string; n: number }>();
  const stats: OutboxStats = { pending: 0, claimed: 0, sent: 0, failed: 0 };
  for (const row of rows.results) {
    if (row.status in stats) stats[row.status as keyof OutboxStats] = Number(row.n);
  }
  return stats;
}

/** Parses a stored payload back into an `OutboundMessage`; null when corrupt. */
export function parseOutboxMessage(row: OutboxRow): OutboundMessage | null {
  try {
    const parsed = JSON.parse(row.payload) as OutboundMessage;
    if (typeof parsed !== "object" || parsed === null) return null;
    if (parsed.kind !== "text" && parsed.kind !== "image" && parsed.kind !== "document") return null;
    return parsed;
  } catch {
    return null;
  }
}
