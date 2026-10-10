/**
 * Outbound delivery tests (FASE 6): the two protections that sit in front of
 * WhatsApp — the per-number token bucket and the human-like gap between the parts
 * of one reply — plus the shadow-mode rule that nothing leaves the worker.
 *
 * The bucket is a real Durable Object here (`CHAT_COORDINATOR`), so this test
 * fails if the wiring between `deliverOutbound` and the coordinator breaks, not
 * just if the arithmetic does.
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Env, type InstanceConfig } from "../src/config";
import { HUMAN_DELAY_MAX_MS, HUMAN_DELAY_MIN_MS, deliverOutbound, RATE_CAPACITY, RATE_REFILL_PER_SECOND } from "../src/bot/outbound";
import { rateLimiterFor } from "../src/bot/coordinator/chat-lock";
import type { OutboundMessage } from "../src/bot/types";
import type { WuzapiClient, WuzapiSendResult } from "../src/bot/wuzapi/client";
import { createLogger } from "../src/lib/logger";

const bindings = env as unknown as Env;
const baseConfig = loadConfig(bindings);
const quiet = createLogger({ handler: "test" }, () => {});
const CHAT = "628111@s.whatsapp.net";

function config(): InstanceConfig {
  return { ...baseConfig, bot: { ...baseConfig.bot, mode: "on" } };
}

/** A client that records sends and can be told to fail. */
function fakeClient(options: { fail?: boolean } = {}) {
  const sent: OutboundMessage[] = [];
  const client = {
    async sendText(_phone: string, body: string): Promise<WuzapiSendResult> {
      if (options.fail) return { ok: false, messageId: null, status: 500, error: "down", permanent: false, attempts: 1 };
      sent.push({ kind: "text", body });
      return { ok: true, messageId: `W-${sent.length}`, status: 200, error: "", permanent: false, attempts: 1 };
    },
  } as unknown as WuzapiClient;
  return { client, sent };
}

/**
 * The bucket is per (isolate, file) and starts full (`RATE_CAPACITY` = 30 tokens);
 * the tests below spend at most five of them, so no setup is needed — and no test
 * may *drain* the bucket, or it would fail its neighbours.
 */
beforeEach(() => {
  expect(RATE_CAPACITY).toBeGreaterThan(10);
});

describe("shadow mode", () => {
  it("sends nothing but reports what would have been sent", async () => {
    const { client, sent } = fakeClient();
    const outcome = await deliverOutbound(
      { env: bindings, config: config(), client, log: quiet, deliver: false },
      CHAT,
      [{ kind: "text", body: "halo" }],
    );

    expect(outcome).toEqual({ sent: 0, suppressed: true, failures: [] });
    expect(sent).toHaveLength(0);
  });
});

describe("human-like pacing", () => {
  it("waits 1–3 seconds between the parts of one reply, never before the first", async () => {
    const { client, sent } = fakeClient();
    const sleeps: number[] = [];
    const outcome = await deliverOutbound(
      {
        env: bindings,
        config: config(),
        client,
        log: quiet,
        deliver: true,
        sleep: async (ms) => void sleeps.push(ms),
        random: () => 0.5,
      },
      CHAT,
      [
        { kind: "text", body: "satu" },
        { kind: "text", body: "dua" },
        { kind: "text", body: "tiga" },
      ],
    );

    expect(outcome.sent).toBe(3);
    expect(sent).toHaveLength(3);
    // Two gaps for three messages, each inside the documented window.
    expect(sleeps).toHaveLength(2);
    for (const ms of sleeps) {
      expect(ms).toBeGreaterThanOrEqual(HUMAN_DELAY_MIN_MS);
      expect(ms).toBeLessThanOrEqual(HUMAN_DELAY_MAX_MS);
    }
  });
});

describe("token bucket", () => {
  it("passes through the real Durable Object rate limiter", async () => {
    const { client, sent } = fakeClient();
    const outcome = await deliverOutbound(
      { env: bindings, config: config(), client, log: quiet, deliver: true, sleep: async () => {} },
      CHAT,
      [{ kind: "text", body: "halo" }],
    );

    expect(outcome.sent).toBe(1);
    expect(sent).toHaveLength(1);

    const limiter = rateLimiterFor(bindings, baseConfig.slug);
    const status = await limiter!.fetch("https://coordinator/rate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capacity: RATE_CAPACITY, refillPerSecond: RATE_REFILL_PER_SECOND, cost: 0 }),
    });
    const bucket = (await status.json()) as { tokens: number };
    // The send consumed a token: the bucket is no longer at capacity.
    expect(bucket.tokens).toBeLessThan(RATE_CAPACITY);
  });

  it("keeps sending when the limiter is unavailable", async () => {
    // No CHAT_COORDINATOR binding: the bucket protects WhatsApp, it is not a
    // correctness boundary, so a missing binding must not stop the bot.
    const { client, sent } = fakeClient();
    const outcome = await deliverOutbound(
      { env: { ...bindings, CHAT_COORDINATOR: undefined } as unknown as Env, config: config(), client, log: quiet, deliver: true, sleep: async () => {} },
      CHAT,
      [{ kind: "text", body: "halo" }],
    );
    expect(outcome.sent).toBe(1);
    expect(sent).toHaveLength(1);
  });
});

describe("failures", () => {
  it("reports a per-message failure instead of throwing", async () => {
    const { client } = fakeClient({ fail: true });
    const outcome = await deliverOutbound(
      { env: bindings, config: config(), client, log: quiet, deliver: true, sleep: async () => {} },
      CHAT,
      [{ kind: "text", body: "halo" }],
    );

    expect(outcome.sent).toBe(0);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]).toMatchObject({ error: "down", permanent: false });
  });
});
