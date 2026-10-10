-- ---------------------------------------------------------------------------
-- 0001_init.sql — bot state for one number (Cloudflare D1 database BOT_DB).
--
-- Scope: everything the bot needs to be idempotent, stateful and auditable.
-- Orders, payments and customers do NOT live here; they live in Turso (see
-- docs/wuzip-bot-architecture.txt, "Turso").
--
-- Rules that shaped this schema:
--   * Every timestamp is an integer of epoch milliseconds (UTC) unless the
--     column name ends in `_at` and the type is TEXT (ISO strings only where a
--     human reads them directly).
--   * Every amount of money is an integer in rupiah, never a float.
--   * Idempotency is enforced by UNIQUE constraints, not by application logic:
--     a redelivered queue message cannot produce a second row.
--   * D1 has no interactive transactions in the Workers runtime, so each
--     statement must be safe to run on its own (INSERT OR IGNORE / conditional
--     UPDATE ... WHERE).
-- ---------------------------------------------------------------------------

-- Conversation history, kept for KNOWLEDGE retention (90 days by default).
CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  delivery_id   TEXT UNIQUE,
  chat_jid      TEXT NOT NULL,
  wa_message_id TEXT,
  direction     TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  kind          TEXT NOT NULL CHECK (kind IN ('text', 'caption', 'button', 'list', 'audio')),
  body          TEXT NOT NULL DEFAULT '',
  raw_json      TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages (chat_jid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages (created_at);

-- Per-chat switches: bot on/off, lock lease, last activity.
CREATE TABLE IF NOT EXISTS chat_state (
  chat_jid         TEXT PRIMARY KEY,
  bot_enabled      INTEGER NOT NULL DEFAULT 1,
  lock_until       INTEGER NOT NULL DEFAULT 0,
  last_inbound_at  INTEGER,
  last_outbound_at INTEGER,
  updated_at       INTEGER NOT NULL DEFAULT 0
);

-- Delivery-level idempotency: one row per queue message the bot handled.
CREATE TABLE IF NOT EXISTS processed_events (
  delivery_id   TEXT PRIMARY KEY,
  chat_jid      TEXT,
  wa_message_id TEXT,
  status        TEXT NOT NULL CHECK (status IN ('processing', 'done', 'failed')),
  error         TEXT,
  processed_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_processed_events_chat ON processed_events (chat_jid, processed_at DESC);

-- Contact names from wuzapi /user/contacts, used for the no_ai switch.
CREATE TABLE IF NOT EXISTS contacts (
  chat_jid      TEXT PRIMARY KEY,
  full_name     TEXT,
  first_name    TEXT,
  push_name     TEXT,
  business_name TEXT,
  has_no_ai     INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_contacts_no_ai ON contacts (has_no_ai);

-- Manual/permanent opt-out, independent of the contact-name convention.
CREATE TABLE IF NOT EXISTS suppressed_chats (
  chat_jid   TEXT PRIMARY KEY,
  reason     TEXT,
  permanent  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Cart per chat. Prices are always re-read from catalog_products on write.
CREATE TABLE IF NOT EXISTS carts (
  chat_jid   TEXT PRIMARY KEY,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'converted', 'expired')),
  total      INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cart_items (
  chat_jid   TEXT NOT NULL,
  kode       TEXT NOT NULL,
  qty        INTEGER NOT NULL CHECK (qty > 0),
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_jid, kode)
);

-- Outbound queue owned by the worker: the only place a WuzAPI send is recorded,
-- so a retry can never double-send.
CREATE TABLE IF NOT EXISTS outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL CHECK (kind IN ('text', 'image', 'document')),
  order_ref       TEXT,
  chat_jid        TEXT NOT NULL,
  payload         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'sent', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  claimed_until   INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  sent_at         INTEGER
);

CREATE INDEX IF NOT EXISTS idx_outbox_ready ON outbox (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_outbox_chat ON outbox (chat_jid, created_at DESC);

-- Knowledge chunks: the searchable projection of knowledge.txt.
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source     TEXT NOT NULL,
  ordinal    INTEGER NOT NULL,
  content    TEXT NOT NULL,
  hash       TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_chunks_source_ordinal
  ON knowledge_chunks (source, ordinal);

-- Catalog projection of the Produk:/Harga:/Ongkir: blocks in knowledge.txt.
-- The AI may only ever quote prices that exist here.
CREATE TABLE IF NOT EXISTS catalog_products (
  kode            TEXT PRIMARY KEY,
  nama            TEXT NOT NULL,
  harga           INTEGER NOT NULL,
  ongkir_known    INTEGER NOT NULL DEFAULT 0,
  ongkir_included INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL DEFAULT 0
);
