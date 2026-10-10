/**
 * Turso (libSQL) schema — the order/payment database, frozen in
 * `docs/wuzip-bot-architecture.txt` section 6.
 *
 * Kept as plain strings in a module with **no imports** on purpose:
 *
 *  - the Worker applies it lazily at boot (`ensureTursoSchema`), so a fresh
 *    database needs no manual console step;
 *  - `scripts/turso-smoke.mjs` imports this exact file through Node's TypeScript
 *    support and applies it to a real SQLite database, so the DDL that is tested
 *    is the DDL that runs — not a copy that drifts.
 *
 * Rules the statements encode (they are design decisions, not style):
 *
 *  - **Money is an INTEGER of rupiah.** Never a float, never cents; the adapter
 *    converts if a legacy dashboard needs cents.
 *  - **Idempotency is a constraint, not a check.** `ref`, `client_ref`,
 *    `kode_pesanan` and `kode_bayar` are UNIQUE, so a redelivered checkout or
 *    callback cannot create a second row.
 *  - **Every status change is a conditional UPDATE.** Callbacks arrive twice as a
 *    normal case; `WHERE status IN (…)` makes the second one a no-op instead of a
 *    second transition. See `ORDER_TRANSITIONS` in `turso.ts`.
 *  - Timestamps are ISO TEXT for `created_at`/`updated_at` (a human reads them in
 *    the Turso console) and epoch-millisecond INTEGER for `expires_at`/`paid_at`
 *    (the worker compares them).
 */
export const TURSO_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS customers (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     nama       TEXT NOT NULL,
     no_hp      TEXT UNIQUE,
     email      TEXT,
     alamat     TEXT,
     catatan    TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS orders (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     ref             TEXT UNIQUE,
     client_ref      TEXT UNIQUE,
     kode_pesanan    TEXT UNIQUE,
     wa_chat_jid     TEXT,
     customer_id     INTEGER,
     alamat_kirim    TEXT,
     total_harga     INTEGER NOT NULL DEFAULT 0,
     additional_fee  INTEGER NOT NULL DEFAULT 0,
     grand_total     INTEGER NOT NULL DEFAULT 0,
     ongkir_included INTEGER NOT NULL DEFAULT 0,
     status          TEXT NOT NULL DEFAULT 'creating',
     payment_url     TEXT,
     expires_at      INTEGER,
     paid_at         INTEGER,
     superseded_by   TEXT,
     created_at      TEXT NOT NULL,
     updated_at      TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS order_items (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     order_id    INTEGER NOT NULL,
     kode        TEXT NOT NULL,
     nama_produk TEXT NOT NULL,
     harga       INTEGER NOT NULL,
     qty         INTEGER NOT NULL,
     subtotal    INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS payments (
     id                  INTEGER PRIMARY KEY AUTOINCREMENT,
     order_id            INTEGER NOT NULL,
     kode_bayar          TEXT UNIQUE,
     provider            TEXT NOT NULL,
     provider_ref        TEXT,
     metode              TEXT,
     url                 TEXT,
     jumlah              INTEGER NOT NULL DEFAULT 0,
     status              TEXT NOT NULL DEFAULT 'creating',
     telegram_message_id INTEGER,
     approval_status     TEXT,
     approval_reason     TEXT,
     raw_json            TEXT,
     expires_at          INTEGER,
     paid_at             INTEGER,
     created_at          TEXT NOT NULL,
     updated_at          TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_orders_chat ON orders (wa_chat_jid, status)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_status_expires ON orders (status, expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_client_ref ON orders (client_ref)`,
  `CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items (order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_payments_order ON payments (order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_payments_status ON payments (status)`,
  `CREATE INDEX IF NOT EXISTS idx_customers_hp ON customers (no_hp)`,
];

/** The status a fresh checkout row starts in. */
export const ORDER_STATUS_INITIAL = "creating";
