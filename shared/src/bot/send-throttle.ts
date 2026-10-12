/**
 * The number-wide send throttle (work plan R7).
 *
 * WhatsApp rate-limits numbers that burst, and the limit applies to the *number*,
 * not to a code path — so the direct reply path (`deliverOutbound`) and the outbox
 * flusher (`flushOutbox`) have to draw from one bucket. That is why this lives in
 * its own module instead of inside `outbound.ts`: the flusher needs the same
 * primitive, and two copies of it would be two buckets.
 *
 * The bucket is a Durable Object keyed by `__rate__:<slug>`, so it is shared
 * across isolates and survives eviction, unlike an in-memory counter. It is not a
 * correctness boundary: a call that cannot reach the limiter is allowed through,
 * because refusing to answer a customer is worse than a burst.
 */
import type { Env, InstanceConfig } from "../config";
import type { Logger } from "../lib/logger";
import { rateLimiterFor } from "./coordinator/chat-lock";

/** Burst size; also the bucket capacity. */
export const RATE_CAPACITY = 30;
/** 0.5 tokens/second ≈ 30 messages/minute sustained. */
export const RATE_REFILL_PER_SECOND = 0.5;
/** How long a single send waits for a token before giving up to the caller. */
export const RATE_WAIT_ATTEMPTS = 3;
export const RATE_WAIT_MAX_MS = 5_000;

export interface SendThrottleOptions {
  env: Pick<Env, "CHAT_COORDINATOR">;
  config: InstanceConfig;
  log: Logger;
  /** Test seam; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits for a token. Returns false when the bucket stays empty, which the caller
 * turns into a retry rather than an unbounded wait inside the queue consumer or
 * the cron.
 */
export async function takeRateToken(options: SendThrottleOptions): Promise<boolean> {
  const { env, config, log } = options;
  const sleep = options.sleep ?? defaultSleep;

  const limiter = rateLimiterFor(env, config.slug);
  if (!limiter) return true;

  for (let attempt = 0; attempt < RATE_WAIT_ATTEMPTS; attempt++) {
    let payload: { allowed?: boolean; retryAfterMs?: number };
    try {
      const response = await limiter.fetch("https://coordinator/rate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          capacity: RATE_CAPACITY,
          refillPerSecond: RATE_REFILL_PER_SECOND,
          cost: 1,
        }),
      });
      payload = (await response.json()) as { allowed?: boolean; retryAfterMs?: number };
    } catch (error) {
      // A failing rate limiter must not stop the bot from answering; the token
      // bucket protects WhatsApp, it is not a correctness boundary.
      log.warn("rate_limit_unavailable", { error: String(error) });
      return true;
    }

    if (payload.allowed === true) return true;
    const waitMs = Math.min(Math.max(0, payload.retryAfterMs ?? 1_000), RATE_WAIT_MAX_MS);
    if (waitMs <= 0) continue;
    await sleep(waitMs);
  }

  log.warn("rate_limited", { capacity: RATE_CAPACITY, refillPerSecond: RATE_REFILL_PER_SECOND });
  return false;
}
