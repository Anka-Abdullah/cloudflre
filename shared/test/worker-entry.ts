/**
 * Worker under test: exactly what an instance folder deploys, so integration
 * tests exercise the same bindings, vars and routing as production.
 *
 * The only addition is the outbound-fetch seam (`helpers.ts`): when a test
 * installs a stub, every client the worker builds for itself — WuzAPI, Telegram,
 * the payment gateway — goes through it. Without that, a test driving routes
 * through `SELF.fetch` could not intercept calls to third parties that the worker
 * constructs from `env` alone.
 */
import { createWorker } from "../src/index";
import { testWorkerDeps } from "./helpers";

export default createWorker(testWorkerDeps());

// Durable Object classes must be exported from the Worker's main module.
export { ChatCoordinator } from "../src/bot/coordinator/chat-lock";
