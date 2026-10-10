#!/usr/bin/env node
/**
 * `pnpm run knowledge -- --number <nomor> [--prompt <file>] [--knowledge <file>] [--images <dir>]`
 *
 * Uploads one number's prompt + knowledge to KV (default) or R2, images to R2,
 * and rebuilds the D1 index when the bundle is big enough to need FTS5.
 *
 * Why a script at all: wrangler is the only component allowed to write into the
 * number's KV/R2/D1 (they are per-number resources, and the values are secrets of
 * a sort — prompt.txt is business content), while the *derived* index (chunks +
 * FTS5 + catalog_products) must be produced by the same chunker the agent uses at
 * runtime. So the bytes travel through wrangler and the index is rebuilt by the
 * Worker through `POST /admin/knowledge/sync`.
 *
 * Defaults, so the common case is one command:
 *   prompt    <nomor>/knowledge/prompt.txt
 *   knowledge <nomor>/knowledge/knowledge.txt
 *   images    <nomor>/knowledge/images/          (only when the folder exists)
 *   policy    <nomor>/knowledge/ongkir-policy.json (only when the file exists)
 *
 * Modes:
 *   --local          write into cloudflare/.wrangler/state (the state `pnpm run
 *                    dev` reads). Without it, the upload is remote.
 *   --url <base>     worker base URL used to rebuild the D1 index; defaults to
 *                    http://127.0.0.1:8790 when --local, otherwise the
 *                    PUBLIC_BASE_URL from wrangler.jsonc.
 *   --skip-index     upload only, never call /admin/knowledge/sync.
 *   --dry-run        print the plan, upload nothing.
 */
import { access, readFile, readdir, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { parseNumberArg, readWranglerConfig, runWranglerCapture, stateDir, stripAnsi } from "./lib.mjs";

const IMAGE_PREFIX = "knowledge/images/";
const PROMPT_KEY = "knowledge/prompt.txt";
const KNOWLEDGE_KEY = "knowledge/knowledge.txt";
const ONGKIR_KEY = "knowledge/ongkir-policy.json";

/** Repository-relative path when inside the repo, absolute otherwise. */
function pretty(path) {
  const rel = relative(process.cwd(), path);
  return rel.startsWith("..") ? path : rel;
}

function flagValue(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : (argv[index + 1] ?? null);
}

function usage() {
  console.error("usage: pnpm run knowledge -- --number <nomor> [options]");
  console.error("  --prompt <file>        system prompt (default <nomor>/knowledge/prompt.txt)");
  console.error("  --knowledge <file>     catalogue/knowledge (default <nomor>/knowledge/knowledge.txt)");
  console.error("  --images <dir>         image folder for [GAMBAR: …] (default <nomor>/knowledge/images/)");
  console.error("  --ongkir-policy <file> ongkir policy JSON (default <nomor>/knowledge/ongkir-policy.json)");
  console.error("  --mode kv|r2|auto      override KNOWLEDGE_MODE for this upload");
  console.error("  --local                write to .wrangler/state instead of the remote resources");
  console.error("  --url <base>           worker URL for the D1 index rebuild");
  console.error("  --admin-key <key>      ADMIN_API_KEY for the rebuild (else env or .dev.vars)");
  console.error("  --skip-index           do not call /admin/knowledge/sync");
  console.error("  --dry-run              show the plan without uploading");
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function sizeOf(path) {
  const info = await stat(path);
  return info.size;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Reads ADMIN_API_KEY from --admin-key, the environment, or the instance .dev.vars. */
async function adminKeyFrom(instanceDir, explicit) {
  if (explicit) return explicit;
  if (process.env.ADMIN_API_KEY) return process.env.ADMIN_API_KEY;
  const devVars = join(instanceDir, ".dev.vars");
  if (await exists(devVars)) {
    const content = await readFile(devVars, "utf8");
    const match = /^ADMIN_API_KEY=(.*)$/m.exec(content);
    if (match && match[1].trim() !== "") return match[1].trim();
  }
  return null;
}

function listFiles(dir) {
  return readdir(dir, { withFileTypes: true });
}

/** Uploads one file into KV, then reads it back and compares the hash. */
async function putKv({ configPath, key, file, local, label }) {
  const args = ["kv", "key", "put", "--config", configPath, "--binding", "KNOWLEDGE_KV", key, "--path", file];
  if (local) args.push("--local", "--persist-to", stateDir);
  else args.push("--remote");
  const put = await runWranglerCapture(args);
  if (put.code !== 0) throw new Error(`${label}: kv put failed\n${stripAnsi(put.output).trim().slice(0, 800)}`);

  const getArgs = ["kv", "key", "get", "--config", configPath, "--binding", "KNOWLEDGE_KV", key];
  if (local) getArgs.push("--local", "--persist-to", stateDir);
  else getArgs.push("--remote");
  const got = await runWranglerCapture(getArgs);
  if (got.code !== 0) throw new Error(`${label}: kv get (verification) failed\n${stripAnsi(got.output).trim().slice(0, 800)}`);

  const expected = await readFile(file);
  const actual = got.output.trim();
  const matches = sha256(actual) === sha256(expected.toString().trim()) || actual === expected.toString().trim();
  return { verified: matches, bytes: expected.byteLength, wire: `kv:${key}` };
}

/** Uploads one file into R2, then downloads it again and compares the hash. */
async function putR2({ configPath, bucket, key, file, local, label, contentType }) {
  const objectPath = `${bucket}/${key}`;
  const args = ["r2", "object", "put", objectPath, "--config", configPath, "--file", file];
  if (contentType) args.push("--content-type", contentType);
  if (local) args.push("--local", "--persist-to", stateDir);
  else args.push("--remote");
  const put = await runWranglerCapture(args);
  if (put.code !== 0) throw new Error(`${label}: r2 put failed\n${stripAnsi(put.output).trim().slice(0, 800)}`);

  const temp = join(tmpdir(), `wuzip-r2-verify-${Date.now()}-${basename(file)}`);
  const getArgs = ["r2", "object", "get", objectPath, "--config", configPath, "--file", temp];
  if (local) getArgs.push("--local", "--persist-to", stateDir);
  else getArgs.push("--remote");
  const got = await runWranglerCapture(getArgs);
  if (got.code !== 0) {
    await rm(temp, { force: true });
    throw new Error(`${label}: r2 get (verification) failed\n${stripAnsi(got.output).trim().slice(0, 800)}`);
  }
  const [expected, actual] = await Promise.all([readFile(file), readFile(temp)]);
  await rm(temp, { force: true });
  return { verified: sha256(expected) === sha256(actual), bytes: expected.byteLength, wire: `r2:${key}` };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    usage();
    return;
  }

  const slug = parseNumberArg(argv);
  const { dir, config } = await readWranglerConfig(slug);
  const configPath = join(dir, "wrangler.jsonc");
  const vars = config.vars ?? {};
  const bucket = config.r2_buckets?.[0]?.bucket_name ?? "";
  const dryRun = argv.includes("--dry-run");
  const local = argv.includes("--local");
  const skipIndex = argv.includes("--skip-index");
  const noVerify = argv.includes("--no-verify");
  const modeArg = flagValue(argv, "--mode") ?? vars.KNOWLEDGE_MODE ?? "auto";
  const inlineMax = Number(vars.KNOWLEDGE_INLINE_MAX_BYTES ?? 1_048_576);

  const promptFile = resolve(flagValue(argv, "--prompt") ?? join(dir, "knowledge", "prompt.txt"));
  const knowledgeFile = resolve(flagValue(argv, "--knowledge") ?? join(dir, "knowledge", "knowledge.txt"));
  const imagesDir = resolve(flagValue(argv, "--images") ?? join(dir, "knowledge", "images"));
  const policyFile = resolve(flagValue(argv, "--ongkir-policy") ?? join(dir, "knowledge", "ongkir-policy.json"));

  const files = [];
  if (await exists(promptFile)) files.push({ key: PROMPT_KEY, file: promptFile, label: "prompt" });
  else if (flagValue(argv, "--prompt")) throw new Error(`--prompt ${promptFile} does not exist`);
  else console.warn(`warn: ${relative(process.cwd(), promptFile)} not found, skipping prompt`);

  if (await exists(knowledgeFile)) files.push({ key: KNOWLEDGE_KEY, file: knowledgeFile, label: "knowledge" });
  else if (flagValue(argv, "--knowledge")) throw new Error(`--knowledge ${knowledgeFile} does not exist`);
  else if (files.length === 0) {
    throw new Error(
      `neither ${pretty(promptFile)} nor ${pretty(knowledgeFile)} exists.\n` +
        "       pass --prompt <file> --knowledge <file>, or put them in the instance's knowledge/ folder.",
    );
  }

  const hasPolicy = await exists(policyFile);
  const images = (await exists(imagesDir)) ? (await listFiles(imagesDir)).filter((entry) => entry.isFile()) : [];

  const promptBytes = files.some((entry) => entry.label === "prompt") ? await sizeOf(promptFile) : 0;
  const knowledgeBytes = files.some((entry) => entry.label === "knowledge") ? await sizeOf(knowledgeFile) : 0;
  const totalBytes = promptBytes + knowledgeBytes;

  const mode = String(modeArg).toLowerCase();
  // auto follows the loader's rule: KV while the bundle fits, R2 once it does not.
  const target = mode === "kv_inline" ? "kv" : mode === "r2_d1_fts" ? "r2" : totalBytes > inlineMax ? "r2" : "kv";

  console.log(`number      : ${slug}`);
  console.log(`config      : ${pretty(configPath)}`);
  console.log(`KNOWLEDGE_MODE=${vars.KNOWLEDGE_MODE ?? "(unset)"} → target ${target}${mode !== "auto" ? ` (forced by --mode ${mode})` : ""}`);
  console.log(`bundle      : prompt ${promptBytes} B + knowledge ${knowledgeBytes} B = ${totalBytes} B (inline max ${inlineMax})`);
  for (const entry of files) console.log(`  upload    : ${entry.label.padEnd(10)} ${pretty(entry.file)} → ${entry.key}`);
  if (hasPolicy) console.log(`  upload    : ongkir-policy ${pretty(policyFile)} → ${ONGKIR_KEY}`);
  if (images.length > 0) console.log(`  upload    : ${images.length} image(s) → ${bucket}/${IMAGE_PREFIX}<name>`);
  console.log(`scope       : ${local ? `local (${pretty(stateDir)})` : "remote (Cloudflare)"}`);

  if (dryRun) {
    console.log("\n[dry-run] nothing uploaded.");
    return;
  }

  if (files.length === 0 && !hasPolicy && images.length === 0) throw new Error("nothing to upload");

  const uploads = [];
  for (const entry of files) {
    const result =
      target === "kv"
        ? await putKv({ configPath, key: entry.key, file: entry.file, local, label: entry.label })
        : await putR2({
            configPath,
            bucket,
            key: entry.key,
            file: entry.file,
            local,
            label: entry.label,
            contentType: "text/plain; charset=utf-8",
          });
    uploads.push({ ...entry, ...result });
    console.log(`${result.verified || noVerify ? "ok  " : "WARN"} ${entry.label} → ${result.wire} (${result.bytes} B)${result.verified ? ", verified" : ", verify skipped"}`);
  }

  if (hasPolicy) {
    const result =
      target === "kv"
        ? await putKv({ configPath, key: ONGKIR_KEY, file: policyFile, local, label: "ongkir-policy" })
        : await putR2({ configPath, bucket, key: ONGKIR_KEY, file: policyFile, local, label: "ongkir-policy", contentType: "application/json" });
    uploads.push({ label: "ongkir-policy", ...result });
    console.log(`${result.verified || noVerify ? "ok  " : "WARN"} ongkir-policy → ${result.wire} (${result.bytes} B)`);
  }

  for (const image of images) {
    const file = join(imagesDir, image.name);
    const result = await putR2({
      configPath,
      bucket,
      key: `${IMAGE_PREFIX}${image.name}`,
      file,
      local,
      label: `image ${image.name}`,
      contentType: image.name.endsWith(".png") ? "image/png" : "image/jpeg",
    });
    console.log(`${result.verified || noVerify ? "ok  " : "WARN"} image ${image.name} → ${result.wire} (${result.bytes} B)`);
  }

  // ---- D1 index (chunks + FTS5 + catalog_products) -------------------------
  const workerUrl =
    flagValue(argv, "--url") ??
    (local ? "http://127.0.0.1:8790" : (vars.PUBLIC_BASE_URL || "").replace(/\/+$/, ""));

  if (skipIndex) {
    console.log("\nindex rebuild skipped (--skip-index)");
  } else if (workerUrl === "") {
    console.log("\nindex rebuild skipped: no worker URL (set PUBLIC_BASE_URL, or pass --url http://host:port)");
  } else if (target === "kv") {
    // KV mode scores chunks in the isolate, so there is no index to rebuild. The
    // catalog_products projection is still refreshed when a worker is reachable.
    console.log(`\nkv_inline mode: no FTS index needed. Refreshing catalog_products via ${workerUrl} …`);
    const key = await adminKeyFrom(dir, flagValue(argv, "--admin-key"));
    if (!key) console.log("skipped: ADMIN_API_KEY not found (--admin-key, env, or .dev.vars)");
    else {
      const response = await fetch(`${workerUrl}/admin/knowledge/sync`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: "{}",
      }).catch((error) => ({ ok: false, status: 0, text: async () => String(error) }));
      console.log(response.ok ? "ok   knowledge index refreshed" : `WARN index refresh failed: ${await response.text()}`);
    }
  } else {
    console.log(`\nrebuilding D1 index via ${workerUrl}/admin/knowledge/sync …`);
    const key = await adminKeyFrom(dir, flagValue(argv, "--admin-key"));
    if (!key) {
      console.log("skipped: ADMIN_API_KEY not found (--admin-key, env, or .dev.vars)");
    } else {
      const response = await fetch(`${workerUrl}/admin/knowledge/sync`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: "{}",
      }).catch((error) => ({ ok: false, status: 0, text: async () => String(error) }));
      const text = await response.text();
      console.log(response.ok ? `ok   ${text}` : `WARN index rebuild failed (HTTP ${response.status}): ${text}`);
    }
  }

  console.log(`\ndone. ${uploads.length} object(s) written to ${target === "kv" ? "KV" : "R2"}.`);
  if (target === "r2") {
    console.log("KNOWLEDGE_MODE resolves to r2_d1_fts: retrieval reads the R2 copy and ranks it with D1 FTS5.");
  }
  console.log("next: pnpm run dev -- --number " + slug + "   # then send a test message (BOT_MODE=shadow)");
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  usage();
  process.exit(1);
});
