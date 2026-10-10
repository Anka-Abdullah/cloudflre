-- ---------------------------------------------------------------------------
-- 0002_payment_outbox.sql — FASE 4-7 additions to the bot database.
--
-- Everything here is additive: the schema in 0001_init.sql stays valid, so a
-- number that has already been provisioned can be migrated in place with
-- `pnpm run migrate -- --number <nomor>`.
--
-- Why each piece exists:
--
--   outbox.dedupe_key     Anti double send. The lease in 0001 (claimed_until)
--                         stops two workers from sending the same row, but it
--                         cannot stop a *second row* from being created for the
--                         same event (a redelivered payment.event, a cron pass
--                         racing an outbox.tick). A UNIQUE key computed from the
--                         business identity (order + kind + payload) makes the
--                         second INSERT a no-op.
--   outbox.lease_id       The claim token. `claimed_until` alone cannot tell a
--                         flusher which rows it owns: it is a timestamp, and two
--                         passes in the same millisecond would both think they
--                         won. A random id per pass makes "these rows are mine"
--                         exact, so a row is sent at most once per lease.
--   cron_state            Honours CONTACT_SYNC_INTERVAL_MINUTES on a minute cron.
--                         Without it every pass would re-poll wuzapi for the
--                         full contact list, once a minute, forever.
--   telegram_pending      "Ubah Biaya" asks the admin for a reply. Telegram
--                         delivers that reply as a normal message referencing
--                         the card, so the card id → order mapping has to be
--                         stored somewhere durable.
-- ---------------------------------------------------------------------------

ALTER TABLE outbox ADD COLUMN dedupe_key TEXT;
ALTER TABLE outbox ADD COLUMN lease_id TEXT;
ALTER TABLE outbox ADD COLUMN last_error TEXT;

-- NULL keys are allowed more than once (SQLite treats NULLs as distinct), which
-- keeps the column optional for outbox rows that have no natural identity.
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_dedupe ON outbox (dedupe_key);

CREATE INDEX IF NOT EXISTS idx_outbox_order ON outbox (order_ref, status);

CREATE TABLE IF NOT EXISTS cron_state (
  job         TEXT PRIMARY KEY,
  last_run_at INTEGER NOT NULL DEFAULT 0,
  note        TEXT
);

-- Admin approval cards that expect a reply (force_reply) rather than a button.
CREATE TABLE IF NOT EXISTS telegram_pending (
  chat_id    TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  order_ref  TEXT NOT NULL,
  kind       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);
