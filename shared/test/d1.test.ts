/**
 * Schema tests for BOT_DB.
 *
 * These run against the real D1 binding with the real migration files from
 * shared/src/bot/migrations, so the schema the bot writes to in production is
 * the schema asserted here — a migration that stops applying, or a constraint
 * that quietly disappears, fails this file.
 *
 * The FTS5 assertions exist because `KNOWLEDGE_MODE=auto` is allowed to choose
 * `r2_d1_fts`; if the runtime ever loses FTS5, that decision has to be revisited
 * rather than silently degrade at runtime.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// shared/test/setup.ts applies the real migration files before this file runs.
const db = (env as unknown as { BOT_DB: D1Database }).BOT_DB;

const EXPECTED_TABLES = [
  "cart_items",
  "carts",
  "catalog_products",
  "chat_state",
  "contacts",
  "knowledge_chunks",
  "messages",
  "outbox",
  "processed_events",
  "suppressed_chats",
];

describe("BOT_DB schema", () => {
  it("creates every table the bot depends on", async () => {
    const rows = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>();
    const names = rows.results.map((row) => row.name);
    for (const table of EXPECTED_TABLES) expect(names).toContain(table);
  });

  it("supports FTS5 with bm25 ranking and the unicode61 tokenizer", async () => {
    await db
      .prepare("CREATE VIRTUAL TABLE IF NOT EXISTS probe_fts USING fts5(content, tokenize='unicode61 remove_diacritics 2')")
      .run();
    await db.prepare("DELETE FROM probe_fts").run();
    await db
      .prepare("INSERT INTO probe_fts (content) VALUES ('kaos polos cotton combed 30s'), ('jaket hoodie fleece')")
      .run();

    const rows = await db
      .prepare("SELECT content, bm25(probe_fts) AS score FROM probe_fts WHERE probe_fts MATCH 'hoodie' ORDER BY score")
      .all<{ content: string; score: number }>();

    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.content).toContain("jaket");

    await db.prepare("DROP TABLE probe_fts").run();
  });

  it("rejects a second outbox claim of the same delivery id through messages.delivery_id", async () => {
    const first = await db
      .prepare(
        `INSERT OR IGNORE INTO messages (id, delivery_id, chat_jid, wa_message_id, direction, kind, body, created_at)
         VALUES (?, ?, ?, ?, 'in', 'text', ?, ?)`,
      )
      .bind("m1", "delivery-1", "628111@s.whatsapp.net", "wa-1", "halo", 1)
      .run();
    expect(first.meta.changes).toBe(1);

    const second = await db
      .prepare(
        `INSERT OR IGNORE INTO messages (id, delivery_id, chat_jid, wa_message_id, direction, kind, body, created_at)
         VALUES (?, ?, ?, ?, 'in', 'text', ?, ?)`,
      )
      .bind("m2", "delivery-1", "628111@s.whatsapp.net", "wa-1", "halo lagi", 2)
      .run();
    expect(second.meta.changes).toBe(0);
  });

  it("claims a processed event exactly once", async () => {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO processed_events (delivery_id, chat_jid, wa_message_id, status, processed_at)
       VALUES (?, ?, ?, 'processing', ?)`,
    );
    const first = await insert.bind("delivery-x", "chat-1", "wa-1", 1).run();
    const second = await insert.bind("delivery-x", "chat-1", "wa-1", 2).run();
    expect(first.meta.changes).toBe(1);
    expect(second.meta.changes).toBe(0);
  });

  it("isolates carts per chat and refuses a negative quantity", async () => {
    await db.prepare("INSERT INTO carts (chat_jid, status, total, updated_at) VALUES ('c1', 'active', 0, 0)").run();
    await db.prepare("INSERT INTO carts (chat_jid, status, total, updated_at) VALUES ('c2', 'active', 0, 0)").run();
    await db
      .prepare("INSERT INTO cart_items (chat_jid, kode, qty, unit_price, updated_at) VALUES ('c1', 'K1', 2, 50000, 0)")
      .run();

    const c1 = await db.prepare("SELECT qty FROM cart_items WHERE chat_jid = 'c1'").all<{ qty: number }>();
    const c2 = await db.prepare("SELECT qty FROM cart_items WHERE chat_jid = 'c2'").all<{ qty: number }>();
    expect(c1.results).toHaveLength(1);
    expect(c2.results).toHaveLength(0);

    await expect(
      db.prepare("INSERT INTO cart_items (chat_jid, kode, qty, unit_price, updated_at) VALUES ('c1', 'K2', -1, 1, 0)").run(),
    ).rejects.toThrow();
  });

  it("accepts only the documented order-agnostic outbox kinds", async () => {
    const insert = db.prepare(
      `INSERT INTO outbox (kind, chat_jid, payload, status, attempts, next_attempt_at, claimed_until, created_at)
       VALUES (?, 'c1', '{}', 'pending', 0, 0, 0, 0)`,
    );
    await expect(insert.bind("text").run()).resolves.toBeDefined();
    await expect(insert.bind("image").run()).resolves.toBeDefined();
    await expect(insert.bind("document").run()).resolves.toBeDefined();
    await expect(insert.bind("voice").run()).rejects.toThrow();
  });
});
