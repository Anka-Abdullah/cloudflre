/**
 * The `BOT_MODE` switch and `/healthz`, exercised through the real worker entry.
 *
 * `BOT_MODE` is the rollback lever for the whole automation (work plan section 1:
 * "set BOT_MODE=off; Worker kembali ke relay Queue"), so the test asserts the two
 * paths are genuinely different rather than both "working": with `off` the
 * envelope must be POSTed to DOWNSTREAM_URL and never reach the bot pipeline;
 * with `shadow` the opposite.
 */
import { env, exports } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createWorker } from "../src/worker";
import { ENVELOPE_VERSION, type EnvelopeV1 } from "../src/envelope";
import type { Env } from "../src/config";

const baseEnv = env as unknown as Env;

function envelope(deliveryId: string, chat: string): EnvelopeV1 {
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
        event: {
          Info: {
            Chat: chat,
            Sender: chat,
            IsFromMe: false,
            IsGroup: false,
            ID: "WA-1",
            Timestamp: "2026-10-10T07:59:00Z",
            PushName: "Budi",
          },
          Message: { conversation: "halo" },
        },
      },
    },
    source: { worker: "6281234567890", slug: "6281234567890", ua: "test", ip: null, rawSize: 300 },
  };
}

interface RunResult {
  logs: string[];
  /** Every URL the worker called; the relay target and WuzAPI share this seam. */
  requests: string[];
  result: Awaited<ReturnType<typeof getQueueResult>>;
}

const RELAY_URL = "https://bot.example.test/wuzapi/events";

async function runQueue(mode: string, body: EnvelopeV1): Promise<RunResult> {
  const logs: string[] = [];
  const requests: string[] = [];
  const worker = createWorker({
    now: () => new Date("2026-10-10T08:00:00.000Z"),
    log: (line) => void logs.push(line),
    fetchImpl: (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ code: 200, success: true, data: { Id: "WA-OUT-1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  const batch = createMessageBatch("wuzip-shared-test-events", [
    { id: "m-1", timestamp: new Date("2026-10-10T08:00:00.000Z"), body, attempts: 1 },
  ]);
  const ctx = createExecutionContext();
  const scenarioEnv = { ...baseEnv, BOT_MODE: mode } as Env;

  await worker.queue?.(batch, scenarioEnv, ctx);
  return { logs, requests, result: await getQueueResult(batch, ctx) };
}

function events(logs: string[]): string[] {
  return logs.map((line) => String((JSON.parse(line) as { event?: string }).event ?? ""));
}

describe("BOT_MODE routing", () => {
  it("relays to DOWNSTREAM_URL and skips the bot when BOT_MODE=off", async () => {
    const { logs, requests, result } = await runQueue("off", envelope("d-off", "628111@s.whatsapp.net"));

    expect(requests).toEqual([RELAY_URL]);
    expect(events(logs)).toContain("relay_delivered");
    expect(events(logs)).not.toContain("event_received");
    expect(result.explicitAcks).toEqual(["m-1"]);
  });

  it("runs the bot pipeline and does not relay when BOT_MODE=shadow", async () => {
    const { logs, requests, result } = await runQueue("shadow", envelope("d-shadow", "628111@s.whatsapp.net"));

    expect(requests).not.toContain(RELAY_URL);
    expect(events(logs)).toContain("event_received");
    expect(events(logs)).not.toContain("relay_delivered");
    expect(events(logs)).toContain("outbound_suppressed_shadow");
    expect(result.explicitAcks).toEqual(["m-1"]);
  });

  it("runs the bot pipeline and answers through WuzAPI when BOT_MODE=on", async () => {
    const { logs, requests } = await runQueue("on", envelope("d-on", "628111@s.whatsapp.net"));
    expect(requests).not.toContain(RELAY_URL);
    expect(requests).toEqual(["https://wuzapi.example.test/chat/send/text"]);
    expect(events(logs)).toContain("event_received");
    expect(events(logs)).toContain("outbound_sent");
  });
});

describe("/healthz", () => {
  it("reports the active bindings and the bot readiness without leaking secrets", async () => {
    const response = await exports.default.fetch(new Request("https://worker.example.test/healthz"));
    expect(response.status).toBe(200);

    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload["ok"]).toBe(true);
    expect(payload["slug"]).toBe("6281234567890");
    expect(payload["botMode"]).toBe("shadow");
    expect(payload["knowledgeMode"]).toBe("auto");
    expect(payload["aiModel"]).toBe("cmc/deepseek/deepseek-v4.1-flash");

    const bindings = payload["bindings"] as Record<string, boolean>;
    expect(bindings).toMatchObject({
      EVENTS: true,
      DLQ: true,
      MEDIA: true,
      BOT_DB: true,
      KNOWLEDGE_KV: true,
      CHAT_COORDINATOR: true,
    });

    expect(payload["bot"]).toMatchObject({ ready: true, missing: [], missingBindings: [] });
    expect(payload["wuzapiConfigured"]).toBe(true);
    expect(payload["aiConfigured"]).toBe(true);

    // The endpoint is public: no secret value may appear anywhere in the body.
    const body = JSON.stringify(payload);
    for (const secret of [
      "test-ingest-token-0123456789",
      "wuzapi-test-hmac-key-0123456789abcdef",
      "downstream-test-hmac-key",
      "test-wuzapi-token",
      "test-ai-key",
      "test-admin-key",
    ]) {
      expect(body).not.toContain(secret);
    }
  });
});
