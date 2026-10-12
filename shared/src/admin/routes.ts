/**
 * `/admin/*` — the operator surface.
 *
 * Every route is protected by `Authorization: Bearer <ADMIN_API_KEY>` and the
 * key is compared in constant time. An instance with no `ADMIN_API_KEY` set
 * answers 503 rather than leaving the routes open: an unauthenticated admin
 * surface on a public workers.dev URL is worse than a missing feature.
 *
 * The routes exist because a queue consumer cannot be poked by hand:
 *
 *   POST /admin/knowledge/sync       upload prompt/knowledge and rebuild the index
 *   POST /admin/contacts/sync        refresh contacts + the no_ai switches now
 *   POST /admin/chats/<jid>          switch one chat's bot on or off
 *   GET  /admin/orders/<kode>        read one order with items and payments
 *   POST /admin/orders/<kode>/approve  approve (optionally with an extra fee)
 *   POST /admin/orders/<kode>/reject   reject with a reason
 *   POST /admin/outbox/flush         flush the outbox now
 *   GET  /admin/status               counts + readiness, no secrets
 *
 * The order routes are also the fallback when `TELEGRAM_ENABLED=false`: the
 * approval machine is the same one the card drives, so the operator can work
 * without Telegram at all.
 */
import { botReadiness, type Env, type InstanceConfig } from "../config";
import { createLogger, type Logger } from "../lib/logger";
import { timingSafeEqualString } from "../lib/hmac";
import { invalidateCatalogCache } from "../bot/agent/run";
import { invalidateKnowledgeCache, loadKnowledge, loadOngkirPolicy } from "../bot/knowledge/loader";
import { invalidateChunkCache } from "../bot/knowledge/search";
import { syncKnowledgeIndex, writeKnowledgeStorage } from "../bot/knowledge/sync";
import { syncContacts } from "../bot/contacts/sync";
import { setChatEnabled } from "../bot/history";
import { WuzapiClient } from "../bot/wuzapi/client";
import { approveOrder, createCheckoutContext, rejectOrder } from "../bot/payment/checkout";
import { findOrderByKode, findPaymentForOrder, listOrderItems } from "../bot/payment/turso";
import { flushOutbox } from "../bot/outbox/flush";
import { outboxStats } from "../bot/outbox/store";
import type { OngkirPolicy } from "../bot/knowledge/catalog";
import type { CheckoutDeps } from "../bot/payment/checkout";

export interface AdminDeps extends CheckoutDeps {
  now?: () => Date;
  log?: Logger;
  /** Test seam for the WuzAPI client used by the contact sync. */
  client?: WuzapiClient;
  fetchImpl?: typeof fetch;
}

export interface AdminOptions {
  env: Env;
  config: InstanceConfig;
  deps?: AdminDeps;
}

const MAX_BODY_BYTES = 2_000_000;

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Constant-time bearer check; `null` means "carry on". */
async function authorize(request: Request, config: InstanceConfig): Promise<Response | null> {
  if (config.bot.adminApiKey === "") {
    return json(503, { error: "ADMIN_API_KEY is not configured on this worker" });
  }
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match || !(await timingSafeEqualString(match[1] ?? "", config.bot.adminApiKey))) {
    return json(401, { error: "invalid admin key" });
  }
  return null;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.trim() === "") return {};
  if (text.length > MAX_BODY_BYTES) throw new Error("request body is too large");
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** `POST /admin/knowledge/sync` */
async function syncKnowledge(request: Request, options: AdminOptions, log: Logger): Promise<Response> {
  const { env, config } = options;
  const db = env.BOT_DB;
  const body = await readJson(request);

  const prompt = asText(body["prompt"]);
  const knowledge = asText(body["knowledge"]);
  const policy = body["ongkirPolicy"];

  let storage: Awaited<ReturnType<typeof writeKnowledgeStorage>> | null = null;
  if (prompt !== undefined || knowledge !== undefined || policy !== undefined) {
    storage = await writeKnowledgeStorage(env, config, {
      ...(prompt === undefined ? {} : { prompt }),
      ...(knowledge === undefined ? {} : { knowledge }),
      ...(policy === undefined ? {} : { ongkirPolicy: policy }),
    });
  }

  // Everything downstream reads from storage, never from the request: that way
  // "what the sync indexed" is always "what the bot will read".
  const bundle = await loadKnowledge({ env, config, log, useCache: false });
  const storedPolicy = await loadOngkirPolicy(env, log);

  let index: Awaited<ReturnType<typeof syncKnowledgeIndex>> | null = null;
  if (db && bundle && bundle.knowledge !== "") {
    index = await syncKnowledgeIndex(db, bundle.knowledge, {
      source: "knowledge.txt",
      policy: (storedPolicy ?? null) as OngkirPolicy | null,
      at: (options.deps?.now?.() ?? new Date()).getTime(),
      log,
    });
  }

  invalidateKnowledgeCache();
  invalidateChunkCache();
  invalidateCatalogCache();

  log.info("admin_knowledge_sync", {
    wrote: storage?.written ?? [],
    target: storage?.target ?? null,
    chunks: index?.chunks ?? null,
    catalogProducts: index?.catalogProducts ?? null,
    fts: index?.fts ?? null,
  });

  return json(200, {
    ok: true,
    storage,
    index,
    bundle: bundle
      ? { source: bundle.source, mode: bundle.mode, bytes: bundle.bytes, sizes: bundle.sizes }
      : null,
    hint:
      bundle === null
        ? "no prompt/knowledge found in KV or R2; pass {prompt, knowledge} in the body or upload with pnpm run knowledge"
        : undefined,
  });
}

/** `POST /admin/contacts/sync` */
async function syncContactsRoute(options: AdminOptions, log: Logger): Promise<Response> {
  const { env, config } = options;
  if (!env.BOT_DB) return json(503, { error: "BOT_DB is not bound on this worker" });

  const client =
    options.deps?.client ??
    new WuzapiClient({
      baseUrl: config.bot.wuzapiApiBase,
      token: config.bot.wuzapiToken,
      deps: {
        log,
        ...(options.deps?.fetchImpl ? { fetchImpl: options.deps.fetchImpl } : {}),
      },
    });

  const result = await syncContacts(env.BOT_DB, client, {
    at: (options.deps?.now?.() ?? new Date()).getTime(),
    log,
  });
  return json(result.error === "" ? 200 : 502, { ok: result.error === "", ...result });
}

/** `POST /admin/chats/<jid>` with `{ "botEnabled": true|false }`. */
async function setChatRoute(request: Request, options: AdminOptions, jid: string, log: Logger): Promise<Response> {
  const { env } = options;
  if (!env.BOT_DB) return json(503, { error: "BOT_DB is not bound on this worker" });
  if (jid === "") return json(400, { error: "chat jid is required in the path" });

  const body = await readJson(request);
  const enabled = body["botEnabled"];
  if (typeof enabled !== "boolean") return json(400, { error: "botEnabled must be true or false" });

  const at = (options.deps?.now?.() ?? new Date()).getTime();
  await setChatEnabled(env.BOT_DB, jid, enabled, at);
  log.info("admin_chat_switch", { chatJid: jid, botEnabled: enabled });
  return json(200, { ok: true, chatJid: jid, botEnabled: enabled });
}

/** Builds the checkout context for the order routes (Turso from config or a test). */
function checkoutFor(options: AdminOptions, log: Logger) {
  const deps = options.deps ?? {};
  return createCheckoutContext({
    env: { BOT_DB: options.env.BOT_DB },
    config: options.config,
    deps: {
      ...(deps.sqlClient ? { sqlClient: deps.sqlClient } : {}),
      ...(deps.provider ? { provider: deps.provider } : {}),
      ...(deps.telegram ? { telegram: deps.telegram } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.wuzapi ? { wuzapi: deps.wuzapi } : {}),
      now: deps.now ?? (() => new Date()),
      log,
    },
  });
}

/** `GET /admin/orders/<kode>` */
async function readOrderRoute(options: AdminOptions, kode: string, log: Logger): Promise<Response> {
  const context = checkoutFor(options, log);
  if (!context.sql) return json(503, { error: "TURSO_DATABASE_URL is not configured" });

  const order = await findOrderByKode(context.sql, kode);
  if (!order) return json(404, { error: `order ${kode} not found` });

  const [items, payment] = await Promise.all([listOrderItems(context.sql, order.id), findPaymentForOrder(context.sql, order.id)]);
  const outbox = options.env.BOT_DB ? await outboxStats(options.env.BOT_DB) : null;
  return json(200, { ok: true, order, items, payment, outbox });
}

/** `POST /admin/orders/<kode>/approve` with optional `{ additionalFee, reason }`. */
async function approveOrderRoute(request: Request, options: AdminOptions, kode: string, log: Logger): Promise<Response> {
  const context = checkoutFor(options, log);
  if (!context.sql) return json(503, { error: "TURSO_DATABASE_URL is not configured" });

  const body = await readJson(request);
  const rawFee = body["additionalFee"];
  const additionalFee = typeof rawFee === "number" && Number.isFinite(rawFee) ? Math.trunc(rawFee) : undefined;
  const reason = typeof body["reason"] === "string" ? body["reason"] : undefined;

  const result = await approveOrder(context, {
    kodePesanan: kode,
    ...(additionalFee === undefined ? {} : { additionalFee }),
    ...(reason === undefined ? {} : { reason }),
    by: "admin-api",
  });

  // The customer is told through the outbox, so the message survives a wuzapi
  // outage and cannot be sent twice.
  const queued: boolean[] = [];
  if (result.ok && result.order) {
    for (const text of result.messages) {
      const sent = await queueAdminMessage(context, result.order.ref, result.order.waChatJid, text);
      queued.push(sent);
    }
  }

  log.info("admin_order_approved", { order: kode, ok: result.ok, additionalFee: additionalFee ?? null });
  return json(result.ok ? 200 : 409, {
    ok: result.ok,
    approved: result.approved,
    order: result.order,
    items: result.items,
    error: result.error,
    queued,
  });
}

/** `POST /admin/orders/<kode>/reject` with `{ reason }`. */
async function rejectOrderRoute(request: Request, options: AdminOptions, kode: string, log: Logger): Promise<Response> {
  const context = checkoutFor(options, log);
  if (!context.sql) return json(503, { error: "TURSO_DATABASE_URL is not configured" });

  const body = await readJson(request);
  const reason = typeof body["reason"] === "string" ? body["reason"] : "";
  const result = await rejectOrder(context, { kodePesanan: kode, reason, by: "admin-api" });

  const queued: boolean[] = [];
  if (result.order && result.messages.length > 0) {
    for (const text of result.messages) {
      queued.push(await queueAdminMessage(context, result.order.ref, result.order.waChatJid, text));
    }
  }

  log.info("admin_order_rejected", { order: kode, rejected: result.rejected });
  return json(result.error === "" ? 200 : 409, {
    ok: result.error === "",
    rejected: result.rejected,
    order: result.order,
    error: result.error,
    queued,
  });
}

/** Queues one customer message (dedupe key derived from the order + suffix). */
async function queueAdminMessage(
  context: ReturnType<typeof checkoutFor>,
  orderRef: string,
  chatJid: string,
  text: string,
): Promise<boolean> {
  const { queueCustomerMessage } = await import("../bot/payment/checkout");
  const result = await queueCustomerMessage(context, {
    orderRef,
    chatJid,
    text,
    dedupeSuffix: text.includes("Link pembayaran") || text.includes("http") ? "link" : "rejected",
  });
  return result.enqueued;
}

/** `POST /admin/outbox/flush` */
async function flushOutboxRoute(options: AdminOptions, log: Logger): Promise<Response> {
  const { env, config } = options;
  if (!env.BOT_DB) return json(503, { error: "BOT_DB is not bound on this worker" });

  const client =
    options.deps?.client ??
    new WuzapiClient({
      baseUrl: config.bot.wuzapiApiBase,
      token: config.bot.wuzapiToken,
      deps: {
        log,
        ...(options.deps?.fetchImpl ? { fetchImpl: options.deps.fetchImpl } : {}),
      },
    });

  const result = await flushOutbox({
    env: { BOT_DB: env.BOT_DB, CHAT_COORDINATOR: env.CHAT_COORDINATOR },
    config,
    client,
    log,
    now: options.deps?.now,
    limit: config.bot.outboxBatch,
    // An operator-triggered flush obeys the same gate as the cron: it is a way to
    // run the flush *now*, not a way to override the shadow switch. Forcing a
    // send while the number is degraded is exactly the accident this prevents.
    deliver: config.bot.mode === "on" && botReadiness(config, env).ready,
  });
  return json(200, { ok: true, ...result, stats: await outboxStats(env.BOT_DB) });
}

/** `GET /admin/status` — the operator's one-screen overview. */
async function statusRoute(options: AdminOptions, log: Logger): Promise<Response> {
  const { env, config } = options;
  const context = checkoutFor(options, log);
  const outbox = env.BOT_DB ? await outboxStats(env.BOT_DB) : null;

  let tables: string[] = [];
  let tursoError = "";
  if (context.sql) {
    try {
      const result = await context.sql.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
      tables = result.rows.map((row) => String(row["name"] ?? "")).filter((name) => name !== "");
    } catch (error) {
      tursoError = error instanceof Error ? error.message : String(error);
    }
  }

  return json(200, {
    ok: true,
    slug: config.slug,
    botMode: config.bot.mode,
    payment: {
      provider: context.provider.name,
      dryRun: context.provider.dryRun,
      tursoConfigured: context.sql !== null,
      tursoError,
      tables,
      publicBaseUrl: config.bot.publicBaseUrl !== "",
    },
    telegram: {
      enabled: config.bot.telegramEnabled,
      configured: context.telegram !== null,
      chatIdSet: config.bot.telegramChatId !== "",
      webhookSecretSet: config.bot.telegramWebhookSecret !== "",
    },
    outbox,
  });
}

/**
 * Router for `/admin/*`. Returns null when the path is not an admin route, so
 * the caller can keep looking.
 */
export async function handleAdmin(request: Request, pathname: string, options: AdminOptions): Promise<Response | null> {
  if (!pathname.startsWith("/admin/")) return null;

  const { config } = options;
  const log = options.deps?.log ?? createLogger({ slug: config.slug, handler: "admin" });

  const denied = await authorize(request, config);
  if (denied) return denied;

  const { deps, env } = options;
  const mounted: AdminOptions = { env, config, ...(deps ? { deps } : {}) };

  try {
    if (pathname === "/admin/knowledge/sync") {
      if (request.method !== "POST") return json(405, { error: "method not allowed" });
      return await syncKnowledge(request, mounted, log);
    }
    if (pathname === "/admin/contacts/sync") {
      if (request.method !== "POST") return json(405, { error: "method not allowed" });
      return await syncContactsRoute(mounted, log);
    }
    if (pathname.startsWith("/admin/chats/")) {
      if (request.method !== "POST") return json(405, { error: "method not allowed" });
      return await setChatRoute(request, mounted, decodeURIComponent(pathname.slice("/admin/chats/".length)), log);
    }
    if (pathname === "/admin/outbox/flush") {
      if (request.method !== "POST") return json(405, { error: "method not allowed" });
      return await flushOutboxRoute(mounted, log);
    }
    if (pathname === "/admin/status") {
      if (request.method !== "GET") return json(405, { error: "method not allowed" });
      return await statusRoute(mounted, log);
    }
    if (pathname.startsWith("/admin/orders/")) {
      const rest = pathname.slice("/admin/orders/".length);
      const segments = rest.split("/").filter((segment) => segment !== "");
      const kode = decodeURIComponent(segments[0] ?? "");
      if (segments.length === 1) {
        if (request.method !== "GET") return json(405, { error: "method not allowed" });
        return await readOrderRoute(mounted, kode, log);
      }
      if (segments.length === 2 && segments[1] === "approve") {
        if (request.method !== "POST") return json(405, { error: "method not allowed" });
        return await approveOrderRoute(request, mounted, kode, log);
      }
      if (segments.length === 2 && segments[1] === "reject") {
        if (request.method !== "POST") return json(405, { error: "method not allowed" });
        return await rejectOrderRoute(request, mounted, kode, log);
      }
      return json(404, { error: "not found" });
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.error("admin_failed", { path: pathname, error: detail });
    return json(400, { error: detail });
  }

  return json(404, { error: "not found" });
}
