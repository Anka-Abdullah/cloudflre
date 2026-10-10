/**
 * Workers Vitest integration: tests run inside workerd with real bindings from
 * shared/test/wrangler.jsonc (queues, R2, D1, KV, Durable Objects), so the
 * ingest path and the bot pipeline are exercised the same way Cloudflare runs
 * them.
 *
 * D1 migrations are read from the shared migrations directory and injected as a
 * binding, which is how `cloudflare:test`'s `applyD1Migrations` expects them.
 * Reading them here (instead of copying SQL into the tests) keeps the test
 * database and `pnpm run migrate` on exactly the same schema.
 */
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The pool spawns wrangler inside Node, and wrangler writes a debug log to
// $HOME/.wrangler unless told otherwise. In a sandbox $HOME is not writable, so
// every run printed an EPERM stack trace that looked like a test failure.
// Pointing it inside the repository (git-ignored) silences it; scripts/lib.mjs
// does the same for the CLI commands.
process.env["WRANGLER_LOG_PATH"] ??= new URL("./.wrangler/logs/vitest-wrangler.log", import.meta.url).pathname;

const migrations = await readD1Migrations("./shared/src/bot/migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./shared/test/wrangler.jsonc" },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
    }),
  ],
  test: {
    include: ["shared/test/**/*.test.ts"],
    setupFiles: ["./shared/test/setup.ts"],
    testTimeout: 20_000,
  },
});
