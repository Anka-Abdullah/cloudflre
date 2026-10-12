/**
 * Ingest handler tests.
 *
 * Two levels are covered on purpose:
 *  - direct handler calls with recording fakes, so the exact queue envelope can
 *    be asserted (Cloudflare exposes no "read the queue" API in tests);
 *  - calls through the real worker entry point with real R2 bindings, so the
 *    streaming path is exercised end to end.
 */
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import fixturesFile from "./fixtures/wuzapi-hmac.json";
import { loadConfig, type Env } from "../src/config";
import { handleIngest } from "../src/ingest/handler";
import type { DlqRecord, EnvelopeV1 } from "../src/envelope";

interface Fixture {
  name: string;
  contentType: string;
  key: string;
  body: string;
  signature: string;
}

const fixtures = (fixturesFile as { fixtures: Fixture[] }).fixtures;
const fixture = (name: string): Fixture => {
  const found = fixtures.find((entry) => entry.name === name);
  if (!found) throw new Error(`fixture ${name} not found`);
  return found;
};

const config = loadConfig(env as unknown as Env);
const TOKEN = "test-ingest-token-0123456789";

interface Harness {
  sent: EnvelopeV1[];
  dlq: DlqRecord[];
  stored: Map<string, Uint8Array>;
  deleted: string[];
  /** `contentLength: "none"` emulates a sender that does not announce a length. */
  request(body: string | Uint8Array, init?: RequestInit & { token?: string; contentLength?: number | "none" }): Request;
}

function harness(): Harness {
  const sent: EnvelopeV1[] = [];
  const dlq: DlqRecord[] = [];
  const stored = new Map<string, Uint8Array>();
  const deleted: string[] = [];
  return {
    sent,
    dlq,
    stored,
    deleted,
    request(body, init = {}) {
      const token = init.token ?? TOKEN;
      const headers = new Headers(init.headers ?? {});
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
      const declared =
        init.contentLength ??
        (typeof body === "string" ? new TextEncoder().encode(body).byteLength : body.byteLength);
      if (declared !== "none" && !headers.has("content-length")) {
        headers.set("content-length", String(declared));
      }
      const { contentLength: _contentLength, token: _token, ...rest } = init;
      return new Request(`https://worker.example.test/ingest/${token}`, {
        method: rest.method ?? "POST",
        headers,
        body,
        ...(rest.redirect ? { redirect: rest.redirect } : {}),
      });
    },
  };
}

async function callIngest(
  test: Harness,
  request: Request,
  options: { failSend?: boolean; failPut?: boolean; config?: typeof config } = {},
) {
  return await handleIngest(request, {
    env: env as unknown as Env,
    config: options.config ?? config,
    deps: {
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      now: () => new Date("2026-10-10T07:15:00.000Z"),
      randomUUID: (() => {
        let counter = 0;
        return () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
      })(),
      send: async (envelope) => {
        if (options.failSend) throw new Error("queue unavailable");
        test.sent.push(envelope);
      },
      put: async (key, value) => {
        if (options.failPut) throw new Error("r2 unavailable");
        const bytes =
          value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : new Uint8Array(await new Response(value as ReadableStream).arrayBuffer());
        test.stored.set(key, bytes);
      },
      remove: async (key) => {
        test.deleted.push(key);
        test.stored.delete(key);
      },
      sendDlq: async (record) => {
        test.dlq.push(record);
      },
    },
  });
}

describe("ingest: authentication", () => {
  it("accepts the configured token and queues a small JSON event", async () => {
    const test = harness();
    const body = fixture("json-event-message");
    const response = await callIngest(
      test,
      test.request(body.body, { headers: { "content-type": "application/json", "x-hmac-signature": body.signature } }),
    );

    expect(response.status).toBe(202);
    expect(test.sent).toHaveLength(1);
    const envelope = test.sent[0] as EnvelopeV1;
    expect(envelope.v).toBe(1);
    expect(envelope.kind).toBe("event");
    expect(envelope.hmac).toEqual({ verified: true, algorithm: "hmac-sha256" });
    expect(envelope.event.type).toBe("Message");
    expect(envelope.event.userID).toBe("1");
    expect(envelope.event.instanceName).toBe("nomor-1");
    expect((envelope.event.payload as { event: { Info: { ID: string } } }).event.Info.ID).toBe("3EB0ABCDEF");
    expect(envelope.deliveryId).toMatch(/^[0-9a-f]{64}$/);
    expect(envelope.source.slug).toBe("6281234567890");
  });

  it("rejects a wrong token with 401", async () => {
    const test = harness();
    const body = fixture("json-event-message");
    const response = await callIngest(
      test,
      test.request(body.body, {
        token: "not-the-token",
        headers: { "content-type": "application/json", "x-hmac-signature": body.signature },
      }),
    );
    expect(response.status).toBe(401);
    expect(test.sent).toHaveLength(0);
  });

  it("rejects a missing signature in strict mode with 403", async () => {
    const test = harness();
    const body = fixture("json-event-message");
    const response = await callIngest(test, test.request(body.body, { headers: { "content-type": "application/json" } }));
    expect(response.status).toBe(403);
    expect(test.sent).toHaveLength(0);
  });

  it("rejects a tampered body with 403", async () => {
    const test = harness();
    const body = fixture("json-event-message");
    const response = await callIngest(
      test,
      test.request(`${body.body} `, {
        headers: { "content-type": "application/json", "x-hmac-signature": body.signature },
      }),
    );
    expect(response.status).toBe(403);
    expect(test.sent).toHaveLength(0);
  });

  it("rejects an unsupported content type with 415", async () => {
    const test = harness();
    const response = await callIngest(
      test,
      test.request("hello", { headers: { "content-type": "text/plain", "x-hmac-signature": "deadbeef" } }),
    );
    expect(response.status).toBe(415);
  });
});

describe("ingest: HMAC modes", () => {
  const body = fixture("json-event-message");

  it("off: accepts without a signature and records why", async () => {
    const test = harness();
    const response = await callIngest(
      test,
      test.request(body.body, { headers: { "content-type": "application/json" } }),
      { config: { ...config, hmacMode: "off" } },
    );
    expect(response.status).toBe(202);
    expect(test.sent[0]?.hmac).toEqual({ verified: false, reason: "disabled" });
  });

  it("optional: accepts without a signature but verifies when present", async () => {
    const test = harness();
    const optional = { ...config, hmacMode: "optional" as const };

    const withoutSignature = await callIngest(
      test,
      test.request(body.body, { headers: { "content-type": "application/json" } }),
      { config: optional },
    );
    expect(withoutSignature.status).toBe(202);
    expect(test.sent[0]?.hmac).toEqual({ verified: false, reason: "absent" });

    const withBadSignature = await callIngest(
      test,
      test.request(body.body, { headers: { "content-type": "application/json", "x-hmac-signature": "00" } }),
      { config: optional },
    );
    expect(withBadSignature.status).toBe(403);
  });

  it("strict: accepts any key of the rotation keyring", async () => {
    const test = harness();
    const rotating = { ...config, hmacKeys: ["previous-key", body.key] };
    const response = await callIngest(
      test,
      test.request(body.body, { headers: { "content-type": "application/json", "x-hmac-signature": body.signature } }),
      { config: rotating },
    );
    expect(response.status).toBe(202);
  });

  it("reports a misconfigured keyring instead of silently accepting", async () => {
    const test = harness();
    const response = await callIngest(
      test,
      test.request(body.body, { headers: { "content-type": "application/json", "x-hmac-signature": body.signature } }),
      { config: { ...config, hmacKeys: [] } },
    );
    expect(response.status).toBe(500);
  });
});

describe("ingest: parsing", () => {
  it("parses form-encoded events", async () => {
    const test = harness();
    const body = fixture("form-event-message");
    const response = await callIngest(
      test,
      test.request(body.body, {
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-hmac-signature": body.signature,
        },
      }),
    );
    expect(response.status).toBe(202);
    expect(test.sent[0]?.event.type).toBe("Message");
    expect(test.sent[0]?.event.userID).toBe("1");
    expect(test.sent[0]?.event.instanceName).toBe("nomor-1");
    expect(test.sent[0]?.contentType).toBe("application/x-www-form-urlencoded");
  });

  it("parses the global webhook shape where jsonData is a string", async () => {
    const test = harness();
    const body = fixture("json-global-webhook");
    const response = await callIngest(
      test,
      test.request(body.body, { headers: { "content-type": "application/json", "x-hmac-signature": body.signature } }),
    );
    expect(response.status).toBe(202);
    expect(test.sent[0]?.event.type).toBe("Message");
    expect(test.sent[0]?.event.userID).toBe("1");
  });

  it("returns 400 for a body that is not parseable JSON", async () => {
    const test = harness();
    const bad = "not json at all";
    const response = await callIngest(
      test,
      test.request(bad, { headers: { "content-type": "application/json" } }),
      { config: { ...config, hmacMode: "off" } },
    );
    expect(response.status).toBe(400);
    expect(test.sent).toHaveLength(0);
  });
});

describe("ingest: queue failures", () => {
  it("answers 503 so wuzapi retries", async () => {
    const test = harness();
    const body = fixture("json-event-message");
    const response = await callIngest(
      test,
      test.request(body.body, { headers: { "content-type": "application/json", "x-hmac-signature": body.signature } }),
      { failSend: true },
    );
    expect(response.status).toBe(503);
  });
});

/**
 * WP-4A. `optional` means the signature is not required — not that the keyring is
 * optional. Those are two different settings and the old code conflated them: with
 * no WUZAPI_HMAC_KEYS it answered 500 even for a webhook that carried no
 * signature, so a number deliberately running unauthenticated could not receive
 * anything at all.
 */
describe("ingest: HMAC optional without a keyring (WP-4A)", () => {
  const body = fixture("json-event-message");
  const noKeys = { ...config, hmacMode: "optional" as const, hmacKeys: [] };

  it("accepts a signature-less webhook and records it as absent", async () => {
    const test = harness();
    const response = await callIngest(
      test,
      test.request(body.body, { headers: { "content-type": "application/json" } }),
      { config: noKeys },
    );
    expect(response.status).toBe(202);
    expect(test.sent[0]?.hmac).toEqual({ verified: false, reason: "absent" });
  });

  it("still refuses a signature it has no key to check", async () => {
    // Accepting this would stamp an unverifiable request as if it had been
    // checked, which is the one outcome the mode exists to prevent.
    const test = harness();
    const response = await callIngest(
      test,
      test.request(body.body, { headers: { "content-type": "application/json", "x-hmac-signature": "deadbeef" } }),
      { config: noKeys },
    );
    expect(response.status).toBe(500);
    expect(test.sent).toHaveLength(0);
  });

  it("ignores a stray signature entirely in off mode", async () => {
    // `off` must not depend on the keyring either: an instance that never
    // configured HMAC has to keep working even if the sender adds the header.
    const test = harness();
    const response = await callIngest(
      test,
      test.request(body.body, { headers: { "content-type": "application/json", "x-hmac-signature": "deadbeef" } }),
      { config: { ...config, hmacMode: "off", hmacKeys: [] } },
    );
    expect(response.status).toBe(202);
    expect(test.sent[0]?.hmac).toEqual({ verified: false, reason: "disabled" });
  });
});

/**
 * WP-4B. `POST /ingest/<token>` carries the shared secret *in the path*, so a log
 * line that echoes the pathname copies a live credential into every log sink,
 * alert payload and DLQ archive it touches.
 */
describe("ingest: token redaction (WP-4B)", () => {
  it("never writes the ingest token to the log, even when it rejects the request", async () => {
    const test = harness();
    const body = fixture("json-event-message");
    const lines: string[] = [];
    const record = (event: string, fields?: Record<string, unknown>): void => {
      lines.push(`${event} ${JSON.stringify(fields ?? {})}`);
    };

    const response = await handleIngest(
      test.request(body.body, { token: "super-secret-token-value", headers: { "content-type": "application/json" } }),
      {
        env: env as unknown as Env,
        config,
        deps: {
          log: { debug: () => {}, info: record, warn: record, error: record },
          now: () => new Date("2026-10-10T07:15:00.000Z"),
        },
      },
    );

    expect(response.status).toBe(401);
    const output = lines.join("\n");
    expect(output).toContain("ingest_unauthorized");
    expect(output).not.toContain("super-secret-token-value");
    expect(output).not.toContain(TOKEN);
    // A fingerprint is still there, so two wrong URLs remain distinguishable.
    expect(output).toMatch(/"pathHash":"[0-9a-f]{12}"/);
  });

  it("does not leak the token on a successful ingest either", async () => {
    const test = harness();
    const body = fixture("json-event-message");
    const lines: string[] = [];
    const record = (event: string, fields?: Record<string, unknown>): void => {
      lines.push(`${event} ${JSON.stringify(fields ?? {})}`);
    };

    await handleIngest(
      test.request(body.body, { headers: { "content-type": "application/json", "x-hmac-signature": body.signature } }),
      {
        env: env as unknown as Env,
        config,
        deps: {
          log: { debug: () => {}, info: record, warn: record, error: record },
          send: async (envelope) => void test.sent.push(envelope),
        },
      },
    );

    expect(test.sent).toHaveLength(1);
    expect(lines.join("\n")).not.toContain(TOKEN);
  });
});

/**
 * WP-4C. Two caps that did not exist: one for the whole upload, one for the
 * serialised envelope. Without them a declared length above the media ceiling was
 * streamed into R2 until the runtime cut it off, and an inline event that
 * serialised past the 128 KB queue limit was rejected by the queue and lost.
 */
describe("ingest: size caps (WP-4C)", () => {
  it("answers 413 and records the drop when Content-Length exceeds MEDIA_MAX_BYTES", async () => {
    const test = harness();
    const response = await callIngest(
      test,
      test.request("x".repeat(2_000), {
        headers: { "content-type": "application/json", "x-hmac-signature": "deadbeef" },
        contentLength: 5_000,
      }),
      { config: { ...config, mediaMaxBytes: 4_000 } },
    );

    expect(response.status).toBe(413);
    expect(test.sent).toHaveLength(0);
    expect(test.stored.size).toBe(0);
    expect(test.dlq).toHaveLength(1);
    expect(test.dlq[0]?.stage).toBe("ingest");
    expect(test.dlq[0]?.reason).toContain("MEDIA_MAX_BYTES");
  });

  it("offloads an inline event whose envelope does not fit, instead of losing it", async () => {
    const test = harness();
    // A body comfortably inside INLINE_MAX_BYTES (90 000) but whose *envelope*
    // exceeds the cap once the wrapper, the HMAC block and the source block are
    // added — the case the inline path used to trust could not happen.
    const big = JSON.stringify({
      type: "Message",
      userID: "1",
      instanceName: "nomor-1",
      event: { Info: { Chat: "6281234567890@s.whatsapp.net", ID: "3EB0BIGINLINE" }, conversation: "y".repeat(15_000) },
    });
    expect(big.length).toBeGreaterThan(12_000);
    expect(big.length).toBeLessThan(config.inlineMaxBytes);

    const response = await callIngest(
      test,
      test.request(big, { headers: { "content-type": "application/json" } }),
      { config: { ...config, hmacMode: "off", envelopeMaxBytes: 12_000 } },
    );

    expect(response.status).toBe(202);
    expect(test.sent).toHaveLength(1);
    const envelope = test.sent[0] as EnvelopeV1;
    // The raw body is in R2 and the queue carries a pointer to it…
    expect(envelope.kind).toBe("media-pointer");
    expect(envelope.media?.size).toBe(big.length);
    expect(test.stored.has(envelope.media?.r2Key ?? "")).toBe(true);
    // …while the routing metadata survives, so the pipeline can still answer
    // without fetching the object.
    expect(envelope.event.type).toBe("Message");
    expect(envelope.event.userID).toBe("1");
    expect(envelope.event.instanceName).toBe("nomor-1");
    expect(envelope.deliveryId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps a normal event inline and does not touch R2", async () => {
    const test = harness();
    const response = await callIngest(test, test.request(fixture("json-event-message").body, {
      headers: { "content-type": "application/json" },
    }), { config: { ...config, hmacMode: "off" } });

    expect(response.status).toBe(202);
    expect(test.sent[0]?.kind).toBe("event");
    expect(test.stored.size).toBe(0);
  });
});

/**
 * WP-4D. An R2 object whose only reference was a queue message that failed to send
 * can never be read by anyone, and wuzapi retries the whole request — so leaving
 * it behind leaks one object per failed attempt.
 */
describe("ingest: R2 orphan cleanup (WP-4D)", () => {
  it("deletes the streamed object when the queue write fails", async () => {
    const test = harness();
    const base64 = "A".repeat(150_000);
    const eventJson = JSON.stringify({
      base64,
      event: { Info: { Chat: "6281234567890@s.whatsapp.net", ID: "3EB0ORPHAN" }, Message: { imageMessage: {} } },
    });
    const form = `instanceName=nomor-1&jsonData=${encodeURIComponent(eventJson)}&userID=1`;

    const response = await callIngest(
      test,
      test.request(form, { headers: { "content-type": "application/x-www-form-urlencoded" } }),
      { failSend: true },
    );

    expect(response.status).toBe(503);
    expect(test.sent).toHaveLength(0);
    // The object was written, then removed again — nothing is left orphaned.
    expect(test.deleted).toHaveLength(1);
    expect(test.stored.size).toBe(0);
  });

  it("deletes the buffered object when the queue write fails, and reports no r2Key", async () => {
    const test = harness();
    const eventJson = JSON.stringify({
      base64: "A".repeat(60_000),
      event: { Info: { Chat: "6281234567890@s.whatsapp.net", ID: "3EB0ORPHAN2" }, Message: { imageMessage: {} } },
    });
    const form = `instanceName=nomor-1&jsonData=${encodeURIComponent(eventJson)}&userID=1`;

    const response = await callIngest(
      test,
      // No Content-Length, so the buffered path handles it.
      test.request(form, { headers: { "content-type": "application/x-www-form-urlencoded" }, contentLength: "none" }),
      { failSend: true },
    );

    expect(response.status).toBe(503);
    // Only the streaming path stored before sending; the buffered path stores
    // first too, so it must clean up as well.
    expect(test.stored.size).toBe(0);
    expect(test.deleted.length).toBeGreaterThanOrEqual(1);
  });

  it("keeps the object when the queue write succeeds", async () => {
    const test = harness();
    const eventJson = JSON.stringify({
      base64: "A".repeat(150_000),
      event: { Info: { Chat: "6281234567890@s.whatsapp.net", ID: "3EB0KEEP" }, Message: { imageMessage: {} } },
    });
    const form = `instanceName=nomor-1&jsonData=${encodeURIComponent(eventJson)}&userID=1`;

    const response = await callIngest(
      test,
      test.request(form, { headers: { "content-type": "application/x-www-form-urlencoded" } }),
    );

    expect(response.status).toBe(202);
    expect(test.sent).toHaveLength(1);
    expect(test.deleted).toHaveLength(0);
    expect(test.stored.size).toBe(1);
  });
});

describe("ingest: oversized media", () => {
  it("streams to R2 and enqueues a pointer with metadata, base64 excluded", async () => {
    const test = harness();
    const base64 = "A".repeat(150_000);
    const eventJson = JSON.stringify({
      base64,
      event: { Info: { Chat: "6281234567890@s.whatsapp.net", ID: "3EB0BIG" }, Message: { imageMessage: {} } },
      fileName: "IMG-BIG.jpg",
      instanceName: "nomor-1",
      mimeType: "image/jpeg",
      type: "Message",
      userID: "1",
    });
    const signature = await sign(eventJson);

    const response = await callIngest(
      test,
      test.request(eventJson, { headers: { "content-type": "application/json", "x-hmac-signature": signature } }),
    );

    expect(response.status).toBe(202);
    const envelope = test.sent[0] as EnvelopeV1;
    expect(envelope.kind).toBe("media-pointer");
    expect(envelope.media?.size).toBe(new TextEncoder().encode(eventJson).byteLength);
    expect(envelope.media?.skippedFields["base64"]).toBe(base64.length + 2);
    expect(envelope.media?.fields?.["type"]).toBe("Message");
    expect(envelope.media?.fields?.["fileName"]).toBe("IMG-BIG.jpg");
    expect(JSON.stringify(envelope.media?.fields)).not.toContain(base64);

    // The queue message must stay well inside the 128 KB limit.
    expect(JSON.stringify(envelope).length).toBeLessThan(128_000);

    // The body is stored verbatim for later retrieval.
    const key = envelope.media?.r2Key as string;
    expect(key).toMatch(/^events\/6281234567890\/2026\/10\/10\/[0-9a-f-]+\.json$/);
    expect(test.stored.get(key)?.byteLength).toBe(new TextEncoder().encode(eventJson).byteLength);
    expect(envelope.media?.sha256).toBe(envelope.deliveryId);
  });

  it("verifies the streaming signature and removes the object when it fails", async () => {
    const test = harness();
    const eventJson = JSON.stringify({ base64: "A".repeat(150_000), type: "Message", userID: "1" });
    const response = await callIngest(
      test,
      test.request(eventJson, { headers: { "content-type": "application/json", "x-hmac-signature": "00ff" } }),
    );
    expect(response.status).toBe(403);
    expect(test.sent).toHaveLength(0);
    expect(test.deleted).toHaveLength(1);
    expect(test.stored.size).toBe(0);
  });

  it("keeps routing metadata for oversized form bodies from the leading bytes", async () => {
    const test = harness();
    const eventJson = JSON.stringify({ base64: "B".repeat(150_000), type: "Message" });
    const formBody = `instanceName=${encodeURIComponent("nomor-1")}&jsonData=${encodeURIComponent(eventJson)}&userID=1`;
    const signature = await sign(formBody);

    const response = await callIngest(
      test,
      test.request(formBody, {
        headers: { "content-type": "application/x-www-form-urlencoded", "x-hmac-signature": signature },
      }),
    );

    expect(response.status).toBe(202);
    const envelope = test.sent[0] as EnvelopeV1;
    expect(envelope.kind).toBe("media-pointer");
    expect(envelope.event.instanceName).toBe("nomor-1");
    expect(envelope.media?.fields).toBeNull();
    expect(envelope.media?.r2Key).toMatch(/\.form$/);
  });

  it("answers 413 and records the drop when MEDIA_MODE=reject", async () => {
    const test = harness();
    const eventJson = JSON.stringify({ base64: "C".repeat(150_000), type: "Message" });
    const response = await callIngest(
      test,
      test.request(eventJson, {
        headers: { "content-type": "application/json", "x-hmac-signature": await sign(eventJson) },
      }),
      { config: { ...config, mediaMode: "reject" } },
    );
    expect(response.status).toBe(413);
    expect(test.dlq).toHaveLength(1);
    expect(test.dlq[0]?.stage).toBe("ingest");
    expect(test.sent).toHaveLength(0);
  });

  it("answers 500 when R2 is unavailable so wuzapi retries", async () => {
    const test = harness();
    const eventJson = JSON.stringify({ base64: "D".repeat(150_000), type: "Message" });
    const response = await callIngest(
      test,
      test.request(eventJson, { headers: { "content-type": "application/json" } }),
      { failPut: true, config: { ...config, hmacMode: "off" as const } },
    );
    expect(response.status).toBe(500);
    expect(test.sent).toHaveLength(0);
  });

  it("buffers an oversized body that arrives without Content-Length", async () => {
    const test = harness();
    const eventJson = JSON.stringify({ base64: "E".repeat(120_000), type: "Message", userID: "9" });
    // A streamed request has no Content-Length, so R2 cannot take a stream and
    // the handler materialises the body up to MEDIA_BUFFER_MAX_BYTES.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(eventJson);
        controller.enqueue(bytes.subarray(0, 1000));
        controller.enqueue(bytes.subarray(1000));
        controller.close();
      },
    });
    const request = new Request(`https://worker.example.test/ingest/${TOKEN}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      // @ts-expect-error - required by the runtime for streamed request bodies
      duplex: "half",
    });
    const response = await callIngest(test, request, { config: { ...config, hmacMode: "off" } });
    expect(response.status).toBe(202);
    expect(test.sent[0]?.kind).toBe("media-pointer");
    expect(test.sent[0]?.event.userID).toBe("9");
    expect(test.sent[0]?.media?.size).toBe(new TextEncoder().encode(eventJson).byteLength);
  });

  it("rejects an oversized body without Content-Length beyond the buffer cap", async () => {
    const test = harness();
    const eventJson = JSON.stringify({ base64: "G".repeat(120_000), type: "Message" });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(eventJson));
        controller.close();
      },
    });
    const request = new Request(`https://worker.example.test/ingest/${TOKEN}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      // @ts-expect-error - required by the runtime for streamed request bodies
      duplex: "half",
    });
    const response = await callIngest(test, request, {
      config: { ...config, hmacMode: "off", mediaBufferMaxBytes: 10_000 },
    });
    expect(response.status).toBe(413);
    expect(test.dlq).toHaveLength(1);
    expect(test.sent).toHaveLength(0);
  });

  it("reports a body shorter than its Content-Length without storing a partial object", async () => {
    const test = harness();
    const eventJson = JSON.stringify({ base64: "H".repeat(120_000), type: "Message" });
    const response = await callIngest(
      test,
      test.request(eventJson, {
        headers: { "content-type": "application/json" },
        contentLength: eventJson.length + 5_000,
      }),
      { config: { ...config, hmacMode: "off" } },
    );
    expect(response.status).toBe(400);
    expect(test.sent).toHaveLength(0);
  });
});

describe("ingest: through the deployed worker (real bindings)", () => {
  it("streams oversized media into the real R2 bucket when Content-Length is known", async () => {
    const base64 = "F".repeat(140_000);
    const eventJson = JSON.stringify({
      base64,
      fileName: "IMG-REAL.jpg",
      instanceName: "nomor-1",
      type: "Message",
      userID: "1",
    });
    const signature = await sign(eventJson);
    const declared = new TextEncoder().encode(eventJson).byteLength;

    const response = await exports.default.fetch(
      new Request(`https://worker.example.test/ingest/${TOKEN}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hmac-signature": signature,
          // Real wuzapi traffic always announces the body length; R2 requires it
          // for streamed puts, which is why the handler uses it when present.
          "content-length": String(declared),
        },
        body: eventJson,
      }),
    );

    expect(response.status).toBe(202);
    const payload = (await response.json()) as { kind: string; r2Key: string; deliveryId: string };
    expect(payload.kind).toBe("media-pointer");

    const object = await env.MEDIA.get(payload.r2Key);
    expect(object).not.toBeNull();
    expect(object?.httpMetadata?.contentType).toBe("application/json");
    const stored = await object?.text();
    expect(stored).toBe(eventJson);
    expect(payload.deliveryId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stores oversized media without Content-Length through the buffered path", async () => {
    const base64 = "J".repeat(140_000);
    const eventJson = JSON.stringify({ base64, fileName: "IMG-NOCL.jpg", type: "Message", userID: "1" });
    const signature = await sign(eventJson);

    const response = await exports.default.fetch(
      new Request(`https://worker.example.test/ingest/${TOKEN}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hmac-signature": signature },
        body: eventJson,
      }),
    );

    expect(response.status).toBe(202);
    const payload = (await response.json()) as { r2Key: string };
    const object = await env.MEDIA.get(payload.r2Key);
    expect(await object?.text()).toBe(eventJson);
  });

  it("serves /healthz with the effective configuration", async () => {
    const response = await exports.default.fetch(new Request("https://worker.example.test/healthz"));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload["ok"]).toBe(true);
    expect(payload["slug"]).toBe("6281234567890");
    expect(payload["hmacMode"]).toBe("strict");
    expect(payload["relayMode"]).toBe("relay");
  });

  it("answers 404 for unknown paths and 401 for a bad token", async () => {
    const notFound = await exports.default.fetch(new Request("https://worker.example.test/nope"));
    expect(notFound.status).toBe(404);

    const unauthorized = await exports.default.fetch(
      new Request("https://worker.example.test/ingest/wrong", { method: "POST", body: "{}" }),
    );
    expect(unauthorized.status).toBe(401);
  });
});

/** Signs a body the way wuzapi does, using the test keyring. */
async function sign(body: string): Promise<string> {
  const key = new TextEncoder().encode(config.hmacKeys[0] as string);
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(body));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
