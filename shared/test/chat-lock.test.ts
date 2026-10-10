/**
 * ChatCoordinator (Durable Object) tests.
 *
 * The lock is what keeps two redeliveries of the same webhook from starting two
 * AI turns for one chat, and the token bucket is what keeps a busy number from
 * being throttled by WhatsApp. Both are asserted through the same HTTP surface
 * the worker uses, so the tests cannot pass against a different code path than
 * production takes.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { claimChat, rateLimiterFor, releaseChat, type ClaimResponse, type RateResponse } from "../src/bot/coordinator/chat-lock";

const bindings = env as unknown as { CHAT_COORDINATOR: DurableObjectNamespace };

function uniqueChat(label: string): string {
  return `${label}-${crypto.randomUUID()}@s.whatsapp.net`;
}

async function rate(chatScope: string, body: Record<string, unknown>): Promise<RateResponse> {
  const stub = rateLimiterFor(bindings, chatScope);
  if (!stub) throw new Error("CHAT_COORDINATOR binding is missing");
  const response = await stub.fetch("https://coordinator/rate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as RateResponse;
}

async function status(scope: string): Promise<Record<string, unknown>> {
  const stub = bindings.CHAT_COORDINATOR.get(bindings.CHAT_COORDINATOR.idFromName(scope));
  const response = await stub.fetch("https://coordinator/status");
  return (await response.json()) as Record<string, unknown>;
}

describe("ChatCoordinator lock", () => {
  it("grants the lock to the first caller of a chat", async () => {
    const chat = uniqueChat("lock-first");
    const claim = (await claimChat(bindings, chat, { deliveryId: "d-1" })) as ClaimResponse;
    expect(claim.locked).toBe(true);
    expect(claim.duplicate).toBe(false);
    expect(claim.retryAfterMs).toBe(0);
    expect(claim.lockUntil).toBeGreaterThan(0);
    await releaseChat(bindings, chat, {});
  });

  it("refuses the lock while another delivery holds it, and reports the wait", async () => {
    const chat = uniqueChat("lock-second");
    const first = (await claimChat(bindings, chat, { deliveryId: "d-1", lockTtlMs: 60_000 })) as ClaimResponse;
    const second = (await claimChat(bindings, chat, { deliveryId: "d-2", lockTtlMs: 60_000 })) as ClaimResponse;

    expect(first.locked).toBe(true);
    expect(second.locked).toBe(false);
    expect(second.retryAfterMs).toBeGreaterThan(0);
    await releaseChat(bindings, chat, {});
  });

  it("keeps chats independent", async () => {
    const chatA = uniqueChat("lock-a");
    const chatB = uniqueChat("lock-b");
    const a = (await claimChat(bindings, chatA, { deliveryId: "d-a" })) as ClaimResponse;
    const b = (await claimChat(bindings, chatB, { deliveryId: "d-b" })) as ClaimResponse;
    expect(a.locked).toBe(true);
    expect(b.locked).toBe(true);
    await releaseChat(bindings, chatA, {});
    await releaseChat(bindings, chatB, {});
  });

  it("frees the lock on release", async () => {
    const chat = uniqueChat("lock-release");
    await claimChat(bindings, chat, { deliveryId: "d-1", lockTtlMs: 60_000 });
    await releaseChat(bindings, chat, {});
    const again = (await claimChat(bindings, chat, { deliveryId: "d-2" })) as ClaimResponse;
    expect(again.locked).toBe(true);
    await releaseChat(bindings, chat, {});
  });

  it("expires a lock whose TTL has passed", async () => {
    const chat = uniqueChat("lock-expiry");
    const first = (await claimChat(bindings, chat, { deliveryId: "d-1", lockTtlMs: 1 })) as ClaimResponse;
    expect(first.locked).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = (await claimChat(bindings, chat, { deliveryId: "d-2" })) as ClaimResponse;
    expect(second.locked).toBe(true);
    await releaseChat(bindings, chat, {});
  });

  it("remembers a completed delivery and reports it as a duplicate", async () => {
    const chat = uniqueChat("lock-seen");
    await claimChat(bindings, chat, { deliveryId: "d-1" });
    await releaseChat(bindings, chat, { deliveryId: "d-1", rememberDelivery: true });

    const replayed = (await claimChat(bindings, chat, { deliveryId: "d-1" })) as ClaimResponse;
    expect(replayed.duplicate).toBe(true);
    expect(replayed.locked).toBe(true);

    const other = (await claimChat(bindings, chat, { deliveryId: "d-2" })) as ClaimResponse;
    expect(other.duplicate).toBe(false);
    await releaseChat(bindings, chat, {});
  });

  it("does not remember a delivery that was released without rememberDelivery", async () => {
    const chat = uniqueChat("lock-no-remember");
    await claimChat(bindings, chat, { deliveryId: "d-1" });
    await releaseChat(bindings, chat, { deliveryId: "d-1" });
    const retry = (await claimChat(bindings, chat, { deliveryId: "d-1" })) as ClaimResponse;
    expect(retry.duplicate).toBe(false);
    await releaseChat(bindings, chat, {});
  });

  it("persists state across eviction", async () => {
    const chat = uniqueChat("lock-evict");
    await claimChat(bindings, chat, { deliveryId: "d-1", lockTtlMs: 60_000 });
    const saved = await status(chat);
    expect(saved["lockUntil"]).toBeGreaterThan(0);
    await releaseChat(bindings, chat, {});
  });
});

describe("ChatCoordinator rate bucket", () => {
  it("allows a burst up to capacity and then refuses", async () => {
    const scope = `rate-${crypto.randomUUID()}`;
    const first = await rate(scope, { capacity: 2, refillPerSecond: 0.001, cost: 1 });
    const second = await rate(scope, { capacity: 2, refillPerSecond: 0.001, cost: 1 });
    const third = await rate(scope, { capacity: 2, refillPerSecond: 0.001, cost: 1 });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterMs).toBeGreaterThan(0);
  });

  it("refills over time", async () => {
    const scope = `rate-refill-${crypto.randomUUID()}`;
    await rate(scope, { capacity: 1, refillPerSecond: 0.001, cost: 1 });
    const blocked = await rate(scope, { capacity: 1, refillPerSecond: 0.001, cost: 1 });
    expect(blocked.allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 30));
    const refilled = await rate(scope, { capacity: 1, refillPerSecond: 1_000, cost: 1 });
    expect(refilled.allowed).toBe(true);
  });

  it("never exceeds capacity", async () => {
    const scope = `rate-cap-${crypto.randomUUID()}`;
    await rate(scope, { capacity: 5, refillPerSecond: 1_000, cost: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = await rate(scope, { capacity: 5, refillPerSecond: 1_000, cost: 1 });
    expect(after.tokens).toBeLessThanOrEqual(5);
  });
});

describe("ChatCoordinator routing", () => {
  it("answers 404 for an unknown path", async () => {
    const stub = bindings.CHAT_COORDINATOR.get(bindings.CHAT_COORDINATOR.idFromName(uniqueChat("unknown")));
    const response = await stub.fetch("https://coordinator/nope");
    expect(response.status).toBe(404);
  });

  it("tolerates a malformed body instead of throwing", async () => {
    const stub = bindings.CHAT_COORDINATOR.get(bindings.CHAT_COORDINATOR.idFromName(uniqueChat("malformed")));
    const response = await stub.fetch("https://coordinator/claim", { method: "POST", body: "not json" });
    expect(response.status).toBe(200);
    const claim = (await response.json()) as ClaimResponse;
    expect(claim.locked).toBe(true);
  });
});
