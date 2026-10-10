#!/usr/bin/env node
/**
 * Shared helpers for the per-number scripts: locate an instance folder, read its
 * wrangler.jsonc (JSONC), and run wrangler with sandbox-friendly paths.
 *
 * Everything Cloudflare-related writes inside the repository:
 *  - WRANGLER_LOG_PATH -> cloudflare/.wrangler/logs (wrangler otherwise uses ~/.wrangler)
 *  - --persist-to      -> cloudflare/.wrangler/state (local queue/R2 simulation)
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const cloudflareRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const wranglerBin = join(cloudflareRoot, "node_modules", ".bin", "wrangler");
export const stateDir = join(cloudflareRoot, ".wrangler", "state");
export const logsDir = join(cloudflareRoot, ".wrangler", "logs");
export const registryDir = join(cloudflareRoot, ".wrangler", "registry");
export const cacheDir = join(cloudflareRoot, ".wrangler", "cache");

const E164 = /^[1-9][0-9]{7,14}$/;

/** Accepts `--number 628…`, `628…` and returns the validated slug. */
export function parseNumberArg(argv) {
  let number = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--number" || argv[i] === "-n") number = argv[++i];
    else if (!argv[i].startsWith("-") && number === null) number = argv[i];
  }
  if (!number) throw new Error("--number is required, for example: --number 6281234567890");
  const slug = String(number).replace(/[^0-9]/g, "");
  if (!E164.test(slug)) throw new Error(`"${number}" is not a valid E.164 number without '+'`);
  return slug;
}

export async function instanceDir(slug) {
  const dir = join(cloudflareRoot, slug);
  try {
    await stat(join(dir, "wrangler.jsonc"));
  } catch {
    throw new Error(`${relative(process.cwd(), dir)} not found. Create it with: pnpm run new -- --number ${slug}`);
  }
  return dir;
}

/** Minimal JSONC reader: strips comments and trailing commas, then parses. */
export async function readWranglerConfig(slug) {
  const dir = await instanceDir(slug);
  const raw = await readFile(join(dir, "wrangler.jsonc"), "utf8");
  const withoutComments = raw
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const withoutTrailingCommas = withoutComments.replace(/,(\s*[}\]])/g, "$1");
  try {
    return { dir, config: JSON.parse(withoutTrailingCommas) };
  } catch (error) {
    throw new Error(`could not parse ${relative(process.cwd(), join(dir, "wrangler.jsonc"))}: ${error.message}`);
  }
}

/** Lists the per-number folders (any numeric directory that holds a wrangler.jsonc). */
export async function listInstances() {
  const entries = await readdir(cloudflareRoot, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !E164.test(entry.name)) continue;
    try {
      await stat(join(cloudflareRoot, entry.name, "wrangler.jsonc"));
      found.push(entry.name);
    } catch {
      // Not an instance folder.
    }
  }
  return found.sort();
}

/** Runs wrangler with inherited stdio and repository-local log/state paths. */
export function runWrangler(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(wranglerBin, args, {
      cwd: cloudflareRoot,
      stdio: options.stdio ?? "inherit",
      env: {
        ...process.env,
        // Keep every wrangler artifact inside the repository: the defaults live
        // under $HOME, which is not writable in restricted/sandboxed setups.
        WRANGLER_LOG_PATH: join(logsDir, "wrangler.log"),
        WRANGLER_REGISTRY_PATH: registryDir,
        WRANGLER_CACHE_DIR: cacheDir,
        WRANGLER_SEND_METRICS: process.env.WRANGLER_SEND_METRICS ?? "false",
      },
      ...(options.input === undefined ? {} : { stdio: ["pipe", "inherit", "inherit"] }),
    });
    if (options.input !== undefined && child.stdin) {
      child.stdin.end(options.input);
    }
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", (error) => {
      console.error(`failed to start wrangler: ${error.message}`);
      resolve(1);
    });
  });
}

/** Runs wrangler and captures both streams, for callers that inspect the result. */
export function runWranglerCapture(args) {
  return new Promise((resolve) => {
    const child = spawn(wranglerBin, args, {
      cwd: cloudflareRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        WRANGLER_LOG_PATH: join(logsDir, "wrangler.log"),
        WRANGLER_REGISTRY_PATH: registryDir,
        WRANGLER_CACHE_DIR: cacheDir,
        WRANGLER_SEND_METRICS: process.env.WRANGLER_SEND_METRICS ?? "false",
      },
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk.toString()));
    child.stderr.on("data", (chunk) => (output += chunk.toString()));
    child.on("close", (code) => resolve({ code: code ?? 0, output }));
    child.on("error", (error) => resolve({ code: 1, output: `failed to start wrangler: ${error.message}` }));
  });
}

/** Removes ANSI colour codes so captured wrangler output can be read/reported. */
export function stripAnsi(text) {
  return text.replace(/\u001B\[[0-9;]*m/g, "");
}

const AUTH_PATTERNS = [
  /not authenticated/i,
  /not logged in/i,
  /authentication error/i,
  /invalid api token/i,
  /failed to automatically retrieve account/i,
  /please run `?wrangler login`?/i,
  /more than one account/i,
  /cloudflare_api_token/i,
  /non-interactive environment/i,
];

const EXISTS_PATTERNS = [/already exists/i, /already taken/i, /duplicate/i, /code: 1001[0-9]/i];

/** Runs a create command and classifies the outcome instead of guessing. */
export async function ensureResource(args, label) {
  const { code, output } = await runWranglerCapture(args);
  if (code === 0) return { status: "created", label, output };
  const clean = stripAnsi(output).trim();
  if (AUTH_PATTERNS.some((pattern) => pattern.test(clean))) {
    throw new Error(
      `wrangler is not authenticated (${label}). Run \`npx wrangler login\`, or export CLOUDFLARE_API_TOKEN with Workers Scripts:Edit, Queues:Edit, R2:Edit, D1:Edit and Workers KV Storage:Edit permissions, then retry.`,
    );
  }
  if (EXISTS_PATTERNS.some((pattern) => pattern.test(clean))) return { status: "kept", label, output: clean };
  throw new Error(`could not create ${label}:\n${clean.slice(0, 600)}`);
}

export function randomToken(bytes = 32) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
