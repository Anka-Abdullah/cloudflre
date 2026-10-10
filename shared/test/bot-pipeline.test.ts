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
import { ENVELOPE_VERSION, type EnvelopeV1 } from "../src/envelope";
import { handleBotBatch } from "../src/bot/queue/router";
import { claimChat, releaseChat } from "../src/bot/coordinator/chat-lock";
import type { ReplyContext } from "../src/bot/types";

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
}

interface RunOptions {
  mode?: "off" | "shadow" | "on";
  /** Overrides the WuzAPI response; return a 503 to simulate an outage. */
  responder?: (url: string, attempt: number) => Response;
  reply?: string;
  /** Simulates a missing secret or binding for this run only. */
  envOverrides?: Record<string, unknown>;
}

async function run(
  envelopes: EnvelopeV1[],
  options: RunOptions = {},
): Promise<{ harness: Harness; result: Awaited<ReturnType<typeof getQueueResult>> }> {
  const harness: Harness = { calls: [], sends: [], presence: [], logs: [], contexts: [] };

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
        return { messages: [{ kind: "text", body: options.reply ?? "Halo, ada yang bisa dibantu?" }], reason: "test" };
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
        if (options.responder && url.includes("/chat/send/")) return options.responder(url, harness.sends.length);
        return new Response(JSON.stringify({ code: 200, success: true, data: { Id: "WA-OUT-1" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    },
  });

  return { harness, result: await getQueueResult(batch, ctx) };
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
    await claimChat(lockEnv, CHAT, { deliveryId: "d-holder", lockTtlMs: 60_000 });

    const { harness, result } = await run([buildEnvelope("d-locked", CHAT, { conversation: "halo" })]);
    expect(harness.calls).toHaveLength(0);
    expect(result.retryMessages.map((entry) => entry.msgId)).toEqual(["message-1"]);
    expect(harness.logs).toContain("info:event_locked");

    await releaseChat(lockEnv, CHAT, {});
  });

  it("does not record a locked delivery as done, so the retry can continue", async () => {
    const lockEnv = env as unknown as Env;
    await claimChat(lockEnv, CHAT, { deliveryId: "d-holder", lockTtlMs: 60_000 });
    await run([buildEnvelope("d-locked-2", CHAT, { conversation: "halo" })]);
    const row = await db
      .prepare("SELECT delivery_id FROM processed_events WHERE delivery_id = 'd-locked-2'")
      .first<{ delivery_id: string }>();
    expect(row).toBeNull();
    await releaseChat(lockEnv, CHAT, {});
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
