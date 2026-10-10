/**
 * Per-file test setup, run inside workerd before any test in the file.
 *
 * The Workers Vitest integration gives every test file its own isolated storage,
 * so a test file that forgets to apply the D1 migrations sees an empty database
 * and fails with "no such table" — a confusing failure that has nothing to do
 * with the code under test. Applying them once here (they are tracked in
 * `d1_migrations`, so re-applying is a no-op) removes that trap for every
 * current and future test file.
 */
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import type { D1MigrationFile } from "../src/config";

const bindings = env as unknown as { BOT_DB?: D1Database; TEST_MIGRATIONS?: D1MigrationFile[] };

if (bindings.BOT_DB && bindings.TEST_MIGRATIONS) {
  await applyD1Migrations(bindings.BOT_DB, bindings.TEST_MIGRATIONS);
}
