/**
 * Queue consumer: relays each envelope to the bot and decides ack vs retry.
 *
 * Cloudflare Queues redelivers a message until `max_retries` (configured per
 * consumer in wrangler.jsonc) and then moves it to the dead-letter queue, so the
 * worker only classifies the outcome:
 *
 *   2xx                     -> ack
 *   4xx (except 408/425/429) -> permanent: ack and archive to the DLQ
 *   5xx / 429 / network      -> retry with exponential backoff
 */
import { type Env, type InstanceConfig } from "../config";
import { type DlqRecord, type EnvelopeV1, isEnvelopeV1 } from "../envelope";
import { createLogger } from "../lib/logger";
import { retryDelaySeconds } from "../lib/backoff";
import { hmacSha256Hex } from "../lib/hmac";

const DOWNSTREAM_TIMEOUT_MS = 20_000;
const PERMANENT_STATUS = new Set([400, 401, 402, 403, 404, 405, 406, 409, 410, 411, 412, 413, 414, 415, 422, 501]);

export interface ConsumerDeps {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: ReturnType<typeof createLogger>;
  random?: () => number;
  sendDlq?: (record: DlqRecord) => Promise<unknown>;
}

export interface ConsumerOptions {
  env: Env;
  config: InstanceConfig;
  deps?: ConsumerDeps;
}

function isRetryableStatus(status: number): boolean {
  if (status === 408 || status === 425 || status === 429) return true;
  if (status >= 500) return true;
  return false;
}

export async function handleEventsBatch(
  batch: MessageBatch<unknown>,
  options: ConsumerOptions,
): Promise<void> {
  const { env, config } = options;
  const deps = options.deps ?? {};
  const log = deps.log ?? createLogger({ slug: config.slug, handler: "relay" });
  const now = deps.now ?? (() => new Date());
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sendDlq = deps.sendDlq ?? ((record: DlqRecord) => env.DLQ.send(record, { contentType: "json" }));

  for (const message of batch.messages) {
    const body = message.body;

    const archive = async (stage: DlqRecord["stage"], reason: string, envelope: unknown): Promise<void> => {
      try {
        await sendDlq({
          v: 1,
          failedAt: now().toISOString(),
          stage,
          reason,
          queue: batch.queue,
          messageId: message.id,
          attempts: message.attempts,
          envelope,
        });
      } catch (error) {
        log.error("relay_dlq_write_failed", { error: String(error), messageId: message.id });
      }
    };

    if (!isEnvelopeV1(body)) {
      log.warn("relay_poison_message", { messageId: message.id });
      await archive("relay", "message body is not an envelope v1", body);
      message.ack();
      continue;
    }

    if (config.relayMode === "observe") {
      log.info("relay_observed", {
        deliveryId: body.deliveryId,
        eventType: body.event.type,
        kind: body.kind,
        attempt: message.attempts,
      });
      message.ack();
      continue;
    }

    if (config.downstreamUrl === "") {
      log.error("relay_misconfigured", { reason: "DOWNSTREAM_URL is empty while RELAY_MODE=relay" });
      await archive("relay", "DOWNSTREAM_URL is not configured", body);
      message.ack();
      continue;
    }

    const payload = JSON.stringify(body);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": `wuzapi-queue-relay/${config.slug}`,
      "x-wuzip-delivery-id": body.deliveryId,
      "x-wuzip-attempt": String(message.attempts),
      "x-wuzip-queue-message-id": message.id,
      "x-wuzip-slug": config.slug,
      "x-wuzip-kind": body.kind,
    };
    if (body.event.type) headers["x-wuzip-event-type"] = body.event.type;
    if (body.event.userID) headers["x-wuzip-user-id"] = body.event.userID;
    if (config.downstreamHmacKey !== "") {
      const signature = await hmacSha256Hex(new TextEncoder().encode(config.downstreamHmacKey), new TextEncoder().encode(payload));
      headers["x-wuzip-signature"] = `sha256=${signature}`;
    }

    let response: Response;
    try {
      response = await fetchImpl(config.downstreamUrl, {
        method: "POST",
        headers,
        body: payload,
        signal: AbortSignal.timeout(DOWNSTREAM_TIMEOUT_MS),
      });
    } catch (error) {
      const delaySeconds = retryDelaySeconds(message.attempts, {
        baseSeconds: config.retryBaseSeconds,
        maxSeconds: config.retryMaxSeconds,
        ...(deps.random ? { random: deps.random } : {}),
      });
      log.warn("relay_network_error", {
        error: String(error),
        deliveryId: body.deliveryId,
        attempt: message.attempts,
        retryInSeconds: delaySeconds,
      });
      message.retry({ delaySeconds });
      continue;
    }

    if (response.ok) {
      log.info("relay_delivered", {
        deliveryId: body.deliveryId,
        status: response.status,
        attempt: message.attempts,
        eventType: body.event.type,
      });
      message.ack();
      continue;
    }

    const detail = await safeText(response);

    if (PERMANENT_STATUS.has(response.status)) {
      log.error("relay_rejected", {
        deliveryId: body.deliveryId,
        status: response.status,
        attempt: message.attempts,
        detail: detail.slice(0, 500),
      });
      await archive("relay", `downstream responded ${response.status}: ${detail.slice(0, 500)}`, body);
      message.ack();
      continue;
    }

    if (isRetryableStatus(response.status)) {
      const delaySeconds = retryDelaySeconds(message.attempts, {
        baseSeconds: config.retryBaseSeconds,
        maxSeconds: config.retryMaxSeconds,
        ...(deps.random ? { random: deps.random } : {}),
      });
      log.warn("relay_retry", {
        deliveryId: body.deliveryId,
        status: response.status,
        attempt: message.attempts,
        retryInSeconds: delaySeconds,
      });
      message.retry({ delaySeconds });
      continue;
    }

    // Unclassified (for example 3xx): treat as permanent so it cannot loop.
    log.error("relay_unexpected_status", {
      deliveryId: body.deliveryId,
      status: response.status,
      detail: detail.slice(0, 500),
    });
    await archive("relay", `unexpected downstream status ${response.status}`, body);
    message.ack();
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

export type { EnvelopeV1 };
