/**
 * Consumer tests: ack/retry classification, DLQ archiving, and the relay
 * contract the bot depends on (headers + downstream signature).
 *
 * `createMessageBatch` + `getQueueResult` report exactly what the runtime would
 * do with each message, so the ack/retry decisions are asserted, not inferred.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { loadConfig, type Env, type InstanceConfig } from "../src/config";
import { handleEventsBatch } from "../src/consumer/relay";
import { handleDlqBatch } from "../src/consumer/dlq";
import { isDlqQueue } from "../src/support";
import type { DlqRecord, EnvelopeV1 } from "../src/envelope";
import { hmacSha256Hex } from "../src/lib/hmac";

const config: InstanceConfig = loadConfig(env as unknown as Env);

function envelope(overrides: Partial<EnvelopeV1> = {}): EnvelopeV1 {
  return {
    v: 1,
    kind: "event",
    receivedAt: "2026-10-10T07:15:00.000Z",
    deliveryId: "a".repeat(64),
    contentType: "application/json",
    hmac: { verified: true, algorithm: "hmac-sha256" },
    event: { type: "Message", userID: "1", instanceName: "nomor-1", payload: { type: "Message" } },
    source: { worker: "6281234567890", slug: "6281234567890", ua: null, ip: null, rawSize: 300 },
    ...overrides,
  };
}

interface RelayHarness {
  dlq: DlqRecord[];
  calls: { url: string; init: RequestInit }[];
  logs: string[];
}

async function runRelay(
  bodies: unknown[],
  options: {
    responder?: (url: string, init: RequestInit) => Promise<Response> | Response;
    relayConfig?: InstanceConfig;
    messageIds?: string[];
  } = {},
) {
  const harness: RelayHarness = { dlq: [], calls: [], logs: [] };
  const batch = createMessageBatch(
    "wuzip-shared-test-events",
    bodies.map((body, index) => ({
      id: options.messageIds?.[index] ?? `message-${index + 1}`,
      timestamp: new Date("2026-10-10T07:15:00.000Z"),
      body,
      attempts: 1,
    })),
  );
  const ctx = createExecutionContext();
  await handleEventsBatch(batch, {
    env: env as unknown as Env,
    config: options.relayConfig ?? config,
    deps: {
      random: () => 0,
      log: {
        debug: () => {},
        info: (event) => void harness.logs.push(`info:${event}`),
        warn: (event) => void harness.logs.push(`warn:${event}`),
        error: (event) => void harness.logs.push(`error:${event}`),
      },
      sendDlq: async (record) => {
        harness.dlq.push(record);
      },
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        harness.calls.push({ url, init: init ?? {} });
        if (!options.responder) return new Response("ok", { status: 200 });
        return await options.responder(url, init ?? {});
      }) as typeof fetch,
    },
  });
  const result = await getQueueResult(batch, ctx);
  return { harness, result };
}

describe("relay: acknowledgements", () => {
  it("acks after a 2xx and posts the envelope with correlation headers", async () => {
    const { harness, result } = await runRelay([envelope()]);

    expect(result.explicitAcks).toEqual(["message-1"]);
    expect(result.retryMessages).toEqual([]);
    expect(harness.calls).toHaveLength(1);

    const call = harness.calls[0] as { url: string; init: RequestInit };
    expect(call.url).toBe(config.downstreamUrl);
    const headers = new Headers(call.init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-wuzip-delivery-id")).toBe("a".repeat(64));
    expect(headers.get("x-wuzip-event-type")).toBe("Message");
    expect(headers.get("x-wuzip-user-id")).toBe("1");
    expect(headers.get("x-wuzip-slug")).toBe("6281234567890");
    expect(headers.get("x-wuzip-attempt")).toBe("1");
    expect(call.init.body).toBe(JSON.stringify(envelope()));

    // The bot can verify the relayed payload with the shared key.
    const expected = await hmacSha256Hex(
      new TextEncoder().encode(config.downstreamHmacKey),
      new TextEncoder().encode(call.init.body as string),
    );
    expect(headers.get("x-wuzip-signature")).toBe(`sha256=${expected}`);
  });

  it("retries on 5xx without acknowledging", async () => {
    const { result, harness } = await runRelay([envelope()], {
      responder: () => new Response("boom", { status: 503 }),
    });

    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages.map((entry) => entry.msgId)).toEqual(["message-1"]);
    expect(harness.logs).toContain("warn:relay_retry");
  });

  it("requests exponential backoff delays per attempt", async () => {
    // getQueueResult only reports which messages were retried, so the delay
    // values are asserted against a recording batch instead.
    for (const [attempts, expected] of [
      [1, 15],
      [2, 30],
      [4, 120],
      [12, 3_600],
    ] as const) {
      const { delays } = await relayWithRecordingBatch(attempts, () => new Response("boom", { status: 500 }));
      expect(delays).toEqual([expected]);
    }
  });

  it("adds jitter on top of the exponential delay", async () => {
    const { delays } = await relayWithRecordingBatch(1, () => new Response("boom", { status: 500 }), () => 0.99);
    // base 15s + floor(0.99 * 15) = 29
    expect(delays).toEqual([29]);
  });

  it("retries on 429 and on network errors", async () => {
    const throttled = await runRelay([envelope()], {
      responder: () => new Response("slow down", { status: 429 }),
    });
    expect(throttled.result.retryMessages.map((entry) => entry.msgId)).toEqual(["message-1"]);

    const failed = await runRelay([envelope()], {
      responder: () => {
        throw new Error("connection refused");
      },
    });
    expect(failed.result.retryMessages.map((entry) => entry.msgId)).toEqual(["message-1"]);
  });
});

describe("relay: permanent failures", () => {
  it("acks and archives a 4xx response to the DLQ", async () => {
    const { result, harness } = await runRelay([envelope()], {
      responder: () => new Response("unknown tenant", { status: 404 }),
    });

    expect(result.explicitAcks).toEqual(["message-1"]);
    expect(result.retryMessages).toEqual([]);
    expect(harness.dlq).toHaveLength(1);
    expect(harness.dlq[0]?.stage).toBe("relay");
    expect(harness.dlq[0]?.reason).toContain("404");
    expect(harness.dlq[0]?.reason).toContain("unknown tenant");
  });

  it("acks and archives an unclassified status so it cannot loop", async () => {
    const { result, harness } = await runRelay([envelope()], {
      responder: () => new Response("", { status: 302 }),
    });
    expect(result.explicitAcks).toEqual(["message-1"]);
    expect(harness.dlq).toHaveLength(1);
  });

  it("acks and archives a poison message", async () => {
    const { result, harness } = await runRelay([{ not: "an envelope" }]);
    expect(result.explicitAcks).toEqual(["message-1"]);
    expect(harness.dlq).toHaveLength(1);
    expect(harness.dlq[0]?.reason).toContain("not an envelope");
    expect(harness.calls).toHaveLength(0);
  });

  it("archives instead of looping when DOWNSTREAM_URL is empty", async () => {
    const { result, harness } = await runRelay([envelope()], {
      relayConfig: { ...config, downstreamUrl: "" },
    });
    expect(result.explicitAcks).toEqual(["message-1"]);
    expect(harness.dlq[0]?.reason).toContain("DOWNSTREAM_URL");
    expect(harness.calls).toHaveLength(0);
  });

  it("acks without calling downstream in observe mode", async () => {
    const { result, harness } = await runRelay([envelope()], {
      relayConfig: { ...config, relayMode: "observe" },
    });
    expect(result.explicitAcks).toEqual(["message-1"]);
    expect(harness.calls).toHaveLength(0);
    expect(harness.logs).toContain("info:relay_observed");
  });
});

describe("relay: mixed batches", () => {
  it("decides per message instead of failing the whole batch", async () => {
    const { result, harness } = await runRelay([envelope(), envelope({ deliveryId: "b".repeat(64) })], {
      responder: (_url, init) => {
        // Fail only the second delivery.
        const body = JSON.parse(String(init.body)) as EnvelopeV1;
        return body.deliveryId.startsWith("b")
          ? new Response("upstream down", { status: 502 })
          : new Response("ok", { status: 200 });
      },
    });

    expect(result.explicitAcks).toEqual(["message-1"]);
    expect(result.retryMessages.map((entry) => entry.msgId)).toEqual(["message-2"]);
    expect(harness.calls).toHaveLength(2);
  });
});

describe("DLQ consumer", () => {
  async function runDlq(
    bodies: unknown[],
    options: { alertWebhookUrl?: string; putFails?: boolean } = {},
  ) {
    const archived = new Map<string, string>();
    const alerts: string[] = [];
    const batch = createMessageBatch(
      "wuzip-shared-test-dlq",
      bodies.map((body, index) => ({
        id: `dlq-${index + 1}`,
        timestamp: new Date("2026-10-10T07:15:00.000Z"),
        body,
        attempts: 1,
      })),
    );
    const ctx = createExecutionContext();
    await handleDlqBatch(batch, {
      env: env as unknown as Env,
      config: { ...config, alertWebhookUrl: options.alertWebhookUrl ?? "" },
      deps: {
        now: () => new Date("2026-10-10T07:20:00.000Z"),
        log: silentLogger(),
        put: async (key, value) => {
          if (options.putFails) throw new Error("r2 down");
          archived.set(key, value);
        },
        fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
          alerts.push(`${String(input)}|${String(init?.body ?? "")}`);
          return new Response("ok", { status: 200 });
        }) as typeof fetch,
      },
    });
    const result = await getQueueResult(batch, ctx);
    return { archived, alerts, result };
  }

  const record: DlqRecord = {
    v: 1,
    failedAt: "2026-10-10T07:16:00.000Z",
    stage: "relay",
    reason: "downstream responded 404",
    queue: "wuzip-shared-test-events",
    messageId: "message-1",
    attempts: 3,
    envelope: envelope(),
  };

  it("archives the record to R2 and acks", async () => {
    const { archived, result } = await runDlq([record]);
    expect(result.explicitAcks).toEqual(["dlq-1"]);
    const key = "_dlq/6281234567890/2026-10-10/dlq-1.json";
    expect([...archived.keys()]).toEqual([key]);
    const stored = JSON.parse(archived.get(key) as string) as { record: DlqRecord; messageId: string };
    expect(stored.messageId).toBe("dlq-1");
    expect(stored.record.reason).toContain("404");
  });

  it("keeps the message in the queue when archiving fails", async () => {
    const { result } = await runDlq([record], { putFails: true });
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages.map((entry) => entry.msgId)).toEqual(["dlq-1"]);
  });

  it("notifies ALERT_WEBHOOK_URL when configured", async () => {
    const { alerts, result } = await runDlq([record], { alertWebhookUrl: "https://alerts.example.test/hook" });
    expect(result.explicitAcks).toEqual(["dlq-1"]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("https://alerts.example.test/hook");
    expect(alerts[0]).toContain("6281234567890");
  });
});

describe("DLQ consumer wiring", () => {
  it("routes batches to the archive path by queue-name convention", () => {
    expect(isDlqQueue("wuzip-shared-test-dlq", {})).toBe(true);
    expect(isDlqQueue("wuzip-shared-test-events", {})).toBe(false);
    // An explicit name always wins over the suffix convention.
    expect(isDlqQueue("my-own-name", { DLQ_QUEUE_NAME: "my-own-name" })).toBe(true);
    expect(isDlqQueue("wuzip-shared-test-dlq", { DLQ_QUEUE_NAME: "my-own-name" })).toBe(false);
  });

  it("archives into the real R2 bucket through the default binding", async () => {
    const record: DlqRecord = {
      v: 1,
      failedAt: "2026-10-10T07:16:00.000Z",
      stage: "relay",
      reason: "downstream responded 503 after max_retries",
      queue: "wuzip-shared-test-events",
      messageId: "message-9",
      attempts: 3,
      envelope: envelope(),
    };
    const batch = createMessageBatch("wuzip-shared-test-dlq", [
      { id: "dlq-real-1", timestamp: new Date("2026-10-10T07:20:00.000Z"), body: record, attempts: 1 },
    ]);
    const ctx = createExecutionContext();

    await handleDlqBatch(batch, {
      env: env as unknown as Env,
      config: { ...config, alertWebhookUrl: "" },
      deps: { now: () => new Date("2026-10-10T07:20:00.000Z"), log: silentLogger() },
    });
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(["dlq-real-1"]);

    const object = await env.MEDIA.get("_dlq/6281234567890/2026-10-10/dlq-real-1.json");
    expect(object).not.toBeNull();
    const stored = JSON.parse((await object?.text()) ?? "{}") as { record: DlqRecord };
    expect(stored.record.messageId).toBe("message-9");
    expect(stored.record.reason).toContain("503");
  });
});

function silentLogger() {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

/** Runs the relay against a hand-rolled batch so retry options can be captured. */
async function relayWithRecordingBatch(
  attempts: number,
  responder: () => Response,
  random: () => number = () => 0,
): Promise<{ delays: (number | undefined)[]; acks: string[] }> {
  const delays: (number | undefined)[] = [];
  const acks: string[] = [];
  const batch = {
    queue: "wuzip-shared-test-events",
    messages: [
      {
        id: "message-1",
        timestamp: new Date("2026-10-10T07:15:00.000Z"),
        body: envelope(),
        attempts,
        ack: () => void acks.push("message-1"),
        retry: (options?: { delaySeconds?: number }) => void delays.push(options?.delaySeconds),
      },
    ],
    ackAll: () => {},
    retryAll: () => {},
  } as unknown as MessageBatch<unknown>;

  await handleEventsBatch(batch, {
    env: env as unknown as Env,
    config,
    deps: {
      random,
      log: silentLogger(),
      fetchImpl: (async () => responder()) as typeof fetch,
    },
  });
  return { delays, acks };
}
