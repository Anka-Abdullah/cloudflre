#!/usr/bin/env node
/**
 * Creates every Cloudflare resource a number needs and wires the generated ids
 * back into that number's wrangler.jsonc:
 *
 *   pnpm run provision -- --number 6281234567890
 *   pnpm run provision -- --all
 *   pnpm run provision -- --number <nomor> --kv-name MY_KNOWLEDGE   # override the KV title
 *
 *   queue  <worker>-events        event transport
 *   queue  <worker>-dlq           permanent failures
 *   bucket <bucket-prefix>-<slug> R2: oversized payloads + DLQ archive + media
 *   D1     <d1-prefix>-<slug>     bot state (BOT_DB)
 *   KV     <kv-prefix>_<slug>     knowledge (KNOWLEDGE_KV)
 *
 * The Durable Object namespace needs no provisioning: it is declared in
 * wrangler.jsonc and created by the first deploy.
 *
 * Where the KV name comes from: a KV binding in wrangler.jsonc carries only an
 * `id`, so the *title* to create cannot be read from the worker config. It is
 * recorded at scaffold time in the instance's package.json
 * (`wuzip.kvNamespaceTitle`, ignored by npm and by wrangler) and can be
 * overridden with --kv-name. Before creating anything the script first looks for
 * a namespace that already has the configured id, which makes a re-run exact
 * even if the title was changed by hand in the dashboard.
 *
 * It is idempotent, and — more importantly — it is *re-runnable*: the ids are
 * always re-read from the account and re-patched, so a config that still holds
 * the scaffold placeholders is repaired instead of silently deploying a worker
 * bound to a database that does not exist.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ensureResource,
  instanceDir,
  listInstances,
  parseNumberArg,
  readWranglerConfig,
  runWranglerCapture,
  stripAnsi,
} from "./lib.mjs";

const PLACEHOLDER_D1_ID = "00000000-0000-0000-0000-000000000000";
const PLACEHOLDER_KV_ID = "00000000000000000000000000000000";

function flagValue(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : (argv[index + 1] ?? null);
}

function parseArgs(argv) {
  return {
    slug: parseNumberArg(argv),
    all: argv.includes("--all"),
    kvName: flagValue(argv, "--kv-name"),
    d1Name: flagValue(argv, "--d1-name"),
  };
}

/** Creates a resource, reporting whether it was created, kept, or failed. */
async function ensure(args, label) {
  const { status } = await ensureResource(args, label);
  console.log(status === "created" ? `  created ${label}` : `  kept ${label} (already exists)`);
}

function resourcesOf(config) {
  const producers = config.queues?.producers ?? [];
  const events = producers.find((entry) => entry.binding === "EVENTS")?.queue;
  const dlq =
    producers.find((entry) => entry.binding === "DLQ")?.queue ??
    (config.queues?.consumers ?? []).find((entry) => entry.dead_letter_queue)?.dead_letter_queue;
  const bucket = (config.r2_buckets ?? []).find((entry) => entry.binding === "MEDIA")?.bucket_name;
  const d1 = (config.d1_databases ?? []).find((entry) => entry.binding === "BOT_DB");
  const kv = (config.kv_namespaces ?? []).find((entry) => entry.binding === "KNOWLEDGE_KV");
  if (!events || !dlq || !bucket || !d1?.database_name || !kv?.id) {
    throw new Error("wrangler.jsonc is missing the EVENTS/DLQ queues, the MEDIA bucket, the BOT_DB D1 binding or the KNOWLEDGE_KV binding");
  }
  return {
    events,
    dlq,
    bucket,
    d1Name: String(d1.database_name),
    // Kept so a re-run recognises an already-provisioned resource even if the
    // stored name changed; the placeholders mean "not provisioned yet".
    d1Id: String(d1.database_id ?? ""),
    kvId: String(kv.id),
  };
}

/** Parses a `--json` wrangler listing, tolerating banner lines before the JSON. */
function parseJsonOutput(output, label) {
  const clean = stripAnsi(output);
  const start = clean.search(/[[{]/);
  if (start === -1) throw new Error(`could not read ${label}:\n${clean.slice(0, 600)}`);
  try {
    return JSON.parse(clean.slice(start));
  } catch (error) {
    throw new Error(`could not parse ${label} as JSON: ${error.message}\n${clean.slice(0, 600)}`);
  }
}

async function listD1() {
  const { code, output } = await runWranglerCapture(["d1", "list", "--json"]);
  if (code !== 0) throw new Error(`could not list D1 databases:\n${stripAnsi(output).slice(0, 600)}`);
  const parsed = parseJsonOutput(output, "d1 list");
  return Array.isArray(parsed) ? parsed : [];
}

async function listKv() {
  const { code, output } = await runWranglerCapture(["kv", "namespace", "list"]);
  if (code !== 0) throw new Error(`could not list KV namespaces:\n${stripAnsi(output).slice(0, 600)}`);
  const parsed = parseJsonOutput(output, "kv namespace list");
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Returns the database's uuid, creating it only when it is really absent.
 *
 * Matching by id before name means a config that was renamed by hand in the
 * instance's package.json/wrangler.jsonc keeps using the existing database
 * instead of provisioning a second one.
 */
async function ensureD1(name, currentId) {
  const databases = await listD1();
  const known = isRealD1Id(currentId) ? databases.find((entry) => entry?.uuid === currentId) : null;
  if (known?.uuid) return { id: String(known.uuid), created: false, name: String(known.name ?? name) };

  const byName = databases.find((entry) => entry?.name === name);
  if (byName?.uuid) return { id: String(byName.uuid), created: false, name };

  await ensure(["d1", "create", name], `D1 ${name}`);
  const created = (await listD1()).find((entry) => entry?.name === name);
  if (!created?.uuid) throw new Error(`D1 ${name} was created but does not appear in \`wrangler d1 list --json\``);
  return { id: String(created.uuid), created: true, name };
}

/** Creates the namespace if needed, then returns its id from the account list. */
async function ensureKv(title, currentId) {
  const namespaces = await listKv();
  const known = isRealKvId(currentId) ? namespaces.find((entry) => entry?.id === currentId) : null;
  if (known?.id) return { id: String(known.id), created: false, title: String(known.title ?? title) };

  const byTitle = namespaces.find((entry) => entry?.title === title);
  if (byTitle?.id) return { id: String(byTitle.id), created: false, title };

  await ensure(["kv", "namespace", "create", title], `KV ${title}`);
  const created = (await listKv()).find((entry) => entry?.title === title);
  if (!created?.id) throw new Error(`KV ${title} was created but does not appear in \`wrangler kv namespace list\``);
  return { id: String(created.id), created: true, title };
}

function isRealD1Id(id) {
  return typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id) && id !== PLACEHOLDER_D1_ID;
}

function isRealKvId(id) {
  return typeof id === "string" && /^[0-9a-f]{32}$/i.test(id) && id !== PLACEHOLDER_KV_ID;
}

/**
 * The KV title to create. The scaffold records it in package.json because
 * wrangler.jsonc has nowhere to put it; the default matches
 * `new-instance.mjs --kv-prefix WUZIPBOT_KNOWLEDGE`.
 */
async function resolveKvTitle(dir, slug, override) {
  if (override) return override;
  try {
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    const recorded = pkg?.wuzip?.kvNamespaceTitle;
    if (typeof recorded === "string" && recorded.trim() !== "" && !recorded.includes("__")) return recorded.trim();
  } catch {
    // No package.json or unreadable: fall through to the convention.
  }
  return `WUZIPBOT_KNOWLEDGE_${slug}`;
}

/**
 * Rewrites only the two id fields, by pattern, so every comment and the var
 * ordering in wrangler.jsonc survive a re-provision.
 */
function patchIds(raw, databaseId, kvId) {
  let patched = raw.replace(/("database_id"\s*:\s*")[^"]*(")/, `$1${databaseId}$2`);
  patched = patched.replace(/("kv_namespaces"\s*:\s*\[\s*\{[^}]*?"id"\s*:\s*")[^"]*(")/s, `$1${kvId}$2`);
  return patched;
}

async function provision(slug, options = {}) {
  const { dir, config } = await readWranglerConfig(slug);
  const { events, dlq, bucket, d1Name, d1Id, kvId } = resourcesOf(config);
  const kvTitle = await resolveKvTitle(dir, slug, options.kvName ?? null);

  console.log(`\n${slug}`);
  console.log(`  worker  : ${config.name}`);
  // The plan is printed before anything is created so a mistake (wrong prefix,
  // wrong number) is visible in the terminal instead of in the Cloudflare
  // dashboard. A KV namespace is the easiest thing to get wrong, because its
  // binding holds only an id and its title comes from the scaffold.
  console.log("  plan    :");
  console.log(`    queue  ${events}`);
  console.log(`    dlq    ${dlq}`);
  console.log(`    bucket ${bucket}`);
  console.log(`    D1     ${d1Name}${isRealD1Id(d1Id) ? ` (already bound: ${d1Id})` : ""}`);
  console.log(`    KV     ${kvTitle}${isRealKvId(kvId) ? ` (already bound: ${kvId})` : ""}`);

  // The DLQ is created first: Cloudflare creates a missing DLQ automatically on
  // deploy, but creating it explicitly keeps `pnpm run provision` self-contained.
  await ensure(["queues", "create", dlq], `queue ${dlq}`);
  await ensure(["queues", "create", events], `queue ${events}`);
  await ensure(["r2", "bucket", "create", bucket], `bucket ${bucket}`);

  const d1 = await ensureD1(options.d1Name ?? d1Name, d1Id);
  console.log(`  ${d1.created ? "created" : "kept"} D1 ${d1.name} (${d1.id})`);
  const kv = await ensureKv(kvTitle, kvId);
  console.log(`  ${kv.created ? "created" : "kept"} KV ${kv.title} (${kv.id})`);

  const configPath = join(dir, "wrangler.jsonc");
  const raw = await readFile(configPath, "utf8");
  const patched = patchIds(raw, d1.id, kv.id);
  if (patched !== raw) {
    await writeFile(configPath, patched, "utf8");
    console.log(`  patched wrangler.jsonc: database_id=${d1.id} kv id=${kv.id}`);
  } else {
    console.log("  wrangler.jsonc already up to date");
  }

  if (raw.includes(PLACEHOLDER_D1_ID) || raw.includes(PLACEHOLDER_KV_ID)) {
    console.log("  note: placeholders were present and have been replaced");
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const slugs = options.all ? await listInstances() : [options.slug];
  if (slugs.length === 0) throw new Error("no instance folders found; create one with: pnpm run new -- --number <nomor>");
  for (const target of slugs) {
    // instanceDir() gives the friendly "run pnpm run new first" error.
    await instanceDir(target);
    await provision(target, options);
  }
  console.log("\nnext:");
  console.log("  pnpm run secrets -- --number <nomor>   # INGEST_TOKEN, HMAC key, WUZAPI_TOKEN, AI_API_KEY, …");
  console.log("  pnpm run migrate -- --number <nomor>   # apply the D1 schema");
  console.log("  pnpm run deploy  -- --number <nomor>");
  console.log("(if wrangler is not authenticated yet: npx wrangler login, or export CLOUDFLARE_API_TOKEN)");
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exit(1);
});
