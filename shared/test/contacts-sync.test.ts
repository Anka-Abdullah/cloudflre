/**
 * FASE 4 acceptance tests: contact sync, the `no_ai` switch, the cron claim and
 * the `/admin/*` routes.
 *
 * Everything runs against the real D1 binding and the real Worker entry point
 * (`createWorker()`), because the two failure modes that matter here are both
 * database-shaped:
 *
 *  - a sync that re-enables a chat an admin switched off (or, worse, re-enables
 *    a suppressed one) is a privacy bug, not a cosmetic one;
 *  - an admin route that answers without a valid bearer key is an open door on a
 *    public URL.
 */
import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Env } from "../src/config";
import { resolveChatPolicy } from "../src/bot/contacts/policy";
import { isDirectChatJid, syncContacts } from "../src/bot/contacts/sync";
import { claimIntervalJob, runCronJobs } from "../src/cron";
import { createLogger } from "../src/lib/logger";
import { requestUrl, setFetchStub } from "./helpers";

const bindings = env as unknown as { BOT_DB: D1Database };
const db = bindings.BOT_DB;
const config = loadConfig(env as unknown as Env);
const quiet = createLogger({ handler: "test" }, () => {});
const CHAT = "628111@s.whatsapp.net";
const OTHER = "628222@s.whatsapp.net";

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM contacts"),
    db.prepare("DELETE FROM chat_state"),
    db.prepare("DELETE FROM suppressed_chats"),
    db.prepare("DELETE FROM cron_state"),
  ]);
});

/** A wuzapi `/user/contacts` payload shaped exactly like the real one. */
function contactsResponse(entries: Record<string, Record<string, unknown>>) {
  return async () => ({ ok: true, contacts: entries, error: "" });
}

/**
 * Replaces the outbound fetch for the duration of one test.
 *
 * The WuzapiClient resolves `fetch` when it is constructed inside the route, and
 * `worker-entry.ts` routes that through the same global stub — so this is the
 * production seam, not a monkey patch around the code under test.
 */
const withFetchStub = async (
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  run: () => Promise<void>,
): Promise<void> => {
  const restore = setFetchStub(handler);
  try {
    await run();
  } finally {
    restore();
  }
};

describe("syncContacts", () => {
  it("stores the four name fields and switches the bot off for no_ai", async () => {
    const result = await syncContacts(db, null, {
      at: 1_000,
      log: quiet,
      fetchContacts: contactsResponse({
        [CHAT]: { FullName: "Budi no_ai", FirstName: "Budi", PushName: "budi", BusinessName: "" },
        [OTHER]: { FullName: "Siti", FirstName: "Siti", PushName: "siti", BusinessName: "Toko Siti" },
      }),
    });

    expect(result).toMatchObject({ fetched: 2, upserted: 2, disabled: 1, enabled: 0, error: "" });

    const row = await db
      .prepare("SELECT full_name, first_name, push_name, business_name, has_no_ai FROM contacts WHERE chat_jid = ?")
      .bind(CHAT)
      .first<Record<string, unknown>>();
    expect(row).toEqual({
      full_name: "Budi no_ai",
      first_name: "Budi",
      push_name: "budi",
      business_name: "",
      has_no_ai: 1,
    });

    expect(await resolveChatPolicy(db, { chatJid: CHAT, pushName: "Budi" })).toEqual({
      allowed: false,
      reason: "no_ai_contact",
    });
    expect(await resolveChatPolicy(db, { chatJid: OTHER, pushName: "Siti" })).toEqual({ allowed: true, reason: null });
  });

  it("re-enables the chat when the marker is removed from the name", async () => {
    const marked = contactsResponse({ [CHAT]: { FullName: "Budi no_ai" } });
    await syncContacts(db, null, { at: 1, log: quiet, fetchContacts: marked });

    const cleaned = contactsResponse({ [CHAT]: { FullName: "Budi" } });
    const result = await syncContacts(db, null, { at: 2, log: quiet, fetchContacts: cleaned });

    expect(result).toMatchObject({ disabled: 0, enabled: 1 });
    expect(await resolveChatPolicy(db, { chatJid: CHAT, pushName: "Budi" })).toEqual({ allowed: true, reason: null });
  });

  it("detects the marker case-insensitively on any field", async () => {
    await syncContacts(db, null, {
      at: 1,
      log: quiet,
      fetchContacts: contactsResponse({ [CHAT]: { BusinessName: "Toko NO_AI 2" } }),
    });
    const row = await db.prepare("SELECT has_no_ai FROM contacts WHERE chat_jid = ?").bind(CHAT).first<{ has_no_ai: number }>();
    expect(row?.has_no_ai).toBe(1);
  });

  it("leaves an admin's switch alone when the contact did not change", async () => {
    const same = contactsResponse({ [CHAT]: { FullName: "Budi" } });
    await syncContacts(db, null, { at: 1, log: quiet, fetchContacts: same });

    // The admin turns the bot off by hand (POST /admin/chats/<jid>).
    await db.prepare("UPDATE chat_state SET bot_enabled = 0 WHERE chat_jid = ?").bind(CHAT).run();

    const second = await syncContacts(db, null, { at: 2, log: quiet, fetchContacts: same });
    expect(second).toMatchObject({ disabled: 0, enabled: 0 });
    const state = await db.prepare("SELECT bot_enabled FROM chat_state WHERE chat_jid = ?").bind(CHAT).first<{ bot_enabled: number }>();
    expect(state?.bot_enabled).toBe(0);
  });

  it("never revives a manually suppressed chat", async () => {
    await db
      .prepare("INSERT INTO suppressed_chats (chat_jid, reason, permanent, created_at) VALUES (?, 'opt-out', 1, 1)")
      .bind(CHAT)
      .run();

    await syncContacts(db, null, { at: 2, log: quiet, fetchContacts: contactsResponse({ [CHAT]: { FullName: "Budi" } }) });
    const state = await db.prepare("SELECT bot_enabled FROM chat_state WHERE chat_jid = ?").bind(CHAT).first<{ bot_enabled: number }>();
    expect(state?.bot_enabled).toBe(0);
    expect(await resolveChatPolicy(db, { chatJid: CHAT, pushName: "Budi" })).toEqual({
      allowed: false,
      reason: "suppressed",
    });
  });

  it("skips groups, newsletters and broadcasts", async () => {
    expect(isDirectChatJid("628111@s.whatsapp.net")).toBe(true);
    expect(isDirectChatJid("123-456@g.us")).toBe(false);
    expect(isDirectChatJid("123@newsletter")).toBe(false);
    expect(isDirectChatJid("status@broadcast")).toBe(false);
    expect(isDirectChatJid("")).toBe(false);

    const result = await syncContacts(db, null, {
      at: 1,
      log: quiet,
      fetchContacts: contactsResponse({
        [CHAT]: { FullName: "Budi" },
        "123-456@g.us": { FullName: "Grup no_ai" },
        "999@newsletter": { FullName: "Kanal" },
      }),
    });
    expect(result).toMatchObject({ fetched: 3, upserted: 1, skipped: 2 });
  });

  it("reports a wuzapi failure instead of throwing", async () => {
    const result = await syncContacts(db, null, {
      at: 1,
      log: quiet,
      fetchContacts: async () => ({ ok: false, contacts: {}, error: "ECONNREFUSED" }),
    });
    expect(result).toMatchObject({ upserted: 0, error: "ECONNREFUSED" });
  });

  it("reports a missing client as a structured error", async () => {
    const result = await syncContacts(db, null, { at: 1, log: quiet });
    expect(result.error).toContain("not configured");
  });

  it("treats a malformed contact entry as skipped, not as a crash", async () => {
    const result = await syncContacts(db, null, {
      at: 1,
      log: quiet,
      fetchContacts: async () => ({ ok: true, contacts: { [CHAT]: "bukan objek" as unknown }, error: "" }),
    });
    expect(result).toMatchObject({ fetched: 1, upserted: 0, skipped: 1 });
  });
});

describe("cron claims", () => {
  it("runs an interval job once per interval, not once per minute", async () => {
    const first = await claimIntervalJob(db, "contact_sync", 10, 1_000);
    expect(first).toBe(true);
    // 5 minutes later the job is not due yet.
    expect(await claimIntervalJob(db, "contact_sync", 10, 1_000 + 5 * 60_000)).toBe(false);
    // 10 minutes later it is.
    expect(await claimIntervalJob(db, "contact_sync", 10, 1_000 + 10 * 60_000)).toBe(true);
  });

  it("lets --force bypass the interval", async () => {
    expect(await claimIntervalJob(db, "contact_sync", 10, 1_000)).toBe(true);
    expect(await claimIntervalJob(db, "contact_sync", 10, 1_001, true)).toBe(true);
  });

  /** Config with no Turso: these tests are about the contact-sync interval. */
  const noTurso = { ...config, bot: { ...config.bot, tursoDatabaseUrl: "", tursoAuthToken: "" } };

  it("runs the contact sync through runCronJobs and reuses the interval", async () => {
    const fetches: number[] = [];
    const deps = {
      now: () => new Date(60_000),
      log: quiet,
      client: { getContacts: async () => (fetches.push(1), { ok: true, contacts: { [CHAT]: { FullName: "Budi" } }, error: "" }) },
    } as unknown as Parameters<typeof runCronJobs>[0]["deps"];

    const first = await runCronJobs({ env: env as unknown as Env, config: noTurso, deps });
    expect((first.jobs["contact_sync"] as { upserted?: number }).upserted).toBe(1);

    const second = await runCronJobs({ env: env as unknown as Env, config: noTurso, deps });
    expect(second.jobs["contact_sync"]).toEqual({ skipped: "not_due" });
    expect(fetches).toHaveLength(1);
  });

  it("does not let a failing job cancel the others", async () => {
    const deps = {
      now: () => new Date(120_000),
      log: quiet,
      client: {
        getContacts: async () => {
          throw new Error("wuzapi down");
        },
      },
    } as unknown as Parameters<typeof runCronJobs>[0]["deps"];

    const result = await runCronJobs({ env: env as unknown as Env, config: noTurso, deps });
    expect(result.jobs["contact_sync"]).toEqual({ skipped: "wuzapi down" });
    expect(result.jobs["prune_history"]).toBeDefined();
  });
});

describe("/admin routes", () => {
  const key = config.bot.adminApiKey;

  async function post(path: string, body: unknown, authorization?: string): Promise<Response> {
    return await SELF.fetch(`https://worker.example.com${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization === undefined ? {} : { authorization }),
      },
      body: JSON.stringify(body ?? {}),
    });
  }

  it("refuses a missing or wrong bearer key", async () => {
    expect((await post("/admin/contacts/sync", {})).status).toBe(401);
    expect((await post("/admin/contacts/sync", {}, "Bearer salah")).status).toBe(401);
    expect((await post("/admin/contacts/sync", {}, "Basic abc")).status).toBe(401);
  });

  it("refuses a non-POST method", async () => {
    const response = await SELF.fetch("https://worker.example.com/admin/contacts/sync", {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(response.status).toBe(405);
  });

  it("syncs contacts over HTTP and flips the no_ai switch", async () => {
    // The route builds its own WuzapiClient, so the outbound call is intercepted
    // at `globalThis.fetch` — the client binds the global on purpose (workerd
    // rejects an unbound `fetch` call), which makes this stub the exact seam
    // production uses.
    await withFetchStub(async (input) => {
      if (!requestUrl(input).endsWith("/user/contacts")) return new Response("not found", { status: 404 });
      return new Response(
        JSON.stringify({ code: 200, success: true, data: { [CHAT]: { FullName: "Budi no_ai", PushName: "budi" } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }, async () => {
      const response = await post("/admin/contacts/sync", {}, `Bearer ${key}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean; upserted: number; disabled: number };
      expect(body).toMatchObject({ ok: true, upserted: 1, disabled: 1 });
    });

    expect(await resolveChatPolicy(db, { chatJid: CHAT, pushName: "budi" })).toEqual({
      allowed: false,
      reason: "no_ai_contact",
    });
  });

  it("reports a failed wuzapi call as a 502 instead of crashing", async () => {
    await withFetchStub(
      async () =>
        new Response(JSON.stringify({ code: 401, success: false, error: "not authorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      async () => {
        const response = await post("/admin/contacts/sync", {}, `Bearer ${key}`);
        expect(response.status).toBe(502);
        const body = (await response.json()) as { ok: boolean; error: string };
        expect(body.ok).toBe(false);
        expect(body.error).toContain("not authorized");
      },
    );
  });

  it("writes a knowledge bundle and rebuilds the index", async () => {
    const knowledge = [
      "#01  Kaos Polos",
      "  Template ID    : 100370",
      "  Harga          : Rp 75.000,00",
      "  Ongkir         : termasuk",
    ].join("\n");

    const response = await post(
      "/admin/knowledge/sync",
      { prompt: "Kamu adalah admin toko.", knowledge },
      `Bearer ${key}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      storage: { written: string[]; target: string };
      index: { chunks: number; catalogProducts: number; fts: boolean };
      bundle: { bytes: number };
    };

    expect(body.storage.target).toBe("kv");
    expect(body.storage.written).toContain("knowledge/knowledge.txt");
    expect(body.index.fts).toBe(true);
    expect(body.index.chunks).toBeGreaterThan(0);
    expect(body.index.catalogProducts).toBe(1);

    const chunk = await db
      .prepare("SELECT content FROM knowledge_chunks WHERE source = 'knowledge.txt' LIMIT 1")
      .first<{ content: string }>();
    expect(chunk?.content).toContain("Kaos Polos");

    const product = await db
      .prepare("SELECT kode, harga, ongkir_included FROM catalog_products WHERE kode = ?")
      .bind("100370")
      .first<{ kode: string; harga: number; ongkir_included: number }>();
    expect(product).toEqual({ kode: "100370", harga: 75_000, ongkir_included: 1 });

    // The FTS5 table is external-content over knowledge_chunks, so a MATCH must
    // find what the sync just wrote.
    const hit = await db
      .prepare("SELECT rowid FROM knowledge_fts WHERE knowledge_fts MATCH ?")
      .bind('"kaos"')
      .first<{ rowid: number }>();
    expect(hit?.rowid).toBeGreaterThan(0);
  });

  it("switches one chat on and off", async () => {
    const jid = encodeURIComponent(CHAT);
    expect((await post(`/admin/chats/${jid}`, { botEnabled: false }, `Bearer ${key}`)).status).toBe(200);
    expect(await resolveChatPolicy(db, { chatJid: CHAT, pushName: "Budi" })).toEqual({
      allowed: false,
      reason: "bot_disabled",
    });

    expect((await post(`/admin/chats/${jid}`, { botEnabled: true }, `Bearer ${key}`)).status).toBe(200);
    expect(await resolveChatPolicy(db, { chatJid: CHAT, pushName: "Budi" })).toEqual({ allowed: true, reason: null });
  });

  it("rejects an unknown admin path and an invalid body", async () => {
    expect((await post("/admin/tidak-ada", {}, `Bearer ${key}`)).status).toBe(404);
    expect((await post("/admin/chats/", { botEnabled: "yes" }, `Bearer ${key}`)).status).toBe(400);
  });
});
