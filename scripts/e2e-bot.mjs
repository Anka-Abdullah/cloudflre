#!/usr/bin/env node
/**
 * `pnpm run e2e [-- --number <nomor>]`
 *
 * The FASE 8 acceptance run: the real Worker (via `wrangler dev`), the real queue,
 * the real D1/KV/R2/Durable Object, the real `@libsql/client` — and *mocked third
 * parties* only (wuzapi, Telegram, the AI endpoint, Turso).
 *
 * What it proves, from the work order:
 *
 *   1. a 1:1 message reaches the AI and exactly one reply leaves through wuzapi
 *      (with the typing indicator around it);
 *   2. a duplicated webhook produces one reply, not two;
 *   3. a contact named `no_ai` is never answered;
 *   4. checkout works end to end with no WhatsApp number and no Sumopod account:
 *      cart → order → Telegram approval card → "Terima" → payment link → dry-run
 *      payment → order `paid` → receipt PDF sent as a document.
 *
 * Everything runs locally: `wrangler dev` simulates queues, D1, KV, R2 and Durable
 * Objects, `scripts/mock-services.mjs` answers as the three APIs, and
 * `scripts/mock-turso.mjs` speaks the libSQL protocol over a local SQLite file.
 * No Cloudflare account, no credentials, no pairing.
 */
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { cacheDir, cloudflareRoot, listInstances, logsDir, readWranglerConfig, registryDir, stateDir, stripAnsi } from "./lib.mjs";

const WORKER_PORT = 8791;
const MOCK_PORT = 8898;
const TURSO_PORT = 8899;
const WORKER_URL = `http://127.0.0.1:${WORKER_PORT}`;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`;
const TURSO_URL = `http://127.0.0.1:${TURSO_PORT}`;
const E2E_DIR = join(cloudflareRoot, ".wrangler", "e2e");
const E2E_STATE = join(E2E_DIR, "state");

const INGEST_TOKEN = "e2e-ingest-token-0123456789";
const HMAC_KEY = "e2e-hmac-key-0123456789abcdef";
const WUZAPI_TOKEN = "e2e-wuzapi-token";
const AI_API_KEY = "e2e-ai-key";
const ADMIN_API_KEY = "e2e-admin-key";
const TELEGRAM_TOKEN = "e2e-telegram-token";
const TELEGRAM_CHAT_ID = "-100999";
const TELEGRAM_SECRET = "e2e-telegram-secret";

const CUSTOMER = "628111222333@s.whatsapp.net";
const NO_AI_CHAT = "628555666777@s.whatsapp.net";

const PROMPT = [
  "Kamu adalah admin toko online yang ramah dan singkat.",
  "Gunakan katalog untuk menjawab harga. Jangan mengarang produk.",
  "Kalau pelanggan mau membeli, tambahkan ke keranjang lalu buat link pembayaran dengan tool create_payment_link.",
].join("\n");

/** Fixture catalogue: one product with ongkir included, one without. */
const KNOWLEDGE = [
  "#01  Kaos Polos Cotton Combed 30s",
  "  SKU/Code       : (tidak ada kode eksplisit di nama produk)",
  "  Template ID    : 100370",
  "  Harga          : Rp 75.000,00",
  "  Ongkir         : termasuk",
  "",
  "#02  CASTELLI ENTRATA SHORT BLACK 010 SIZE XL",
  "  SKU/Code       : G 4520009",
  "  Template ID    : 116964",
  "  Harga          : Rp 1.400.000,00",
].join("\n");

const results = [];

function pass(name, detail = "") {
  results.push({ name, ok: true, detail });
  process.stdout.write(`  PASS  ${name}${detail ? ` — ${detail}` : ""}\n`);
}

function fail(name, detail) {
  results.push({ name, ok: false, detail });
  process.stdout.write(`  FAIL  ${name} — ${detail}\n`);
}

function check(name, condition, detail = "") {
  if (condition) pass(name, detail);
  else fail(name, detail);
  return condition;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls until `predicate` returns a truthy value or the timeout expires.
 *
 * A predicate that throws (connection refused while a mock is still booting, a
 * 404 from a route that is not up yet) is treated as "not ready", not as a
 * failure: waiting is the whole point of this helper.
 */
async function waitFor(label, predicate, timeoutMs = 20_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `timeout waiting for ${label} (last: ${JSON.stringify(last)?.slice(0, 200)}${lastError ? `, error: ${lastError}` : ""})`,
  );
}

function startProcess(label, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? cloudflareRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      // Same repository-local wrangler paths as scripts/lib.mjs: the defaults live
      // under $HOME, which is not writable in a sandboxed run (EPERM on the
      // registry file, which looks nothing like a sandbox error).
      WRANGLER_LOG_PATH: join(logsDir, "e2e-wrangler.log"),
      WRANGLER_REGISTRY_PATH: registryDir,
      WRANGLER_CACHE_DIR: cacheDir,
      WRANGLER_SEND_METRICS: "false",
      ...(options.env ?? {}),
    },
  });
  child.stdout.on("data", (chunk) => {
    if (options.verbose) process.stdout.write(`[${label}] ${chunk}`);
  });
  child.stderr.on("data", (chunk) => {
    const text = stripAnsi(chunk.toString());
    if (options.verbose || /error|Error|failed/.test(text)) process.stdout.write(`[${label}] ${text}`);
  });
  return child;
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

/** One signed wuzapi webhook, exactly as `simulate-webhook.mjs` builds it. */
function webhookBody({ chat, text, pushName, id }) {
  return JSON.stringify({
    type: "Message",
    event: {
      Info: {
        Chat: chat,
        Sender: chat,
        ID: id,
        IsFromMe: false,
        IsGroup: false,
        PushName: pushName,
        Timestamp: new Date().toISOString(),
        Type: "text",
      },
      Message: { conversation: text },
    },
    userID: "1",
    instanceName: "e2e",
  });
}

async function sendWebhook(body) {
  const signature = createHmac("sha256", HMAC_KEY).update(body).digest("hex");
  return await fetchJson(`${WORKER_URL}/ingest/${INGEST_TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hmac-signature": signature },
    body,
  });
}

async function mockCalls(service) {
  const { body } = await fetchJson(`${MOCK_URL}/__calls?service=${service}`);
  return body.calls ?? [];
}

async function setAiScript(steps) {
  await fetchJson(`${MOCK_URL}/__script`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ steps }),
  });
}

async function resetMocks() {
  await fetchJson(`${MOCK_URL}/__reset`, { method: "POST" });
}

function textSends(calls, chat) {
  return calls.filter(
    (call) => call.url.includes("/chat/send/text") && (chat === undefined || call.body?.Phone === chat),
  );
}

function documentSends(calls, chat) {
  return calls.filter(
    (call) => call.url.includes("/chat/send/document") && (chat === undefined || call.body?.Phone === chat),
  );
}

function telegramMessages(calls, needle) {
  return calls.filter((call) => call.url.includes("/sendMessage") && String(call.body?.text ?? "").includes(needle));
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function pickInstance(argv) {
  const index = argv.indexOf("--number");
  if (index !== -1) return argv[index + 1];
  const instances = await listInstances();
  if (instances.length === 0) throw new Error("no instance folder found; run pnpm run new first");
  return instances[0];
}

/**
 * Writes a self-contained wrangler config for the E2E run.
 *
 * It is a copy of the instance's config with three changes: every third party
 * points at a mock, the worker is named `-e2e` (so local state and queues cannot
 * collide with a real deployment), and the secrets live in a `.dev.vars` next to
 * this file — inside `.wrangler/`, which is git-ignored.
 */
async function writeE2eProject(slug, config) {
  await mkdir(join(E2E_DIR, "knowledge"), { recursive: true });
  const mainPath = relative(E2E_DIR, join(cloudflareRoot, slug, "src", "index.ts"));
  const migrationsDir = relative(E2E_DIR, join(cloudflareRoot, "shared", "src", "bot", "migrations"));

  const vars = {
    INSTANCE_SLUG: slug,
    INLINE_MAX_BYTES: "90000",
    MEDIA_BUFFER_MAX_BYTES: "25000000",
    SCAN_MAX_FIELD_BYTES: "262144",
    HMAC_MODE: "strict",
    MEDIA_MODE: "r2",
    RELAY_MODE: "relay",
    RETRY_BASE_SECONDS: "2",
    RETRY_MAX_SECONDS: "30",
    DOWNSTREAM_URL: "",
    R2_PUBLIC_BASE_URL: "",
    DLQ_QUEUE_NAME: `wuzapi-${slug}-e2e-dlq`,

    BOT_MODE: "on",
    WUZAPI_API_BASE: `${MOCK_URL}/wuzapi`,
    AI_BASE_URL: `${MOCK_URL}/ai/v1`,
    AI_MODEL: "mock-model",
    AI_TIMEOUT_MS: "20000",
    AI_MAX_TURNS: "4",
    AI_MAX_TOKENS: "1024",
    AI_TOOLS_MODE: "native",
    AI_JSON_FALLBACK: "true",
    KNOWLEDGE_MODE: "kv_inline",
    KNOWLEDGE_INLINE_MAX_BYTES: "1048576",
    KNOWLEDGE_TOP_K: "3",
    KNOWLEDGE_HISTORY_LIMIT: "10",
    CONTACT_SYNC_INTERVAL_MINUTES: "0",
    PAYMENT_PROVIDER: "sumopod",
    PAYMENT_API_BASE: "",
    PAYMENT_CREATE_PATH: "/v1/payments",
    PAYMENT_STATUS_PATH: "/v1/payments/{ref}",
    PAYMENT_EXPIRES_HOURS: "24",
    PAYMENT_DRY_RUN: "true",
    TELEGRAM_ENABLED: "true",
    TELEGRAM_API_BASE: `${MOCK_URL}/telegram`,
    PUBLIC_BASE_URL: WORKER_URL,
    BOT_MAX_ITEMS: "20",
    BOT_MAX_ITEM_QTY: "99",
    OUTBOX_BATCH: "20",
    OUTBOX_LEASE_SECONDS: "120",
    OUTBOX_MAX_ATTEMPTS: "6",
    RETRY_UNREPLIED_MINUTES: "0",
    RECONCILE_INTERVAL_MINUTES: "1",
    VOICE_ENABLED: "false",
  };

  const e2eConfig = {
    $schema: relative(E2E_DIR, join(cloudflareRoot, "node_modules", "wrangler", "config-schema.json")),
    name: `wuzapi-${slug}-e2e`,
    main: mainPath,
    compatibility_date: config.compatibility_date ?? "2026-10-10",
    observability: { enabled: false },
    vars,
    triggers: { crons: ["*/1 * * * *"] },
    queues: {
      producers: [
        { binding: "EVENTS", queue: `wuzapi-${slug}-e2e-events` },
        { binding: "DLQ", queue: `wuzapi-${slug}-e2e-dlq` },
      ],
      consumers: [
        {
          queue: `wuzapi-${slug}-e2e-events`,
          max_batch_size: 10,
          max_batch_timeout: 2,
          max_retries: 3,
          retry_delay: 5,
          dead_letter_queue: `wuzapi-${slug}-e2e-dlq`,
        },
        { queue: `wuzapi-${slug}-e2e-dlq`, max_batch_size: 10, max_batch_timeout: 2, max_retries: 2 },
      ],
    },
    r2_buckets: [{ binding: "MEDIA", bucket_name: `wuzipbot-media-${slug}-e2e` }],
    d1_databases: [
      {
        binding: "BOT_DB",
        database_name: `wuzipbot-bot-${slug}-e2e`,
        database_id: "00000000-0000-0000-0000-000000000000",
        migrations_dir: migrationsDir,
      },
    ],
    kv_namespaces: [{ binding: "KNOWLEDGE_KV", id: `wuzipbot-knowledge-${slug}-e2e` }],
    durable_objects: { bindings: [{ name: "CHAT_COORDINATOR", class_name: "ChatCoordinator" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["ChatCoordinator"] }],
  };

  const devVars = [
    `INGEST_TOKEN=${INGEST_TOKEN}`,
    `WUZAPI_HMAC_KEYS=${HMAC_KEY}`,
    `DOWNSTREAM_HMAC_KEY=e2e-downstream-key`,
    `WUZAPI_TOKEN=${WUZAPI_TOKEN}`,
    `AI_API_KEY=${AI_API_KEY}`,
    `TURSO_DATABASE_URL=${TURSO_URL}`,
    `TURSO_AUTH_TOKEN=e2e-turso-token`,
    `PAYMENT_API_KEY=e2e-payment-key`,
    `PAYMENT_CALLBACK_SECRET=e2e-callback-secret`,
    `TELEGRAM_BOT_TOKEN=${TELEGRAM_TOKEN}`,
    `TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID}`,
    `TELEGRAM_WEBHOOK_SECRET=${TELEGRAM_SECRET}`,
    `ADMIN_API_KEY=${ADMIN_API_KEY}`,
    "",
  ].join("\n");

  await writeFile(join(E2E_DIR, "wrangler.jsonc"), `${JSON.stringify(e2eConfig, null, 2)}\n`);
  await writeFile(join(E2E_DIR, ".dev.vars"), devVars);
  await writeFile(join(E2E_DIR, "knowledge", "prompt.txt"), PROMPT);
  await writeFile(join(E2E_DIR, "knowledge", "knowledge.txt"), KNOWLEDGE);

  return { configPath: join(E2E_DIR, "wrangler.jsonc") };
}

async function applyMigrations(configPath) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      join(cloudflareRoot, "node_modules", ".bin", "wrangler"),
      ["d1", "migrations", "apply", "BOT_DB", "--local", "--persist-to", E2E_STATE, "--config", configPath],
      {
        cwd: cloudflareRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          WRANGLER_LOG_PATH: join(logsDir, "e2e-migrations.log"),
          WRANGLER_REGISTRY_PATH: registryDir,
          WRANGLER_CACHE_DIR: cacheDir,
          WRANGLER_SEND_METRICS: "false",
        },
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => (code === 0 ? resolve(output) : reject(new Error(`migrations failed:\n${stripAnsi(output)}`))));
    child.on("error", reject);
  });
}

async function startWorker(configPath) {
  const child = startProcess(
    "worker",
    join(cloudflareRoot, "node_modules", ".bin", "wrangler"),
    ["dev", "--config", configPath, "--port", String(WORKER_PORT), "--ip", "127.0.0.1", "--persist-to", E2E_STATE, "--test-scheduled"],
    { verbose: process.env["E2E_VERBOSE"] === "1" },
  );
  await waitFor(
    "worker /healthz",
    async () => {
      try {
        const { status } = await fetchJson(`${WORKER_URL}/healthz`);
        return status === 200;
      } catch {
        return false;
      }
    },
    90_000,
    500,
  );
  return child;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function uploadKnowledge() {
  const { status, body } = await fetchJson(`${WORKER_URL}/admin/knowledge/sync`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_API_KEY}` },
    body: JSON.stringify({ prompt: PROMPT, knowledge: KNOWLEDGE }),
  });
  check("knowledge diunggah + indeks D1 dibangun", status === 200 && body?.index?.chunks > 0, JSON.stringify(body).slice(0, 160));
}

async function scenarioDirectReply() {
  await resetMocks();
  await setAiScript([{ content: "Halo Kak, ada yang bisa dibantu?" }]);

  const response = await sendWebhook(webhookBody({ chat: CUSTOMER, text: "halo", pushName: "Budi", id: "E2E-1" }));
  check("webhook diterima (202)", response.status === 202, `status ${response.status}`);

  const calls = await waitFor("balasan ke pelanggan", async () => {
    const recorded = await mockCalls("wuzapi");
    return textSends(recorded, CUSTOMER).length > 0 ? recorded : null;
  });

  const sends = textSends(calls, CUSTOMER);
  check("tepat satu balasan teks terkirim", sends.length === 1, `${sends.length} send`);
  check("balasan sesuai jawaban AI", String(sends[0]?.body?.Body ?? "").includes("Halo Kak"), String(sends[0]?.body?.Body ?? "").slice(0, 60));

  const presence = calls.filter((call) => call.url.includes("/chat/presence"));
  const states = presence.map((call) => call.body?.State);
  check("indikator typing composing → paused", states.includes("composing") && states.includes("paused"), states.join(","));
  return sends.length;
}

async function scenarioDuplicate() {
  await resetMocks();
  await setAiScript([{ content: "Halo Kak, ada yang bisa dibantu?" }]);

  const body = webhookBody({ chat: CUSTOMER, text: "halo lagi", pushName: "Budi", id: "E2E-2" });
  await sendWebhook(body);
  await waitFor("balasan pertama", async () => textSends(await mockCalls("wuzapi"), CUSTOMER).length > 0);

  // The same bytes again: same sha256, so the same deliveryId.
  await sendWebhook(body);
  await sleep(3_000);

  const sends = textSends(await mockCalls("wuzapi"), CUSTOMER);
  check("duplikat tidak menghasilkan balasan kedua", sends.length === 1, `${sends.length} send`);
}

async function scenarioNoAi() {
  await resetMocks();
  await setAiScript([{ content: "Seharusnya tidak terkirim" }]);

  await sendWebhook(webhookBody({ chat: NO_AI_CHAT, text: "halo", pushName: "Budi no_ai", id: "E2E-3" }));
  await sleep(3_000);

  const sends = textSends(await mockCalls("wuzapi"));
  check("kontak no_ai tidak dibalas", sends.length === 0, `${sends.length} send`);
  const aiCalls = await mockCalls("ai");
  check("AI tidak dipanggil untuk chat no_ai", aiCalls.length === 0, `${aiCalls.length} panggilan AI`);
}

/**
 * The full checkout, twice: once down the automatic path (ongkir included) and
 * once through the admin's Telegram card (ongkir not included).
 */
async function scenarioCheckout({ kode, label, expectTelegram }) {
  await resetMocks();
  await setAiScript([
    { tool: { name: "add_to_cart", arguments: { kode, qty: 1 } } },
    { tool: { name: "create_payment_link", arguments: { nama: "Budi", alamat: "Jl. Merdeka 1" } } },
    { content: "Pesanan sudah kami siapkan ya Kak." },
  ]);

  const marker = `checkout-${kode}`;
  await sendWebhook(webhookBody({ chat: CUSTOMER, text: `saya mau beli yang ${kode}`, pushName: "Budi", id: marker }));

  if (expectTelegram) {
    // Ongkir is not included, so the order stops at the admin's card.
    const telegram = await waitFor(`${label}: kartu approval`, async () => {
      const recorded = await mockCalls("telegram");
      return telegramMessages(recorded, "MENUNGGU PERSETUJUAN")[0] ?? null;
    });
    pass(`${label}: kartu approval dikirim ke admin`);

    const buttons = (telegram.body?.reply_markup?.inline_keyboard ?? []).flat();
    check(
      `${label}: tombol Terima/Tolak/Ubah Biaya ada`,
      buttons.some((button) => button.callback_data?.endsWith(":a")) &&
        buttons.some((button) => button.callback_data?.endsWith(":r")) &&
        buttons.some((button) => button.callback_data?.endsWith(":f")),
      buttons.map((button) => button.callback_data).join(" "),
    );

    const orderKode = /INV-[A-Z0-9-]+/.exec(String(telegram.body?.text ?? ""))?.[0] ?? "";
    check(`${label}: kartu memuat kode pesanan`, orderKode !== "", orderKode);

    const waiting = textSends(await mockCalls("wuzapi"), CUSTOMER).some((call) =>
      String(call.body?.Body ?? "").includes("dikonfirmasi admin"),
    );
    check(`${label}: pelanggan diberi tahu pesanan menunggu admin`, waiting, waiting ? "ada" : "tidak ada");

    // The admin presses "Terima" — the update Telegram would deliver.
    const update = {
      update_id: 9001,
      callback_query: {
        id: "cb-e2e",
        data: `o:${orderKode}:a`,
        from: { id: 42 },
        message: { message_id: 1001, chat: { id: Number(TELEGRAM_CHAT_ID) } },
      },
    };
    const pressApprove = () =>
      fetchJson(`${WORKER_URL}/webhooks/telegram`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": TELEGRAM_SECRET },
        body: JSON.stringify(update),
      });

    const approved = await pressApprove();
    check(`${label}: callback Telegram diterima`, approved.status === 200, `status ${approved.status}`);

    await waitFor(`${label}: kartu diedit`, async () =>
      (await mockCalls("telegram")).some((call) => call.url.includes("/editMessageText")),
    );
    pass(`${label}: kartu Telegram diedit setelah keputusan`);

    const links = await waitFor(`${label}: link setelah approval`, async () => {
      const recorded = await mockCalls("wuzapi");
      const found = textSends(recorded, CUSTOMER).filter((call) => String(call.body?.Body ?? "").includes("/dry-run/"));
      return found.length >= 1 ? found : null;
    });
    pass(`${label}: link pembayaran dikirim setelah admin menerima`);

    // The approved link travels through the outbox, so it carries a deterministic
    // msgid (`ob-<row id>`): a retry after a crash dedupes on WhatsApp's side.
    check(
      `${label}: link lewat outbox memakai msgid deterministik`,
      String(links[links.length - 1]?.body?.Id ?? "").startsWith("ob-"),
      String(links[links.length - 1]?.body?.Id ?? "(tanpa Id)"),
    );

    // A duplicate "Terima" must not produce a second link.
    await pressApprove();
    await sleep(2_000);
    const linkCount = textSends(await mockCalls("wuzapi"), CUSTOMER).filter((call) =>
      String(call.body?.Body ?? "").includes("/dry-run/"),
    ).length;
    check(`${label}: callback duplikat tidak menggandakan link`, linkCount === 1, `${linkCount} pesan link`);
  }

  const linkMessage = await waitFor(`${label}: pesan link pembayaran`, async () => {
    const recorded = await mockCalls("wuzapi");
    return (
      textSends(recorded, CUSTOMER)
        .filter((call) => String(call.body?.Body ?? "").includes("/dry-run/"))
        .pop() ?? null
    );
  });
  const kodeBayar = /\/dry-run\/([A-Za-z0-9-]+)/.exec(String(linkMessage?.body?.Body ?? ""))?.[1] ?? "";
  check(`${label}: link pembayaran dikirim ke pelanggan`, kodeBayar !== "", kodeBayar);

  // The customer pays on the dry-run page (what the gateway would call back).
  const page = await fetch(`${WORKER_URL}/dry-run/${kodeBayar}`);
  const pageHtml = await page.text();
  check(`${label}: halaman dry-run tampil`, page.status === 200 && pageHtml.includes("Bayar sekarang"), `status ${page.status}`);

  const paid = await fetchJson(`${WORKER_URL}/dry-run/${kodeBayar}/pay`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "action=paid",
  });
  check(`${label}: simulasi pembayaran diterima`, paid.status === 200, `status ${paid.status}`);

  // The cron is not on a timer in `wrangler dev`, so it is triggered explicitly:
  // this is the FASE 7 path (outbox flush + reconcile + expiry) being exercised.
  await fetchJson(`${WORKER_URL}/__scheduled?cron=*+*+*+*+*`);
  pass(`${label}: cron manual dipicu (/__scheduled)`);

  const withNota = await waitFor(`${label}: nota terkirim`, async () => {
    const recorded = await mockCalls("wuzapi");
    return documentSends(recorded, CUSTOMER).length > 0 ? recorded : null;
  });

  const nota = documentSends(withNota, CUSTOMER)[0];
  const document = String(nota?.body?.Document ?? "");
  check(`${label}: nota PDF terkirim`, document.startsWith("JVBERi"), document.slice(0, 12));
  check(`${label}: nama berkas nota`, String(nota?.body?.FileName ?? "").startsWith("Nota-"), String(nota?.body?.FileName ?? ""));

  // The order is read back by the code the nota names: `Nota-PAY-….pdf`.
  const orderRef = String(nota?.body?.FileName ?? "").replace(/^Nota-/, "").replace(/\.pdf$/, "");
  const read = await fetchJson(`${WORKER_URL}/admin/orders/${orderRef.replace(/^PAY-/, "INV-")}`, {
    headers: { authorization: `Bearer ${ADMIN_API_KEY}` },
  });
  check(`${label}: order berstatus paid`, read.body?.order?.status === "paid", String(read.body?.order?.status ?? read.status));

  const confirmation = textSends(withNota, CUSTOMER).some((call) => String(call.body?.Body ?? "").includes("Pembayaran kami terima"));
  check(`${label}: konfirmasi pembayaran dikirim`, confirmation, confirmation ? "ada" : "tidak ada");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.error("usage: pnpm run e2e [-- --number <nomor>] [--keep]");
    return;
  }
  const keep = argv.includes("--keep");
  const slug = await pickInstance(argv);
  const { config } = await readWranglerConfig(slug).catch(() => {
    throw new Error(`instance ${slug} not found; run pnpm run new -- --number ${slug}`);
  });

  process.stdout.write(`E2E bot — nomor ${slug}\n`);
  process.stdout.write(`  worker   ${WORKER_URL}\n  mocks    ${MOCK_URL}\n  turso    ${TURSO_URL}\n\n`);

  if (existsSync(E2E_STATE) && !keep) await rm(E2E_STATE, { recursive: true, force: true });
  const { configPath } = await writeE2eProject(slug, config);

  const children = [];
  let worker;
  try {
    await mkdir(stateDir, { recursive: true });
    const mocks = startProcess("mocks", process.execPath, [join(cloudflareRoot, "scripts", "mock-services.mjs"), "--port", String(MOCK_PORT)]);
    const turso = startProcess("turso", process.execPath, [
      join(cloudflareRoot, "scripts", "mock-turso.mjs"),
      "--port",
      String(TURSO_PORT),
      "--db",
      join(E2E_DIR, "turso.db"),
      "--quiet",
    ]);
    children.push(mocks, turso);

    await waitFor("mock services", async () => (await fetchJson(`${MOCK_URL}/__health`)).status === 200, 20_000, 200);
    await waitFor("mock turso", async () => (await fetchJson(`${TURSO_URL}/__health`)).status === 200, 20_000, 200);

    await applyMigrations(configPath);
    process.stdout.write("  migrasi D1 lokal diterapkan\n");

    worker = await startWorker(configPath);
    children.push(worker);
    process.stdout.write("  worker siap\n\n");

    await uploadKnowledge();
    await scenarioDirectReply();
    await scenarioDuplicate();
    await scenarioNoAi();
    await scenarioCheckout({ kode: "100370", label: "checkout otomatis", expectTelegram: false });
    await scenarioCheckout({ kode: "116964", label: "checkout via admin", expectTelegram: true });
  } catch (error) {
    fail("E2E", error instanceof Error ? error.message : String(error));
  } finally {
    for (const child of children) {
      if (!child.killed) child.kill("SIGTERM");
    }
    await sleep(500);
    for (const child of children) {
      if (!child.killed) child.kill("SIGKILL");
    }
    if (!keep) await rm(E2E_DIR, { recursive: true, force: true });
  }

  const failed = results.filter((result) => !result.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} pemeriksaan lulus\n`);
  if (failed.length > 0) {
    process.stdout.write(`GAGAL:\n${failed.map((result) => `  - ${result.name}: ${result.detail}`).join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("E2E OK — semua fitur berjalan tanpa nomor WhatsApp.\n");
  }
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exit(1);
});
