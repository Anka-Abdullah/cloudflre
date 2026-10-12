-- ---------------------------------------------------------------------------
-- 0003_reply_idempotency.sql — make one delivery produce one reply, ever (WP-2B).
--
-- The problem this closes is the expensive half of at-least-once delivery.
-- `processed_events` already stops a *completed* delivery from running twice, but
-- it is written only after every bubble was sent, so the window in between was
-- unprotected:
--
--   * the worker is evicted after WuzAPI accepted a send  → the retry sent the
--     same bubble again, and the customer saw it twice;
--   * the worker is evicted after the AI answered         → the retry called the
--     model again, paying for and sending a *different* answer;
--   * part 1 of a 3-part reply fails                      → the retry re-sent
--     parts 0 and 1 as well.
--
-- Two additions fix that, and they are deliberately separate concerns:
--
--   processed_events.plan_json   freezes the *decision*: the exact messages the
--                                model produced. A retry replays them instead of
--                                asking again, so the customer can never receive
--                                a second, differently-worded answer.
--   reply_parts                  freezes the *progress*: one row per message,
--                                carrying a deterministic WhatsApp message id
--                                (`rp-<deliveryId>-<index>`, see reply-plan.ts).
--                                A retry skips the parts already sent and
--                                re-sends an interrupted one under the same id,
--                                which WhatsApp drops as a duplicate.
--
-- Both are additive: a database provisioned before this file keeps working, and
-- a rollback of the worker code simply stops reading them.
-- ---------------------------------------------------------------------------

ALTER TABLE processed_events ADD COLUMN plan_json TEXT;

CREATE TABLE IF NOT EXISTS reply_parts (
  delivery_id TEXT NOT NULL,
  part_index  INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'sent', 'failed')),
  -- Deterministic (`rp-<deliveryId[0..24]>-<index>`), never generated per
  -- attempt: it is what makes a re-send after a crash a no-op on WhatsApp.
  message_id  TEXT NOT NULL,
  sent_at     INTEGER,
  last_error  TEXT,
  PRIMARY KEY (delivery_id, part_index)
);

CREATE INDEX IF NOT EXISTS idx_reply_parts_status
  ON reply_parts (status);
