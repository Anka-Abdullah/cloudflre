#!/usr/bin/env node
/**
 * Creates cloudflare/<nomor>/ from _template/ and fills in every per-number
 * name, so adding a number is one command instead of a copy-paste chore.
 *
 *   pnpm run new -- --number 6281234567890
 *   pnpm run new -- --number 6281234567890 --bucket-prefix mybot-media --worker-prefix wuzapi
 */
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cloudflareRoot = dirname(here);
const templateDir = join(cloudflareRoot, "_template");

const E164 = /^[1-9][0-9]{7,14}$/;

function parseArgs(argv) {
  const options = {
    number: null,
    bucketPrefix: "wuzipbot-media",
    workerPrefix: "wuzapi",
    d1Prefix: "wuzipbot-bot",
    kvPrefix: "WUZIPBOT_KNOWLEDGE",
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--number":
      case "-n":
        options.number = next();
        break;
      case "--bucket-prefix":
        options.bucketPrefix = next();
        break;
      case "--worker-prefix":
        options.workerPrefix = next();
        break;
      case "--d1-prefix":
        options.d1Prefix = next();
        break;
      case "--kv-prefix":
        options.kvPrefix = next();
        break;
      case "--force":
        options.force = true;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "usage: pnpm run new -- --number <E.164 without +> [options]",
            "",
            "options:",
            "  --worker-prefix <p>   worker/queue name prefix        (default wuzapi)",
            "  --bucket-prefix <p>   R2 bucket prefix                (default wuzipbot-media)",
            "  --d1-prefix <p>       D1 database prefix              (default wuzipbot-bot)",
            "  --kv-prefix <p>       KV namespace name prefix        (default WUZIPBOT_KNOWLEDGE)",
            "  --force               overwrite an existing folder",
            "",
            "example: pnpm run new -- --number 6281234567890",
          ].join("\n"),
        );
        process.exit(0);
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
        if (options.number === null) options.number = arg;
        else throw new Error(`unexpected argument ${arg}`);
    }
  }
  return options;
}

function slugifyNumber(raw) {
  const digits = String(raw).replace(/[^0-9]/g, "");
  if (!E164.test(digits)) {
    throw new Error(
      `"${raw}" is not a valid E.164 number without '+': expected 8-15 digits and no leading zero`,
    );
  }
  return digits;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuses to scaffold when _template/ and the replacement map disagree.
 *
 * A placeholder that nobody replaces ships a literal `__KV_NAMESPACE_ID__` into
 * wrangler.jsonc, and a replacement that no file uses means someone edited the
 * map without editing the template. Both are silent until deploy time, so they
 * are caught here instead.
 */
async function assertTemplateIsConsistent(sourceDir, replacements) {
  const used = new Set();

  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const body = await readFile(full, "utf8");
      for (const token of new Set(body.match(/__[A-Z0-9_]+__/g) ?? [])) used.add(token);
    }
  }

  await walk(sourceDir);

  const declared = Object.keys(replacements);
  const unhandled = [...used].filter((token) => !declared.includes(token)).sort();
  const unused = declared.filter((token) => !used.has(token)).sort();

  if (unhandled.length > 0) {
    throw new Error(`_template/ uses placeholders that new-instance.mjs does not define: ${unhandled.join(", ")}`);
  }
  if (unused.length > 0) {
    throw new Error(`new-instance.mjs defines placeholders that _template/ never uses: ${unused.join(", ")}`);
  }
}

async function copyTemplate(sourceDir, targetDir, replacements) {
  await mkdir(targetDir, { recursive: true });
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    const source = join(sourceDir, entry.name);
    const target = join(targetDir, entry.name.replace(/\.tmpl$/, ""));
    if (entry.isDirectory()) {
      await copyTemplate(source, target, replacements);
      continue;
    }
    let content = await readFile(source, "utf8");
    for (const [token, value] of Object.entries(replacements)) {
      content = content.split(token).join(value);
    }
    await writeFile(target, content, "utf8");
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.number) {
    console.error("error: --number is required, for example: pnpm run new -- --number 6281234567890");
    process.exit(1);
  }

  const slug = slugifyNumber(options.number);
  const instanceDir = join(cloudflareRoot, slug);
  if ((await exists(instanceDir)) && !options.force) {
    console.error(`error: ${relative(process.cwd(), instanceDir)} already exists (use --force to overwrite files)`);
    process.exit(1);
  }

  const workerName = `${options.workerPrefix}-${slug}`;
  // The D1 id and KV id cannot be known before `pnpm run provision` creates the
  // resources, so unmistakable placeholders are scaffolded and then patched in
  // place. `wrangler deploy` refuses a zero D1 id, which turns "forgot to
  // provision" into a deploy error instead of a silent misconfiguration.
  const replacements = {
    __SLUG__: slug,
    __WORKER_NAME__: workerName,
    __PKG_NAME__: `wuzapi-${slug}`,
    __QUEUE__: `${workerName}-events`,
    __DLQ__: `${workerName}-dlq`,
    __BUCKET__: `${options.bucketPrefix}-${slug}`,
    __D1_NAME__: `${options.d1Prefix}-${slug}`,
    __KV_NAME__: `${options.kvPrefix}_${slug}`,
    __D1_DATABASE_ID__: "00000000-0000-0000-0000-000000000000",
    __KV_NAMESPACE_ID__: "00000000000000000000000000000000",
    __COMPATIBILITY_DATE__: new Date().toISOString().slice(0, 10),
  };

  await assertTemplateIsConsistent(templateDir, replacements);
  await copyTemplate(templateDir, instanceDir, replacements);

  const display = relative(process.cwd(), instanceDir) || ".";
  console.log(`created ${display}`);
  console.log("");
  console.log("resources for this number:");
  console.log(`  worker  : ${replacements.__WORKER_NAME__}`);
  console.log(`  queue   : ${replacements.__QUEUE__}`);
  console.log(`  dlq     : ${replacements.__DLQ__}`);
  console.log(`  bucket  : ${replacements.__BUCKET__}            (binding MEDIA)`);
  console.log(`  d1      : ${replacements.__D1_NAME__}          (binding BOT_DB)`);
  console.log(`  kv      : ${replacements.__KV_NAME__} (binding KNOWLEDGE_KV)`);
  console.log(`  do      : ChatCoordinator               (binding CHAT_COORDINATOR)`);
  console.log("");
  console.log("next steps:");
  console.log(`  1. pnpm install`);
  console.log(`  2. pnpm run provision -- --number ${slug}`);
  console.log(`  3. pnpm run secrets   -- --number ${slug}`);
  console.log(`  4. pnpm run migrate   -- --number ${slug}`);
  console.log(`  5. pnpm run dev       -- --number ${slug}      # or: pnpm run deploy -- --number ${slug}`);
  console.log(`  6. paste https://${replacements.__WORKER_NAME__}.<your-subdomain>.workers.dev/ingest/<INGEST_TOKEN>`);
  console.log(`     into the wuzapi dashboard (Webhook URL) together with the HMAC key.`);
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exit(1);
});
