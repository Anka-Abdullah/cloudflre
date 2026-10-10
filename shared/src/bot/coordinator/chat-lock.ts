/**
 * ChatCoordinator — the per-number concurrency, idempotency and rate-limit
 * primitives that Cloudflare Queues alone cannot provide.
 *
 * Why a Durable Object at all:
 *
 *  - Cloudflare Queues gives at-least-once delivery, so two copies of the same
 *    webhook can be in flight at once. `processed_events` in D1 is the durable
 *    authority, but a per-chat lock stops the second copy from starting an AI
 *    turn while the first one is still writing its reply.
 *  - Two customers writing at the same second must not interleave their carts
 *    or their history reads, so every chat gets its own instance (its own
 *    single-threaded event loop).
 *  - WhatsApp punishes bursty senders, so one singleton instance per number
 *    holds a token bucket that every outbound send has to pass.
 *
 * Instance naming (see `coordinatorFor` / `rateLimiterFor`):
 *
 *    idFromName(chatJid)        → lock + seen-set + last activity for one chat
 *    idFromName("__rate__:<n>") → the number-wide token bucket
 *
 * The class speaks plain HTTP over `stub.fetch()` rather than RPC so the same
 * code path is exercised by miniflare in tests and by workerd in production.
 */
import type { Env } from "../../config";

/** How long a lock is held when the caller does not say. */
export const DEFAULT_LOCK_TTL_MS = 120_000;
/** How long a delivery id is remembered as "already handled". */
export const DEFAULT_SEEN_TTL_MS = 6 * 60 * 60 * 1_000;
/** Delivery ids kept per chat instance; the oldest are pruned above this. */
const MAX_SEEN_ENTRIES = 500;

export interface CoordinatorState {
  /** Epoch ms until which the chat is locked; 0 means free. */
  lockUntil: number;
  /** deliveryId → epoch ms when the entry may be forgotten. */
  seen: Record<string, number>;
  /** Token bucket state (only meaningful on the rate-limiter instance). */
  tokens: number;
  tokensAt: number;
  lastInboundAt: number;
  lastOutboundAt: number;
}

export interface ClaimRequest {
  deliveryId: string;
  lockTtlMs?: number;
}

export interface ClaimResponse {
  /** False when another worker holds a live lock; the caller should retry. */
  locked: boolean;
  /** True when this delivery id was already completed inside the seen window. */
  duplicate: boolean;
  lockUntil: number;
  /** Milliseconds until the lock frees; 0 when the caller owns it. */
  retryAfterMs: number;
}

export interface ReleaseRequest {
  deliveryId?: string;
  /** Remember the delivery id as handled (only after the work really finished). */
  rememberDelivery?: boolean;
  seenTtlMs?: number;
  direction?: "in" | "out";
  at?: number;
}

export interface RateRequest {
  /** Bucket size, i.e. the maximum burst. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
  /** Tokens this call consumes; defaults to 1. */
  cost?: number;
}

export interface RateResponse {
  allowed: boolean;
  tokens: number;
  /** Milliseconds to wait before retrying; 0 when allowed. */
  retryAfterMs: number;
}

function emptyState(): CoordinatorState {
  return { lockUntil: 0, seen: {}, tokens: 0, tokensAt: 0, lastInboundAt: 0, lastOutboundAt: 0 };
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export class ChatCoordinator {
  private readonly state: DurableObjectState;
  private data: CoordinatorState = emptyState();
  private readonly ready: Promise<void>;
  /** Promise chain that makes every request handler mutually exclusive. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
    // Loading inside blockConcurrencyWhile means no request observes the empty
    // state, so a cold start after eviction cannot hand out a second lock.
    this.ready = state.blockConcurrencyWhile(async () => {
      const stored = await state.storage.get<CoordinatorState>("state");
      if (stored) this.data = { ...emptyState(), ...stored, seen: { ...(stored.seen ?? {}) } };
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    return this.serialize(() => this.route(request));
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async route(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const now = Date.now();

    switch (path) {
      case "/claim":
        return await this.claim(request, now);
      case "/release":
        return await this.release(request, now);
      case "/rate":
        return await this.rate(request, now);
      case "/status":
        return json(200, { ...this.data });
      default:
        return json(404, { error: `unknown coordinator path ${path}` });
    }
  }

  private async body(request: Request): Promise<Record<string, unknown>> {
    try {
      const parsed = (await request.json()) as unknown;
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private async claim(request: Request, now: number): Promise<Response> {
    const input = await this.body(request);
    const deliveryId = typeof input["deliveryId"] === "string" ? input["deliveryId"] : "";
    const lockTtlMs = asNumber(input["lockTtlMs"], DEFAULT_LOCK_TTL_MS);

    const duplicate = deliveryId !== "" && (this.data.seen[deliveryId] ?? 0) > now;
    const locked = this.data.lockUntil <= now;

    if (locked) {
      this.data.lockUntil = now + lockTtlMs;
      this.data.lastInboundAt = now;
      await this.persist();
    }

    const response: ClaimResponse = {
      locked,
      duplicate,
      lockUntil: this.data.lockUntil,
      retryAfterMs: locked ? 0 : Math.max(1, this.data.lockUntil - now),
    };
    return json(200, { ...response });
  }

  private async release(request: Request, now: number): Promise<Response> {
    const input = await this.body(request);
    const deliveryId = typeof input["deliveryId"] === "string" ? input["deliveryId"] : "";
    const remember = input["rememberDelivery"] === true;
    const seenTtlMs = asNumber(input["seenTtlMs"], DEFAULT_SEEN_TTL_MS);

    this.data.lockUntil = 0;
    if (remember && deliveryId !== "") {
      this.data.seen[deliveryId] = now + seenTtlMs;
      this.pruneSeen(now);
    }
    if (input["direction"] === "out") this.data.lastOutboundAt = asNumber(input["at"], now);
    else if (input["direction"] === "in") this.data.lastInboundAt = asNumber(input["at"], now);

    await this.persist();
    return json(200, { ok: true, lockUntil: this.data.lockUntil });
  }

  private async rate(request: Request, now: number): Promise<Response> {
    const input = await this.body(request);
    const capacity = Math.max(1, asNumber(input["capacity"], 30));
    const refillPerSecond = Math.max(0.0001, asNumber(input["refillPerSecond"], 0.5));
    const cost = Math.max(0.0001, asNumber(input["cost"], 1));

    // A bucket that has never been touched starts full, so the first message
    // after a deploy is not delayed; refills are then computed lazily from the
    // last time this instance was touched.
    const available =
      this.data.tokensAt === 0
        ? capacity
        : Math.min(capacity, this.data.tokens + Math.max(0, (now - this.data.tokensAt) / 1000) * refillPerSecond);
    const allowed = available >= cost;
    this.data.tokens = allowed ? available - cost : available;
    this.data.tokensAt = now;

    const response: RateResponse = {
      allowed,
      tokens: this.data.tokens,
      retryAfterMs: allowed ? 0 : Math.ceil(((cost - available) / refillPerSecond) * 1000),
    };
    await this.persist();
    return json(200, { ...response });
  }

  private pruneSeen(now: number): void {
    const entries = Object.entries(this.data.seen);
    if (entries.length <= MAX_SEEN_ENTRIES) {
      for (const [key, expiry] of entries) if (expiry <= now) delete this.data.seen[key];
      return;
    }
    entries.sort((a, b) => a[1] - b[1]);
    for (const [key] of entries.slice(0, entries.length - MAX_SEEN_ENTRIES)) delete this.data.seen[key];
  }

  private async persist(): Promise<void> {
    await this.state.storage.put("state", this.data);
  }
}

/** Stable Durable Object id for one chat. */
export function coordinatorFor(env: Pick<Env, "CHAT_COORDINATOR">, chatJid: string): DurableObjectStub | null {
  if (!env.CHAT_COORDINATOR) return null;
  return env.CHAT_COORDINATOR.get(env.CHAT_COORDINATOR.idFromName(chatJid));
}

/** Stable Durable Object id for the number-wide token bucket. */
export function rateLimiterFor(env: Pick<Env, "CHAT_COORDINATOR">, slug: string): DurableObjectStub | null {
  if (!env.CHAT_COORDINATOR) return null;
  return env.CHAT_COORDINATOR.get(env.CHAT_COORDINATOR.idFromName(`__rate__:${slug}`));
}

async function post(stub: DurableObjectStub, path: string, body: unknown): Promise<unknown> {
  const response = await stub.fetch(`https://coordinator${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await response.json();
}

/**
 * Asks the chat instance for the lock.
 *
 * Returns null when the deployment has no CHAT_COORDINATOR binding, which the
 * caller treats as "no coordination available": the D1 idempotency claim is the
 * durable safety net, so the pipeline degrades to serialised-by-queue rather
 * than refusing to answer.
 */
export async function claimChat(
  env: Pick<Env, "CHAT_COORDINATOR">,
  chatJid: string,
  input: ClaimRequest,
): Promise<ClaimResponse | null> {
  const stub = coordinatorFor(env, chatJid);
  if (!stub) return null;
  return (await post(stub, "/claim", input)) as ClaimResponse;
}

export async function releaseChat(
  env: Pick<Env, "CHAT_COORDINATOR">,
  chatJid: string,
  input: ReleaseRequest,
): Promise<void> {
  const stub = coordinatorFor(env, chatJid);
  if (!stub) return;
  await post(stub, "/release", input);
}
