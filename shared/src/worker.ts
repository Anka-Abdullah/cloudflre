/**
 * Worker entry factory.
 *
 * Instances only write `export default createWorker()` (see _template/src/index.ts):
 * every binding name, var and secret is resolved from that number's own
 * wrangler.jsonc, so nothing about one number is hard-coded in shared code.
 *
 * `BOT_MODE` selects what the queue consumer does, and it is the rollback switch
 * of the whole automation (work plan section 1):
 *
 *   off    → relay each envelope to DOWNSTREAM_URL (the original behaviour)
 *   shadow → run the full bot pipeline, send nothing to the customer
 *   on     → run the pipeline and answer
 */
import { botReadiness, type Env } from "./config";
import { createLogger } from "./lib/logger";
import { handleIngest } from "./ingest/handler";
import { handleEventsBatch } from "./consumer/relay";
import { handleDlqBatch } from "./consumer/dlq";
import { handleBotBatch } from "./bot/queue/router";
import { isDlqQueue, resolveConfig } from "./support";

export interface WorkerDeps {
  /** Test seam for the downstream relay call and the WuzAPI client. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: (line: string) => void;
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function createWorker(deps: WorkerDeps = {}): ExportedHandler<Env, unknown> {
  const queueDeps = {
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.log ? { log: createLogger({ handler: "queue" }, deps.log) } : {}),
  };

  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const { config, error } = resolveConfig(env, "ingest");
      if (!config) return json(500, { error: `invalid configuration: ${error}` });

      const url = new URL(request.url);

      if (url.pathname === "/healthz") {
        const readiness = botReadiness(config, env);
        return json(200, {
          ok: true,
          slug: config.slug,
          hmacMode: config.hmacMode,
          hmacKeys: config.hmacKeys.length,
          mediaMode: config.mediaMode,
          relayMode: config.relayMode,
          botMode: config.bot.mode,
          knowledgeMode: config.bot.knowledgeMode,
          aiModel: config.bot.aiModel,
          // Presence only: this endpoint is public, so no value is ever echoed.
          bindings: {
            EVENTS: env.EVENTS !== undefined,
            DLQ: env.DLQ !== undefined,
            MEDIA: env.MEDIA !== undefined,
            BOT_DB: env.BOT_DB !== undefined,
            KNOWLEDGE_KV: env.KNOWLEDGE_KV !== undefined,
            CHAT_COORDINATOR: env.CHAT_COORDINATOR !== undefined,
          },
          bot: { ready: readiness.ready, missing: readiness.missing, missingBindings: readiness.missingBindings },
          wuzapiConfigured: config.bot.wuzapiApiBase !== "" && config.bot.wuzapiToken !== "",
          aiConfigured: config.bot.aiBaseUrl !== "" && config.bot.aiApiKey !== "",
          paymentConfigured: config.bot.paymentApiBase !== "" && config.bot.paymentApiKey !== "",
          telegramConfigured:
            config.bot.telegramEnabled && config.bot.telegramBotToken !== "" && config.bot.telegramChatId !== "",
          downstreamConfigured: config.downstreamUrl !== "",
          r2PublicBaseUrl: config.r2PublicBaseUrl !== "",
        });
      }

      if (url.pathname === "/" || url.pathname === "") {
        return json(200, { worker: config.slug, hint: "POST /ingest/<token> where <token> is the INGEST_TOKEN secret" });
      }

      if (url.pathname.startsWith("/ingest/")) {
        return await handleIngest(request, {
          env,
          config,
          deps: {
            ...(deps.now ? { now: deps.now } : {}),
            ...(deps.log ? { log: createLogger({ slug: config.slug, handler: "ingest" }, deps.log) } : {}),
          },
        });
      }

      return json(404, { error: "not found" });
    },

    async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
      const { config, error } = resolveConfig(env, "queue");
      if (!config) {
        // Without a valid configuration nothing can be relayed; retrying only
        // delays the inevitable, so acknowledge and leave a log line behind.
        createLogger({ slug: env.INSTANCE_SLUG ?? "unknown", handler: "queue" }).error("queue_config_invalid", {
          queue: batch.queue,
          reason: error,
        });
        batch.ackAll();
        return;
      }

      if (isDlqQueue(batch.queue, env)) {
        await handleDlqBatch(batch, { env, config, deps: queueDeps });
        return;
      }

      if (config.bot.mode === "off") {
        await handleEventsBatch(batch, { env, config, deps: queueDeps });
        return;
      }

      await handleBotBatch(batch, { env, config, deps: queueDeps });
    },
  };
}
