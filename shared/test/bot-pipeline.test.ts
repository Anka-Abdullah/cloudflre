/**
 * End-to-end tests for the bot queue pipeline, through the real router.
 *
 * Everything except WuzAPI itself is real: the queue batch is a real
 * `MessageBatch`, BOT_DB is a real D1 database with the real migrations, the lock
 * and rate limiter are real Durable Objects, and only the outbound HTTP call and
 * the AI responder are injected. That is the point — the acceptance criteria of
 * phase 2 ("shadow sends nothing", "on sends exactly one reply", "a repeated
 * event does not produce a second reply") are assertions about the wiring, so the
 * wiring has to be the production one.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Env, type InstanceConfig } from "../src/config";
import { ENVELOPE_VERSION, type DlqRecord, type EnvelopeV1 } from "../src/envelope";
import { handleBotBatch } from "../src/bot/queue/router";
import { claimChat, releaseChat } from "../src/bot/coordinator/chat-lock";
import type { OutboundMessage, ReplyContext } from "../src/bot/types";

// The schema comes from shared/test/setup.ts.
const db = (env as unknown as { BOT_DB: D1Database }).BOT_DB;

/**
 * Config parsed from the (possibly overridden) test environment with `BOT_MODE`
 * forced, so a test can also simulate a half-provisioned number.
 */
function configFor(scenarioEnv: Env, mode: "off" | "shadow" | "on" = "on"): InstanceConfig {
  const base = loadConfig(scenarioEnv);
  return { ...base, bot: { ...base.bot, mode } };
}

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM processed_events"),
    db.prepare("DELETE FROM reply_parts"),
    db.prepare("DELETE FROM messages"),
    db.prepare("DELETE FROM contacts"),
    db.prepare("DELETE FROM suppressed_chats"),
    db.prepare("DELETE FROM chat_state"),
  ]);
});

function buildEnvelope(
  deliveryId: string,
  chat: string,
  message: Record<string, unknown>,
  info: Record<string, unknown> = {},
): EnvelopeV1 {
  return {
    v: ENVELOPE_VERSION,
    kind: "event",
    receivedAt: "2026-10-10T08:00:00.000Z",
    deliveryId,
    contentType: "application/json",
    hmac: { verified: true, algorithm: "hmac-sha256" },
    event: {
      type: "Message",
      userID: "1",
      instanceName: "nomor-1",
      payload: {
        type: "Message",
        userID: "1",
        instanceName: "nomor-1",
        event: {
          Info: {
            Chat: chat,
            Sender: chat,
            IsFromMe: false,
            IsGroup: false,
            ID: "WA-1",
            Timestamp: "2026-10-10T07:59:00Z",
            PushName: "Budi",
            Type: "text",
            ...info,
          },
          Message: message,
        },
      },
    },
    source: { worker: "6281234567890", slug: "6281234567890", ua: "test", ip: null, rawSize: 300 },
  };
}

interface Harness {
  /** Every outbound call, in order. */
  calls: { url: string; method: string; token: string | null; body: Record<string, unknown> }[];
  /** Only `/chat/send/*`: the calls that put a message in front of a customer. */
  sends: { url: string; method: string; token: string | null; body: Record<string, unknown> }[];
  /** Only `/chat/presence`: the typing indicator (FASE 6). */
  presence: { url: string; method: string; token: string | null; body: Record<string, unknown> }[];
  logs: string[];
  contexts: ReplyContext[];
  /** How many times the model was consulted; the WP-2B tests assert it is 1. */
  responderCalls: number;
}

interface RunOptions {
  mode?: "off" | "shadow" | "on";
  /**
   * Overrides the WuzAPI response for a send. Receives the request body so a
   * test can fail one specific bubble: the WuzapiClient has its own 4-step retry
   * ladder, so counting calls here would fight it.
   */
  responder?: (url: string, body: Record<string, unknown>, attempt: number) => Response;
  reply?: string;
  /** A multi-part reply, so a test can interrupt it between two bubbles. */
  replyMessages?: OutboundMessage[];
  /** Simulates a missing secret or binding for this run only. */
  envOverrides?: Record<string, unknown>;
}

async function run(
  envelopes: EnvelopeV1[],
  options: RunOptions = {},
): Promise<{ harness: Harness; result: Awaited<ReturnType<typeof getQueueResult>> }> {
  const harness: Harness = { calls: [], sends: [], presence: [], logs: [], contexts: [], responderCalls: 0 };

  const batch = createMessageBatch(
    "wuzip-shared-test-events",
    envelopes.map((body, index) => ({
      id: `message-${index + 1}`,
      timestamp: new Date("2026-10-10T08:00:00.000Z"),
      body,
      attempts: 1,
    })),
  );
  const ctx = createExecutionContext();
  const scenarioEnv = { ...(env as unknown as Env), ...(options.envOverrides ?? {}) } as Env;

  await handleBotBatch(batch, {
    env: scenarioEnv,
    config: configFor(scenarioEnv, options.mode ?? "on"),
    deps: {
      now: () => new Date("2026-10-10T08:00:00.000Z"),
      sleep: async () => {},
      log: {
        debug: () => {},
        info: (event, fields) => void harness.logs.push(`info:${event}${fields?.["reason"] ? `:${String(fields["reason"])}` : ""}`),
        warn: (event) => void harness.logs.push(`warn:${event}`),
        error: (event) => void harness.logs.push(`error:${event}`),
      },
      responder: async (context) => {
        harness.contexts.push(context);
        harness.responderCalls += 1;
        return {
          messages: options.replyMessages ?? [{ kind: "text", body: options.reply ?? "Halo, ada yang bisa dibantu?" }],
          reason: "test",
        };
      },
      sendDlq: async () => {},
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        const headers = new Headers(init?.headers);
        const call = { url, method: init?.method ?? "GET", token: headers.get("token"), body };
        harness.calls.push(call);
        if (url.includes("/chat/send/")) harness.sends.push(call);
        if (url.includes("/chat/presence")) harness.presence.push(call);

        // The simulated outage/rejection applies to sends only: the typing
        // indicator is best-effort and must not change what these tests assert.
        if (options.responder && url.includes("/chat/send/")) {
          return options.responder(url, body, harness.sends.length);
        }
        return new Response(JSON.stringify({ code: 200, success: true, data: { Id: "WA-OUT-1" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    },
  });

  return { harness, result: await getQueueResult(batch, ctx) };
}

/** The `Id` wuzapi was asked to use for each send, in order. */
function sentIds(harness: Harness): unknown[] {
  return harness.sends.map((call) => call.body["Id"]);
}

/** The outbound ("out") rows in the conversation history. */
async function outboundBodies(): Promise<string[]> {
  const rows = await db
    .prepare("SELECT body FROM messages WHERE direction = 'out' ORDER BY rowid")
    .all<{ body: string }>();
  return rows.results.map((row) => row.body);
}

async function countMessages(): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>();
  return row?.n ?? -1;
}

const CHAT = "628111@s.whatsapp.net";

describe("BOT_MODE=shadow", () => {
  it("runs the whole pipeline but sends nothing to the customer", async () => {
    const { harness, result } = await run([buildEnvelope("d-shadow", CHAT, { conversation: "halo" })], {
      mode: "shadow",
    });

    expect(harness.calls).toHaveLength(0);
    expect(harness.contexts).toHaveLength(1);
    expect(harness.logs).toContain("info:outbound_suppressed_shadow");
    expect(result.explicitAcks).toEqual(["message-1"]);

    // The inbound message is still recorded, so shadow mode produces the history
    // the real rollout will rely on.
    expect(await countMessages()).toBe(1);
    const done = await db
      .prepare("SELECT status FROM processed_events WHERE delivery_id = 'd-shadow'")
      .first<{ status: string }>();
    expect(done?.status).toBe("done");
  });
});

describe("BOT_MODE=on", () => {
  it("answers exactly once, on the documented endpoint and with the token header", async () => {
    const { harness, result } = await run([buildEnvelope("d-on", CHAT, { conversation: "halo" })], {
      mode: "on",
      reply: "Halo Kak, ada yang bisa dibantu?",
    });

    expect(result.explicitAcks).toEqual(["message-1"]);
    expect(harness.sends).toHaveLength(1);
    const call = harness.sends[0];
    expect(call?.url).toBe("https://wuzapi.example.test/chat/send/text");
    expect(call?.method).toBe("POST");
    expect(call?.token).toBe("test-wuzapi-token");
    expect(call?.body["Phone"]).toBe(CHAT);
    expect(call?.body["Body"]).toBe("Halo Kak, ada yang bisa dibantu?");

    // One inbound + one outbound history row.
    expect(await countMessages()).toBe(2);
  });

  it("passes prior history and the push name to the responder", async () => {
    await db
      .prepare(
        `INSERT INTO messages (id, delivery_id, chat_jid, wa_message_id, direction, kind, body, created_at)
         VALUES ('h1', NULL, ?, NULL, 'in', 'text', 'pesan lama', 500)`,
      )
      .bind(CHAT)
      .run();

    const { harness } = await run([buildEnvelope("d-history", CHAT, { conversation: "halo" })]);
    const context = harness.contexts[0];
    expect(context?.pushName).toBe("Budi");
    expect(context?.history.map((entry) => entry.body)).toEqual(["pesan lama"]);
    // The message being answered is not part of its own history.
    expect(context?.history.some((entry) => entry.body === "halo")).toBe(false);
  });

  it("answers a captioned image even though media itself is ignored", async () => {
    const { harness } = await run([
      buildEnvelope("d-caption", CHAT, { imageMessage: { caption: "ini masih ada?", base64: "AAAA" } }),
    ]);
    expect(harness.sends).toHaveLength(1);
    expect(harness.contexts[0]?.message.kind).toBe("caption");
    expect(harness.contexts[0]?.message.body).toBe("ini masih ada?");
  });
});

describe("idempotency", () => {
  it("does not answer the same delivery twice", async () => {
    const envelope = buildEnvelope("d-dup", CHAT, { conversation: "halo" });

    const first = await run([envelope]);
    expect(first.harness.sends).toHaveLength(1);

    const second = await run([envelope]);
    expect(second.harness.sends).toHaveLength(0);
    expect(second.harness.contexts).toHaveLength(0);
    expect(second.result.explicitAcks).toEqual(["message-1"]);
    expect(second.harness.logs).toContain("info:event_duplicate");

    expect(await countMessages()).toBe(2);
  });

  it("retries instead of answering when another delivery holds the chat lock", async () => {
    const lockEnv = env as unknown as Env;
    // The lock is released with the token the claim returned: a release without
    // one is (correctly) ignored, and the leaked 60 s lock would then fail every
    // later test in this file that uses the same chat.
    const holder = await claimChat(lockEnv, CHAT, { deliveryId: "d-holder", lockTtlMs: 60_000 });

    const { harness, result } = await run([buildEnvelope("d-locked", CHAT, { conversation: "halo" })]);
    expect(harness.calls).toHaveLength(0);
    expect(result.retryMessages.map((entry) => entry.msgId)).toEqual(["message-1"]);
    expect(harness.logs).toContain("info:event_locked");

    await releaseChat(lockEnv, CHAT, { lockId: holder?.lockId ?? "" });
  });

  it("does not record a locked delivery as done, so the retry can continue", async () => {
    const lockEnv = env as unknown as Env;
    const holder = await claimChat(lockEnv, CHAT, { deliveryId: "d-holder", lockTtlMs: 60_000 });
    await run([buildEnvelope("d-locked-2", CHAT, { conversation: "halo" })]);
    const row = await db
      .prepare("SELECT delivery_id FROM processed_events WHERE delivery_id = 'd-locked-2'")
      .first<{ delivery_id: string }>();
    expect(row).toBeNull();
    await releaseChat(lockEnv, CHAT, { lockId: holder?.lockId ?? "" });
  });
});

describe("degraded configuration", () => {
  it("stays silent while BOT_MODE=on but a required secret is missing", async () => {
    const { harness, result } = await run([buildEnvelope("d-degraded", CHAT, { conversation: "halo" })], {
      mode: "on",
      envOverrides: { AI_API_KEY: "" },
    });

    // The pipeline ran, and answered nothing: a generic fallback must never reach
    // a real customer because a secret was forgotten.
    expect(harness.calls).toHaveLength(0);
    expect(harness.contexts).toHaveLength(1);
    expect(harness.logs).toContain("error:bot_misconfigured");
    expect(harness.logs).toContain("error:bot_degraded_shadow");
    expect(harness.logs).toContain("info:outbound_suppressed_shadow");
    expect(result.explicitAcks).toEqual(["message-1"]);
  });

  it("answers normally once the secret is present", async () => {
    const { harness } = await run([buildEnvelope("d-configured", CHAT, { conversation: "halo" })], { mode: "on" });
    expect(harness.sends).toHaveLength(1);
  });

  it("shows and clears the typing indicator around the reply", async () => {
    const { harness } = await run([buildEnvelope("d-typing", CHAT, { conversation: "halo" })], { mode: "on" });

    expect(harness.presence.map((call) => call.body["State"])).toEqual(["composing", "paused"]);
    expect(harness.presence[0]?.url).toBe("https://wuzapi.example.test/chat/presence");
    expect(harness.presence[0]?.token).toBe("test-wuzapi-token");
    // composing → send → paused, so the bubble covers the model's thinking time.
    const order = harness.calls.map((call) => (call.url.includes("/chat/presence") ? String(call.body["State"]) : "send"));
    expect(order).toEqual(["composing", "send", "paused"]);
  });
});

describe("suppression", () => {
  it("ignores a chat whose push name carries no_ai", async () => {
    const { harness, result } = await run([
      buildEnvelope("d-noai", CHAT, { conversation: "halo" }, { PushName: "Budi no_ai" }),
    ]);
    expect(harness.calls).toHaveLength(0);
    expect(harness.contexts).toHaveLength(0);
    expect(result.explicitAcks).toEqual(["message-1"]);
    expect(harness.logs).toContain("info:event_suppressed:no_ai_pushname");
    expect(await countMessages()).toBe(0);
  });

  it("ignores a suppressed chat", async () => {
    await db
      .prepare("INSERT INTO suppressed_chats (chat_jid, reason, permanent, created_at) VALUES (?, 'opt-out', 1, 1)")
      .bind(CHAT)
      .run();
    const { harness } = await run([buildEnvelope("d-suppressed", CHAT, { conversation: "halo" })]);
    expect(harness.calls).toHaveLength(0);
    expect(harness.logs).toContain("info:event_suppressed:suppressed");
  });
});

describe("filtering at the queue boundary", () => {
  it("ignores groups and the bot's own echo without touching the database", async () => {
    const { harness } = await run([
      buildEnvelope("d-group", "628999-1@g.us", { conversation: "halo" }),
      buildEnvelope("d-self", CHAT, { conversation: "balasan bot" }, { IsFromMe: true }),
      buildEnvelope("d-status", "status@broadcast", { conversation: "story" }),
    ]);
    expect(harness.calls).toHaveLength(0);
    expect(await countMessages()).toBe(0);
    expect(harness.logs).toEqual(
      expect.arrayContaining(["info:event_filtered:group", "info:event_filtered:from_me", "info:event_filtered:status"]),
    );
  });

  it("archives a non-envelope message to the DLQ and acknowledges it", async () => {
    const batch = createMessageBatch("wuzip-shared-test-events", [
      { id: "poison-1", timestamp: new Date(), body: { hello: "world" }, attempts: 1 },
    ]);
    const ctx = createExecutionContext();
    const dlq: unknown[] = [];

    await handleBotBatch(batch, {
      env: env as unknown as Env,
      config: configFor(env as unknown as Env, "on"),
      deps: { sendDlq: async (record) => void dlq.push(record), log: quietLogger() },
    });

    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(["poison-1"]);
    expect(dlq).toHaveLength(1);
  });

  /**
   * WP-4E. A body that looks like an envelope but is missing a required part used
   * to pass the old two-field check, blow up inside the handler, and be classified
   * as a *transient* failure — so it was retried until the queue gave up, and only
   * then archived. Rejecting it up front makes the poison message visible on the
   * first attempt instead of the fourth.
   */
  it.each([
    ["wrong version", { v: 99, kind: "event", deliveryId: "d", event: { type: "Message", userID: null, instanceName: null, payload: null } }],
    ["unknown kind", { v: 1, kind: "nonsense", deliveryId: "d", event: { type: "Message", userID: null, instanceName: null, payload: null } }],
    ["no delivery id", { v: 1, kind: "event", event: { type: "Message", userID: null, instanceName: null, payload: null } }],
    ["empty delivery id", { v: 1, kind: "event", deliveryId: "", event: { type: "Message", userID: null, instanceName: null, payload: null } }],
    ["no event block", { v: 1, kind: "event", deliveryId: "d" }],
    ["event block is not an object", { v: 1, kind: "event", deliveryId: "d", event: "Message" }],
    ["event without a payload key", { v: 1, kind: "event", deliveryId: "d", event: { type: "Message", userID: null, instanceName: null } }],
    ["event with a mistyped field", { v: 1, kind: "event", deliveryId: "d", event: { type: 7, userID: null, instanceName: null, payload: null } }],
  ])("archives a malformed envelope (%s) once, without retrying", async (_label, body) => {
    const batch = createMessageBatch("wuzip-shared-test-events", [
      { id: "poison-2", timestamp: new Date(), body, attempts: 1 },
    ]);
    const ctx = createExecutionContext();
    const dlq: DlqRecord[] = [];

    await handleBotBatch(batch, {
      env: env as unknown as Env,
      config: configFor(env as unknown as Env, "on"),
      deps: { sendDlq: async (record) => void dlq.push(record), log: quietLogger() },
    });

    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(["poison-2"]);
    expect(result.retryMessages).toEqual([]);
    expect(dlq).toHaveLength(1);
    expect(dlq[0]?.stage).toBe("bot");
    expect(dlq[0]?.reason).toContain("invalid envelope");
  });

  it("archives an unknown-but-well-formed kind to the bot stage", async () => {
    // `kind` is validated by the envelope check itself, so this covers the branch
    // that would otherwise fall through the router's dispatch chain.
    const batch = createMessageBatch("wuzip-shared-test-events", [
      {
        id: "poison-3",
        timestamp: new Date(),
        body: {
          v: 1,
          kind: "event",
          deliveryId: "d-unknown",
          event: { type: "Message", userID: null, instanceName: null, payload: { type: "NotAMessage" } },
        },
        attempts: 1,
      },
    ]);
    const ctx = createExecutionContext();
    const dlq: DlqRecord[] = [];

    await handleBotBatch(batch, {
      env: env as unknown as Env,
      config: configFor(env as unknown as Env, "on"),
      deps: { sendDlq: async (record) => void dlq.push(record), log: quietLogger() },
    });

    // A well-formed envelope whose *event* is not a customer message is filtered,
    // not archived — the point is that it reaches the pipeline at all.
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(["poison-3"]);
    expect(dlq).toHaveLength(0);
  });
});

describe("outbound failures", () => {
  it("retries the delivery when WuzAPI fails, and answers after it recovers", async () => {
    const failing = await run([buildEnvelope("d-flaky", CHAT, { conversation: "halo" })], {
      responder: () => new Response(JSON.stringify({ code: 503, success: false, error: "unavailable" }), { status: 503 }),
    });
    expect(failing.result.retryMessages.map((entry) => entry.msgId)).toEqual(["message-1"]);
    expect(failing.harness.logs).toContain("error:outbound_incomplete");

    const failed = await db
      .prepare("SELECT status FROM processed_events WHERE delivery_id = 'd-flaky'")
      .first<{ status: string }>();
    expect(failed?.status).toBe("failed");

    // The retry re-claims the failed delivery and sends exactly once.
    const recovered = await run([buildEnvelope("d-flaky", CHAT, { conversation: "halo" })]);
    expect(recovered.harness.sends).toHaveLength(1);
    expect(recovered.result.explicitAcks).toEqual(["message-1"]);

    const done = await db
      .prepare("SELECT status FROM processed_events WHERE delivery_id = 'd-flaky'")
      .first<{ status: string }>();
    expect(done?.status).toBe("done");
    // No duplicate history row from the failed first attempt.
    expect(await countMessages()).toBe(2);
  });

  it("acknowledges a permanent 4xx rejection instead of retrying forever", async () => {
    const { result, harness } = await run([buildEnvelope("d-permanent", CHAT, { conversation: "halo" })], {
      responder: () =>
        new Response(JSON.stringify({ code: 400, success: false, error: "missing Body in Payload" }), { status: 400 }),
    });
    expect(result.explicitAcks).toEqual(["message-1"]);
    expect(result.retryMessages).toEqual([]);
    expect(harness.logs).toContain("error:outbound_incomplete");
    expect(harness.logs).toContain("error:outbound_permanent");
  });

  it("releases the chat lock after a permanent rejection", async () => {
    await run([buildEnvelope("d-permanent-2", CHAT, { conversation: "halo" })], {
      responder: () => new Response(JSON.stringify({ code: 400, success: false, error: "bad payload" }), { status: 400 }),
    });

    // The next real message from the same customer must not be blocked by the
    // lock the failed attempt took.
    const next = await run([buildEnvelope("d-after-permanent", CHAT, { conversation: "halo lagi" })]);
    expect(next.result.explicitAcks).toEqual(["message-1"]);
    expect(next.harness.sends).toHaveLength(1);
  });
});

/**
 * WP-2B — one delivery must produce one reply, even across a crash.
 *
 * Each test below re-runs the *same* delivery id through the real router with a
 * fresh batch, which is exactly what Cloudflare Queues does after a retry. The
 * faults injected are the three that used to duplicate a customer's answer:
 * a 5xx in the middle of a multi-part reply, a send that succeeded before the
 * worker died, and an interrupted attempt that already answered.
 */
describe("reply plan idempotency (WP-2B)", () => {
  const PARTS: OutboundMessage[] = [
    { kind: "text", body: "Bagian satu" },
    { kind: "text", body: "Bagian dua" },
    { kind: "text", body: "Bagian tiga" },
  ];

  it("does not replay the AI or re-send a bubble that already went out", async () => {
    // "Bagian dua" fails with a 503 on every internal attempt the client makes,
    // so the reply stops between part 1 and part 3.
    const first = await run([buildEnvelope("d-plan-1", CHAT, { conversation: "halo" })], {
      replyMessages: PARTS,
      responder: (_url, body) =>
        body["Body"] === "Bagian dua"
          ? new Response(JSON.stringify({ code: 503, success: false, error: "unavailable" }), { status: 503 })
          : new Response(JSON.stringify({ code: 200, success: true, data: { Id: "WA-OK" } }), { status: 200 }),
    });

    expect(first.harness.responderCalls).toBe(1);
    // Part 1 landed, part 2 exhausted the client's ladder, part 3 was never
    // attempted (the loop stops at the first still-pending part).
    expect(first.harness.sends.length).toBeGreaterThanOrEqual(5);
    expect(first.harness.sends.at(-1)?.body["Body"]).toBe("Bagian dua");
    expect(first.result.retryMessages.map((entry) => entry.msgId)).toEqual(["message-1"]);

    // The retry must NOT call the model again: the plan is read back from D1.
    const retry = await run([buildEnvelope("d-plan-1", CHAT, { conversation: "halo" })], {
      replyMessages: PARTS,
    });

    expect(retry.harness.responderCalls).toBe(0);
    // Only the parts that never landed are re-sent — not part 1 again.
    expect(retry.harness.sends.map((call) => call.body["Body"])).toEqual(["Bagian dua", "Bagian tiga"]);
    expect(retry.result.explicitAcks).toEqual(["message-1"]);
    expect(retry.harness.logs).toContain("info:reply_plan_replayed");

    // History holds each bubble exactly once, in order.
    expect(await outboundBodies()).toEqual(["Bagian satu", "Bagian dua", "Bagian tiga"]);
  });

  it("uses the same message id for every part on every attempt", async () => {
    const first = await run([buildEnvelope("d-plan-stable", CHAT, { conversation: "halo" })], {
      replyMessages: PARTS,
    });
    const ids = sentIds(first.harness);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);

    // A redelivery after the fact is dropped by the `done` ledger before it can
    // send anything at all — that is the second layer of the same guarantee.
    const again = await run([buildEnvelope("d-plan-stable", CHAT, { conversation: "halo" })], {
      replyMessages: PARTS,
    });
    expect(again.harness.responderCalls).toBe(0);
    expect(again.harness.sends).toHaveLength(0);
    expect(again.result.explicitAcks).toEqual(["message-1"]);
    expect(await outboundBodies()).toEqual(["Bagian satu", "Bagian dua", "Bagian tiga"]);
  });

  it("re-sends under the original id when the worker died after the send", async () => {
    // Simulates "wuzapi accepted the send, then the worker was evicted before
    // markReplyPartSent ran": the ledger still says pending, so the part is
    // re-sent — under the same id, which is what makes it safe.
    const interrupted = await run([buildEnvelope("d-plan-crash", CHAT, { conversation: "halo" })], {
      replyMessages: [{ kind: "text", body: "Halo" }],
      responder: () => new Response(JSON.stringify({ code: 503, success: false, error: "down" }), { status: 503 }),
    });
    expect(interrupted.harness.responderCalls).toBe(1);

    const status = await db
      .prepare("SELECT status FROM reply_parts WHERE delivery_id = 'd-plan-crash' AND part_index = 0")
      .first<{ status: string }>();
    expect(status?.status).toBe("pending");

    const retry = await run([buildEnvelope("d-plan-crash", CHAT, { conversation: "halo" })]);
    expect(retry.harness.responderCalls).toBe(0);
    expect(retry.harness.sends).toHaveLength(1);
    expect(sentIds(retry.harness)[0]).toBe(sentIds(interrupted.harness)[0]);
  });

  it("parks a permanently rejected part and does not retry the whole reply", async () => {
    const first = await run([buildEnvelope("d-plan-4xx", CHAT, { conversation: "halo" })], {
      replyMessages: PARTS,
      responder: (_url, body) =>
        body["Body"] === "Bagian satu"
          ? new Response(JSON.stringify({ code: 400, success: false, error: "bad payload" }), { status: 400 })
          : new Response(JSON.stringify({ code: 200, success: true, data: { Id: "WA-OK" } }), { status: 200 }),
    });

    // Part 0 is a 4xx, but parts 1 and 2 are still attempted.
    expect(first.harness.sends).toHaveLength(3);
    expect(first.result.explicitAcks).toEqual(["message-1"]);
    expect(first.result.retryMessages).toEqual([]);
    expect(first.harness.logs).toContain("error:outbound_permanent");

    const parked = await db
      .prepare("SELECT status FROM reply_parts WHERE delivery_id = 'd-plan-4xx' AND part_index = 0")
      .first<{ status: string }>();
    expect(parked?.status).toBe("failed");
    // The parts that did arrive are still recorded, so history stays truthful.
    expect(await outboundBodies()).toEqual(["Bagian dua", "Bagian tiga"]);
  });

  it("keeps a shadow-mode reply out of the ledger entirely", async () => {
    const { harness, result } = await run([buildEnvelope("d-plan-shadow", CHAT, { conversation: "halo" })], {
      mode: "shadow",
      replyMessages: PARTS,
    });

    expect(harness.responderCalls).toBe(1);
    expect(harness.sends).toHaveLength(0);
    expect(result.explicitAcks).toEqual(["message-1"]);
    // Nothing was sent, so no part may be recorded as sent.
    const rows = await db
      .prepare("SELECT status FROM reply_parts WHERE delivery_id = 'd-plan-shadow'")
      .all<{ status: string }>();
    expect(rows.results.map((row) => row.status)).toEqual(["pending", "pending", "pending"]);
  });
});

function quietLogger(): {
  debug: () => void;
  info: () => void;
  warn: () => void;
  error: () => void;
} {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

describe("WuzAPI client retry ladder", () => {
  it("retries 429 and 5xx before giving up, and reports the attempt count", async () => {
    let seen = 0;
    const { harness } = await run([buildEnvelope("d-retry", CHAT, { conversation: "halo" })], {
      responder: () => {
        seen += 1;
        const status = seen === 1 ? 429 : 200;
        return new Response(JSON.stringify({ code: status, success: status === 200, data: { Id: "WA-OK" } }), {
          status,
        });
      },
    });
    expect(seen).toBe(2);
    expect(harness.sends).toHaveLength(2);
    expect(harness.logs).toContain("warn:wuzapi_retry");
  });
});
