/**
 * Worker under test: exactly what an instance folder deploys, so integration
 * tests exercise the same bindings, vars and routing as production.
 */
import { createWorker } from "../src/index";

export default createWorker();

// Durable Object classes must be exported from the Worker's main module.
export { ChatCoordinator } from "../src/bot/coordinator/chat-lock";
