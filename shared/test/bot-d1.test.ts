/**
 * D1 repository + no_ai policy tests, against the real BOT_DB binding.
 *
 * The idempotency cases are the important ones: Cloudflare Queues is
 * at-least-once, so "the same webhook arrives twice" is the normal case, not an
 * edge case. A retry after a *failure* must be allowed through, and a retry after
 * a *success* must not be — those two behaviours are asserted explicitly.
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { claimDelivery, finishDelivery, isDeliveryDone } from "../src/bot/idempotency";
import { loadHistory, recordInbound, recordOutbound } from "../src/bot/history";
import { containsNoAi, noAiFromContact, resolveChatPolicy, upsertContact } from "../src/bot/contacts/policy";
import type { InboundMessage } from "../src/bot/types";

// The schema comes from shared/test/setup.ts, which applies the same migration
// files `pnpm run migrate` applies in production.
const db = (env as unknown as { BOT_DB: D1Database }).BOT_DB;
const CHAT = "628111@s.whatsapp.net";

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM processed_events"),
    db.prepare("DELETE FROM messages"),
    db.prepare("DELETE FROM contacts"),
    db.prepare("DELETE FROM suppressed_chats"),
    db.prepare("DELETE FROM chat_state"),
  ]);
});

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    chatJid: CHAT,
    senderJid: CHAT,
    waMessageId: "WA-1",
    pushName: "Budi",
    timestamp: 1_000,
    kind: "text",
    body: "halo",
    ...overrides,
  };
}

describe("idempotency ledger", () => {
  it("claims a delivery once, then blocks it forever once done", async () => {
    const input = { deliveryId: "d-1", chatJid: CHAT, waMessageId: "WA-1", at: 1_000 };
    expect(await claimDelivery(db, input)).toBe(true);
    // Still `processing`: re-claimable on purpose, because a consumer that died
    // mid-turn must not strand the message. The Durable Object chat lock is what
    // stops two live attempts from overlapping.
    expect(await claimDelivery(db, input)).toBe(true);
    await finishDelivery(db, "d-1", "done", 2_000);
    expect(await isDeliveryDone(db, "d-1")).toBe(true);
    expect(await claimDelivery(db, input)).toBe(false);
  });

  it("allows a retry after a failure", async () => {
    const input = { deliveryId: "d-2", chatJid: CHAT, waMessageId: "WA-2", at: 1_000 };
    expect(await claimDelivery(db, input)).toBe(true);
    await finishDelivery(db, "d-2", "failed", 1_500, "wuzapi 503");
    expect(await isDeliveryDone(db, "d-2")).toBe(false);
    expect(await claimDelivery(db, input)).toBe(true);
  });

  it("keeps a failure reason for the DLQ/reconcile path", async () => {
    await claimDelivery(db, { deliveryId: "d-3", chatJid: CHAT, waMessageId: null, at: 1 });
    await finishDelivery(db, "d-3", "failed", 2, "wuzapi 503");
    const row = await db
      .prepare("SELECT status, error FROM processed_events WHERE delivery_id = 'd-3'")
      .first<{ status: string; error: string }>();
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("wuzapi 503");
  });
});

describe("message history", () => {
  it("ignores a redelivered inbound message", async () => {
    await recordInbound(db, inbound(), "d-1", null);
    await recordInbound(db, inbound({ body: "halo lagi" }), "d-1", null);
    const count = await db.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("returns history oldest-first and respects the limit", async () => {
    await recordInbound(db, inbound({ timestamp: 1_000, body: "pertama" }), "d-1", null);
    await recordInbound(db, inbound({ timestamp: 2_000, body: "kedua" }), "d-2", null);
    await recordOutbound(db, { chatJid: CHAT, body: "balasan", kind: "text", at: 3_000 });

    const history = await loadHistory(db, CHAT, 10);
    expect(history.map((entry) => entry.body)).toEqual(["pertama", "kedua", "balasan"]);
    expect(history.map((entry) => entry.direction)).toEqual(["in", "in", "out"]);

    const limited = await loadHistory(db, CHAT, 2);
    expect(limited.map((entry) => entry.body)).toEqual(["kedua", "balasan"]);
  });

  it("keeps history isolated per chat", async () => {
    await recordInbound(db, inbound({ body: "chat A" }), "d-1", null);
    await recordInbound(db, inbound({ chatJid: "628222@s.whatsapp.net", body: "chat B" }), "d-2", null);
    const history = await loadHistory(db, CHAT, 10);
    expect(history.map((entry) => entry.body)).toEqual(["chat A"]);
  });

  it("returns nothing when the limit is zero", async () => {
    await recordInbound(db, inbound(), "d-1", null);
    expect(await loadHistory(db, CHAT, 0)).toEqual([]);
  });
});

describe("no_ai policy", () => {
  it("matches the marker case-insensitively in any name field", () => {
    expect(containsNoAi("Budi NO_AI")).toBe(true);
    expect(containsNoAi("", "no_ai-2")).toBe(true);
    expect(containsNoAi("Budi", null, undefined)).toBe(false);
  });

  it("derives has_no_ai from wuzapi's contact fields", () => {
    expect(noAiFromContact({ FullName: "Toko no_ai", FirstName: "", PushName: "x", BusinessName: "" })).toBe(true);
    expect(noAiFromContact({ FullName: "Toko", FirstName: "Budi", PushName: "budi", BusinessName: "" })).toBe(false);
  });

  it("allows an unknown chat", async () => {
    expect(await resolveChatPolicy(db, { chatJid: CHAT, pushName: "Budi" })).toEqual({ allowed: true, reason: null });
  });

  it("blocks a chat whose contact name carries no_ai, and unblocks when removed", async () => {
    await upsertContact(db, { chatJid: CHAT, contact: { FullName: "Budi no_ai" }, at: 1 });
    expect(await resolveChatPolicy(db, { chatJid: CHAT, pushName: "Budi" })).toEqual({
      allowed: false,
      reason: "no_ai_contact",
    });

    const back = await upsertContact(db, { chatJid: CHAT, contact: { FullName: "Budi" }, at: 2 });
    expect(back).toMatchObject({ hasNoAi: false, botEnabled: true, changed: true });
    expect(await resolveChatPolicy(db, { chatJid: CHAT, pushName: "Budi" })).toEqual({ allowed: true, reason: null });
  });

  it("blocks on the push name even before any contact sync", async () => {
    const policy = await resolveChatPolicy(db, { chatJid: CHAT, pushName: "Budi no_ai" });
    expect(policy).toEqual({ allowed: false, reason: "no_ai_pushname" });
  });

  it("lets a manual suppression win over everything else", async () => {
    await upsertContact(db, { chatJid: CHAT, contact: { FullName: "Budi" }, at: 1 });
    await db
      .prepare("INSERT INTO suppressed_chats (chat_jid, reason, permanent, created_at) VALUES (?, ?, 1, ?)")
      .bind(CHAT, "opt-out", 1)
      .run();
    expect(await resolveChatPolicy(db, { chatJid: CHAT, pushName: "Budi" })).toEqual({
      allowed: false,
      reason: "suppressed",
    });
    // A later sync must not silently re-enable a suppressed chat.
    const after = await upsertContact(db, { chatJid: CHAT, contact: { FullName: "Budi" }, at: 2 });
    expect(after.botEnabled).toBe(false);
  });

  it("honours the per-chat bot switch", async () => {
    await db
      .prepare("INSERT INTO chat_state (chat_jid, bot_enabled, lock_until, updated_at) VALUES (?, 0, 0, 1)")
      .bind(CHAT)
      .run();
    expect(await resolveChatPolicy(db, { chatJid: CHAT, pushName: "Budi" })).toEqual({
      allowed: false,
      reason: "bot_disabled",
    });
  });
});
