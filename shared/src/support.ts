/**
 * Small helpers shared by the worker entry point and the package root.
 * Kept out of index.ts so worker.ts never imports the barrel it is exported from.
 */
import { ConfigError, loadConfig, type Env, type InstanceConfig } from "./config";
import { createLogger } from "./lib/logger";

/** Queue-name convention: `<worker>-dlq`, overridable with the DLQ_QUEUE_NAME var. */
export function isDlqQueue(queueName: string, env: Pick<Env, "DLQ_QUEUE_NAME">): boolean {
  const configured = (env.DLQ_QUEUE_NAME ?? "").trim();
  if (configured !== "") return queueName === configured;
  return queueName.endsWith("-dlq");
}

/**
 * Parses configuration or reports the reason, so handlers answer with a clear
 * 500 instead of throwing an opaque error on every request.
 */
export function resolveConfig(
  env: Env,
  handler: string,
): { config: InstanceConfig; error: null } | { config: null; error: string } {
  try {
    return { config: loadConfig(env), error: null };
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : String(error);
    createLogger({ slug: env.INSTANCE_SLUG ?? "unknown", handler }).error("config_invalid", { reason: message });
    return { config: null, error: message };
  }
}
