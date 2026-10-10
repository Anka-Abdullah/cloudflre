#!/usr/bin/env node
/**
 * Per-number wrangler commands, with the paths and flags this repository needs.
 *
 *   pnpm run dev       -- --number 6281234567890 [--port 8790]
 *   pnpm run deploy    -- --number 6281234567890
 *   pnpm run tail      -- --number 6281234567890
 *   pnpm run migrate   -- --number 6281234567890 [--local]
 *   pnpm run knowledge -- --number 6281234567890 --prompt <file> --knowledge <file>
 *   pnpm run secrets   -- --number 6281234567890 [options]
 *
 * Every instance folder is a deployable Worker project, so `--config` selects the
 * number; nothing is shared between numbers except the code in shared/.
 *
 * ---------------------------------------------------------------------------
 * Secrets
 *
 * Fourteen secrets are per number (SECRET_FLAGS / ENV_SECRETS below), and they
 * are never written to a file that git can see. Three ways to set them, in order
 * of safety:
 *
 *   1. --from-env                     reads the value from the process environment
 *      export AI_API_KEY=…; pnpm run secrets -- --number … --from-env
 *   2. --set NAME=VALUE               explicit, but the value lands in shell history
 *   3. --generate NAME[,NAME…]        mints a random value (for the ones you invent:
 *                                     ADMIN_API_KEY, TELEGRAM_WEBHOOK_SECRET, …)
 *
 * `--list` shows which names exist in the Worker (values are never readable).
 */
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { cloudflareRoot, parseNumberArg, randomToken, readWranglerConfig, runWrangler, stateDir } from "./lib.mjs";

const CONFIG_PATH_FLAG = "--config";

/** Secret name → CLI flag that supplies it. */
const SECRET_FLAGS = {
  WUZAPI_HMAC_KEYS: "--hmac-key",
  DOWNSTREAM_HMAC_KEY: "--downstream-key",
  ALERT_WEBHOOK_URL: "--alert-webhook-url",
  WUZAPI_TOKEN: "--wuzapi-token",
  AI_API_KEY: "--ai-api-key",
  TURSO_DATABASE_URL: "--turso-url",
  TURSO_AUTH_TOKEN: "--turso-token",
  PAYMENT_API_KEY: "--payment-key",
  PAYMENT_CALLBACK_SECRET: "--payment-callback-secret",
  TELEGRAM_BOT_TOKEN: "--telegram-token",
  TELEGRAM_CHAT_ID: "--telegram-chat-id",
  TELEGRAM_WEBHOOK_SECRET: "--telegram-webhook-secret",
  ADMIN_API_KEY: "--admin-key",
};

/** Secrets read from the environment by --from-env, in this order. */
const ENV_SECRETS = [
  "INGEST_TOKEN",
  "WUZAPI_HMAC_KEYS",
  "DOWNSTREAM_HMAC_KEY",
  "ALERT_WEBHOOK_URL",
  "WUZAPI_TOKEN",
  "AI_API_KEY",
  "TURSO_DATABASE_URL",
  "TURSO_AUTH_TOKEN",
  "PAYMENT_API_KEY",
  "PAYMENT_CALLBACK_SECRET",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "TELEGRAM_WEBHOOK_SECRET",
  "ADMIN_API_KEY",
];

function flagValue(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : (argv[index + 1] ?? null);
}

function flagValues(argv, name) {
  const values = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && argv[i + 1] !== undefined) values.push(argv[++i]);
  }
  return values;
}

async function putSecret(name, value, configPath) {
  if (value === undefined || value === null || String(value) === "") {
    throw new Error(`refusing to set ${name} to an empty value`);
  }
  const code = await runWrangler(["secret", "put", name, CONFIG_PATH_FLAG, configPath], { input: `${value}\n` });
  if (code !== 0) throw new Error(`failed to set secret ${name}`);
}

async function currentIngestToken(devVarsPath) {
  try {
    const content = await readFile(devVarsPath, "utf8");
    return /^INGEST_TOKEN=(.*)$/m.exec(content)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

function usage() {
  console.error("usage: pnpm run <dev|deploy|tail|migrate|knowledge|secrets> -- --number <nomor>");
  console.error("   dev       : run the worker locally (port 8790, queue/R2/D1/KV/DO simulated)");
  console.error("   deploy    : deploy this number's worker");
  console.error("   tail      : stream production logs");
  console.error("   migrate   : apply the D1 schema (--local to target the local database)");
  console.error("   knowledge : upload prompt.txt / knowledge.txt (+ images, + D1 index rebuild)");
  console.error("   secrets   : set this number's secrets (--list, --from-env, --set NAME=VALUE, …)");
}

/** Runs `wrangler secret list` so the operator can see which names exist. */
async function setSecrets(rest, dir, configPath, config) {
  const dryRun = rest.includes("--dry-run");
  const setPairs = flagValues(rest, "--set");
  const generate = (flagValue(rest, "--generate") ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  const fromEnv = rest.includes("--from-env");
  const rotate = rest.includes("--rotate-ingest-token");

  /** name → value, collected before anything is pushed. */
  const planned = new Map();

  // INGEST_TOKEN keeps its existing value unless rotation is requested, so
  // re-running this command never invalidates the URL already in the dashboard.
  const existing = await currentIngestToken(join(dir, ".dev.vars"));
  planned.set("INGEST_TOKEN", rotate || !existing ? randomToken(32) : existing);

  if (fromEnv) {
    for (const name of ENV_SECRETS) {
      const value = process.env[name];
      if (typeof value === "string" && value.trim() !== "") planned.set(name, value.trim());
    }
  }

  for (const [name, flag] of Object.entries(SECRET_FLAGS)) {
    const value = flagValue(rest, flag);
    if (value !== null && value !== "") planned.set(name, value);
  }

  for (const pair of setPairs) {
    const index = pair.indexOf("=");
    if (index <= 0) throw new Error(`--set expects NAME=VALUE, received ${JSON.stringify(pair)}`);
    planned.set(pair.slice(0, index).trim(), pair.slice(index + 1));
  }

  for (const name of generate) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`--generate expects secret names, received ${JSON.stringify(name)}`);
    planned.set(name, randomToken(32));
  }

  if (planned.size === 0) {
    console.log("nothing to do: pass --from-env, --set NAME=VALUE, --generate NAME, or one of the --<name> flags");
    usage();
    return;
  }

  console.log(`${dryRun ? "[dry-run] would set" : "setting"} ${planned.size} secret(s) on ${config.name}:`);
  for (const [name, value] of planned) {
    const shown = name === "INGEST_TOKEN" && !rotate ? "(unchanged, pass --rotate-ingest-token to change)" : `(${value.length} chars)`;
    console.log(`  ${name} ${shown}`);
    if (!dryRun) await putSecret(name, value, configPath);
  }

  if (dryRun) return;

  console.log("\nvalues to paste into the wuzapi dashboard for this number:");
  const token = planned.get("INGEST_TOKEN");
  if (token) {
    console.log(`  Webhook URL : https://${config.name}.<your-subdomain>.workers.dev/ingest/${token}`);
  } else {
    console.log(`  Webhook URL : run again to see the token, or read INGEST_TOKEN from .dev.vars`);
  }
  console.log(`  HMAC Key    : ${flagValue(rest, "--hmac-key") ?? "(value passed to --hmac-key, or set via --from-env)"}`);
  console.log(`  Webhook Events: All, or a subset such as Message,Connected,Disconnected`);

  const botSecrets = ["WUZAPI_TOKEN", "AI_API_KEY", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"];
  const missingBot = botSecrets.filter((name) => !planned.has(name));
  if (missingBot.length > 0) {
    console.log(`\nstill needed before BOT_MODE=shadow|on: ${missingBot.join(", ")}`);
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || !["dev", "deploy", "tail", "migrate", "knowledge", "secrets"].includes(command)) {
    usage();
    process.exit(1);
  }

  // `pnpm run knowledge -- --help` must reach the sub-script, which knows its own
  // flags; parsing a number first would answer with "--number is required".
  if (command === "knowledge" && (rest.includes("--help") || rest.includes("-h"))) {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [join(cloudflareRoot, "scripts", "sync-knowledge.mjs"), "--help"], {
      stdio: "inherit",
    });
    child.on("close", (code) => process.exit(code ?? 0));
    return;
  }

  const slug = parseNumberArg(rest);
  const { dir, config } = await readWranglerConfig(slug);
  const configPath = join(dir, "wrangler.jsonc");

  if (command === "dev") {
    // 8787 is a common default and often taken (Docker/OrbStack), so the local
    // port is explicit and overridable.
    const port = flagValue(rest, "--port") ?? "8790";
    console.log(`worker ${config.name} (${slug}) -> http://0.0.0.0:${port}`);
    console.log(`ingest URL: http://127.0.0.1:${port}/ingest/<INGEST_TOKEN from .dev.vars>`);
    console.log("queue, R2, D1, KV and Durable Objects are simulated locally; state lives in cloudflare/.wrangler/state\n");
    process.exit(
      await runWrangler([
        "dev",
        CONFIG_PATH_FLAG,
        configPath,
        "--ip",
        "0.0.0.0",
        "--port",
        port,
        "--persist-to",
        stateDir,
      ]),
    );
  }

  if (command === "deploy") {
    process.exit(await runWrangler(["deploy", CONFIG_PATH_FLAG, configPath]));
  }

  if (command === "tail") {
    process.exit(await runWrangler(["tail", config.name, CONFIG_PATH_FLAG, configPath, "--format", "pretty"]));
  }

  if (command === "migrate") {
    // Remote by default: the local database is recreated by `wrangler dev`, so
    // applying migrations locally is only useful for inspecting the schema.
    const local = rest.includes("--local");
    const args = ["d1", "migrations", "apply", "BOT_DB", CONFIG_PATH_FLAG, configPath];
    if (local) args.push("--local", "--persist-to", stateDir);
    console.log(`${local ? "local" : "remote"} D1 migrations for ${config.name} (BOT_DB)\n`);
    process.exit(await runWrangler(args));
  }

  if (command === "secrets") {
    if (rest.includes("--list")) {
      process.exit(await runWrangler(["secret", "list", CONFIG_PATH_FLAG, configPath]));
    }
    await setSecrets(rest, dir, configPath, config);
    return;
  }

  // knowledge
  const script = join(dir, "..", "scripts", "sync-knowledge.mjs");
  try {
    await access(script);
  } catch {
    console.error("error: scripts/sync-knowledge.mjs is missing from this checkout.");
    process.exit(1);
  }
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [script, "--number", slug, ...rest], { stdio: "inherit", cwd: join(dir, "..") });
  child.on("close", (code) => process.exit(code ?? 0));
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exit(1);
});
