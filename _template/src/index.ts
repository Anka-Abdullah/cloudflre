/**
 * Per-number worker entry point.
 *
 * The implementation lives in @wuzip/wuzapi-queue-core so a fix applies to every
 * number; everything that differs per number (bindings, queue names, R2 bucket,
 * D1/KV/DO, vars, secrets) comes from this folder's wrangler.jsonc and
 * `wrangler secret`.
 */
import { ChatCoordinator, createWorker } from "@wuzip/wuzapi-queue-core";

export default createWorker();

// Durable Object classes must be exported from the Worker's main module, or
// wrangler refuses to deploy while `migrations` declares them.
export { ChatCoordinator };
