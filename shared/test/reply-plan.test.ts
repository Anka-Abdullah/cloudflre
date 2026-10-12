/**
 * WP-2B — the reply-plan ledger, tested directly against a real D1 database.
 *
 * `bot-pipeline.test.ts` covers the behaviour an operator cares about ("one
 * delivery, one reply"). This file pins the guarantees the schema itself has to
 * provide, because they are what make the pipeline correct under concurrency:
 *
 *   * the message id is a pure function of (deliveryId, index) — if it were
 *     random, a re-send after a crash would show the customer a second bubble;
 *   * a second attempt cannot overwrite the first attempt's decision or reset
 *     progress it already recorded;
 *   * a part that reached the customer can never be downgraded by a late
 *     failure, and a part parked as undeliverable can never be resurrected.
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  countReplyParts,
  loadReplyPlan,
  markReplyPartFailed,
  markReplyPartSent,
  replyMessageId,
  saveReplyPlan,
} from "../src/bot/reply-plan";
import { claimDelivery } from "../src/bot/idempotency";
import type { OutboundMessage } from "../src/bot/types";

const db = (env as unknown as { BOT_DB: D1Database }).BOT_DB;

const DELIVERY = "a".repeat(64);
const CHAT = "628111@s.whatsapp.net";
const AT = 1_700_000_000_000;

const MESSAGES: OutboundMessage[] = [
  { kind: "text", body: "satu" },
  { kind: "text", body: "dua" },
  { kind: "image", image: "AAAA", caption: "tiga", mimeType: "image/jpeg" },
];

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM processed_events"),
    db.prepare("DELETE FROM reply_parts"),
    db.prepare("DELETE FROM messages"),
  ]);
});

/** The row `claimDelivery` would have created for this delivery. */
async function seedDelivery(deliveryId = DELIVERY): Promise<void> {
  await claimDelivery(db, { deliveryId, chatJid: CHAT, waMessageId: "WA-1", at: AT });
}

describe("replyMessageId", () => {
  it("is a deterministic function of the delivery id and the part index", () => {
    expect(replyMessageId(DELIVERY, 0)).toBe(replyMessageId(DELIVERY, 0));
    expect(replyMessageId(DELIVERY, 0)).toBe(`rp-${"a".repeat(24)}-0`);
    expect(replyMessageId(DELIVERY, 1)).not.toBe(replyMessageId(DELIVERY, 0));
    expect(replyMessageId("b".repeat(64), 0)).not.toBe(replyMessageId(DELIVERY, 0));
  });

  it("stays within a sane length and has no characters WhatsApp would reject", () => {
    const id = replyMessageId(DELIVERY, 12);
    expect(id.length).toBeLessThanOrEqual(32);
    expect(id).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe("saveReplyPlan / loadReplyPlan", () => {
  it("round-trips every kind of outbound message", async () => {
    await seedDelivery();
    await saveReplyPlan(db, DELIVERY, CHAT, MESSAGES);

    const plan = await loadReplyPlan(db, DELIVERY);
    expect(plan?.messages).toEqual(MESSAGES);
    expect(plan?.parts.map((part) => part.status)).toEqual(["pending", "pending", "pending"]);
    expect(plan?.parts.map((part) => part.messageId)).toEqual([
      replyMessageId(DELIVERY, 0),
      replyMessageId(DELIVERY, 1),
      replyMessageId(DELIVERY, 2),
    ]);
    expect(plan?.parts.every((part) => part.sentAt === null && part.lastError === null)).toBe(true);
  });

  it("reports no plan for a delivery that was never decided", async () => {
    await seedDelivery();
    expect(await loadReplyPlan(db, DELIVERY)).toBeNull();
  });

  it("keeps the first decision when two attempts race on one delivery", async () => {
    await seedDelivery();
    await saveReplyPlan(db, DELIVERY, CHAT, MESSAGES);
    // A second attempt that reached the model independently (or a redelivery
    // that scheduled one) must not be able to replace the frozen plan.
    await saveReplyPlan(db, DELIVERY, CHAT, [{ kind: "text", body: "jawaban lain" }]);

    const plan = await loadReplyPlan(db, DELIVERY);
    expect(plan?.messages).toEqual(MESSAGES);
    expect(plan?.parts).toHaveLength(3);
  });

  it("does not reset progress that an earlier attempt recorded", async () => {
    await seedDelivery();
    await saveReplyPlan(db, DELIVERY, CHAT, MESSAGES);
    await markReplyPartSent(db, DELIVERY, 0, AT);

    // The retry re-saves the plan it just read back; the sent part must stay sent.
    const plan = await loadReplyPlan(db, DELIVERY);
    await saveReplyPlan(db, DELIVERY, CHAT, plan?.messages ?? []);

    const after = await loadReplyPlan(db, DELIVERY);
    expect(after?.parts.map((part) => part.status)).toEqual(["sent", "pending", "pending"]);
  });

  it("treats a corrupt plan as no plan instead of throwing", async () => {
    await seedDelivery();
    await db.prepare("UPDATE processed_events SET plan_json = ? WHERE delivery_id = ?").bind("{not json", DELIVERY).run();
    expect(await loadReplyPlan(db, DELIVERY)).toBeNull();
  });

  it("heals parts that were never written, so a crash mid-save cannot stall the reply", async () => {
    await seedDelivery();
    await saveReplyPlan(db, DELIVERY, CHAT, MESSAGES);
    // Simulates dying between writing `plan_json` and creating the part rows.
    await db.prepare("DELETE FROM reply_parts WHERE delivery_id = ?").bind(DELIVERY).run();

    const plan = await loadReplyPlan(db, DELIVERY);
    expect(plan?.parts).toHaveLength(3);
    expect(plan?.parts.map((part) => part.status)).toEqual(["pending", "pending", "pending"]);
    // The synthesised id is the same one the send path would have used.
    expect(plan?.parts[1]?.messageId).toBe(replyMessageId(DELIVERY, 1));
  });
});

describe("part status transitions", () => {
  it("records the first success timestamp and keeps it on a later mark", async () => {
    await seedDelivery();
    await saveReplyPlan(db, DELIVERY, CHAT, MESSAGES);
    await markReplyPartSent(db, DELIVERY, 0, AT);
    await markReplyPartSent(db, DELIVERY, 0, AT + 60_000);

    const part = (await loadReplyPlan(db, DELIVERY))?.parts[0];
    expect(part?.status).toBe("sent");
    expect(part?.sentAt).toBe(AT);
    expect(part?.lastError).toBeNull();
  });

  it("clears a diagnostic error when a still-pending part finally succeeds", async () => {
    await seedDelivery();
    await saveReplyPlan(db, DELIVERY, CHAT, MESSAGES);
    // A transient failure may be recorded against a part that stays `pending`
    // for observability. Such a part *is* retried, so when it finally lands the
    // stale error must not survive in the ledger.
    await db
      .prepare("UPDATE reply_parts SET last_error = ? WHERE delivery_id = ? AND part_index = 1")
      .bind("503 unavailable", DELIVERY)
      .run();

    await markReplyPartSent(db, DELIVERY, 1, AT);

    const part = (await loadReplyPlan(db, DELIVERY))?.parts[1];
    expect(part?.status).toBe("sent");
    expect(part?.lastError).toBeNull();
  });

  it("treats both terminal states as final, so a racing attempt cannot flip one", async () => {
    await seedDelivery();
    await saveReplyPlan(db, DELIVERY, CHAT, MESSAGES);
    // Two attempts of one delivery disagreeing about a part: whichever terminal
    // state was written first wins. This is safe in both directions because the
    // send loop skips `sent` and `failed` alike, so the customer is never sent a
    // second copy either way.
    await markReplyPartFailed(db, DELIVERY, 0, "400 bad payload");
    await markReplyPartSent(db, DELIVERY, 1, AT);

    await markReplyPartSent(db, DELIVERY, 0, AT + 1_000);
    await markReplyPartFailed(db, DELIVERY, 1, "late 400");

    const plan = await loadReplyPlan(db, DELIVERY);
    expect(plan?.parts[0]?.status).toBe("failed");
    expect(plan?.parts[1]?.status).toBe("sent");
  });

  it("never downgrades a delivered part to failed", async () => {
    await seedDelivery();
    await saveReplyPlan(db, DELIVERY, CHAT, MESSAGES);
    await markReplyPartSent(db, DELIVERY, 2, AT);
    await markReplyPartFailed(db, DELIVERY, 2, "late failure");

    const part = (await loadReplyPlan(db, DELIVERY))?.parts[2];
    expect(part?.status).toBe("sent");
    expect(part?.lastError).toBeNull();
  });

  it("never resurrects a part that was parked as undeliverable", async () => {
    await seedDelivery();
    await saveReplyPlan(db, DELIVERY, CHAT, MESSAGES);
    await markReplyPartFailed(db, DELIVERY, 0, "400 bad payload");
    await markReplyPartSent(db, DELIVERY, 0, AT);

    const part = (await loadReplyPlan(db, DELIVERY))?.parts[0];
    expect(part?.status).toBe("failed");
    expect(part?.lastError).toBe("400 bad payload");
    expect(part?.sentAt).toBeNull();
  });
});

describe("countReplyParts", () => {
  it("summarises the progress of a plan", async () => {
    await seedDelivery();
    await saveReplyPlan(db, DELIVERY, CHAT, MESSAGES);
    await markReplyPartSent(db, DELIVERY, 0, AT);
    await markReplyPartFailed(db, DELIVERY, 1, "nope");

    const plan = await loadReplyPlan(db, DELIVERY);
    expect(countReplyParts(plan?.parts ?? [])).toEqual({ sent: 1, pending: 1, failed: 1 });
  });
});
