/**
 * Queue consumer router for `BOT_MODE=shadow|on`.
 *
 * Cloudflare Queues decides *whether* a message comes back (retry budget, then
 * the DLQ); this file decides *what* happens to it and whether it is
 * acknowledged. The rules mirror the relay consumer deliberately, so an operator
 * moving a number from relay to bot does not have to learn a second set of
 * failure semantics:
 *
 *   handled            → ack
 *   not an envelope v1 → ack + DLQ (poison message, retrying cannot help)
 *   unknown kind       → ack + DLQ
 *   transient failure  → retry with exponential backoff
 */
import { type Env, type InstanceConfig } from "../../config";
import { type DlqRecord, ENVELOPE_VERSION, isEnvelopeV1, isWuzapiEventKind } from "../../envelope";
import { retryDelaySeconds } from "../../lib/backoff";
import { createLogger } from "../../lib/logger";
import {
  createBotRuntime,
  handleOutboxTick,
  handlePaymentEvent,
  handleWuzapiEvent,
  type BotDeps,
  type BotRuntime,
  type Disposition,
} from "./handlers";

export interface BotBatchOptions {
  env: Env;
  config: InstanceConfig;
  deps?: BotDeps;
}

export async function handleBotBatch(batch: MessageBatch<unknown>, options: BotBatchOptions): Promise<void> {
  const { env, config } = options;
  const deps = options.deps ?? {};
  const log = deps.log ?? createLogger({ slug: config.slug, handler: "bot" });
  const now = deps.now ?? (() => new Date());
  const runtime: BotRuntime = createBotRuntime({ env, config, deps: { ...deps, log, now } });
  const sendDlq = runtime.sendDlq;

  for (const message of batch.messages) {
    const body = message.body;

    const archive = async (reason: string, payload: unknown): Promise<void> => {
      const record: DlqRecord = {
        v: ENVELOPE_VERSION,
        failedAt: now().toISOString(),
        stage: "relay",
        reason,
        queue: batch.queue,
        messageId: message.id,
        attempts: message.attempts,
        envelope: payload,
      };
      try {
        await sendDlq(record);
      } catch (error) {
        log.error("dlq_write_failed", { error: String(error), messageId: message.id });
      }
    };

    if (!isEnvelopeV1(body)) {
      log.warn("bot_poison_message", { messageId: message.id });
      await archive("message body is not an envelope v1", body);
      message.ack();
      continue;
    }

    let disposition: Disposition;
    try {
      if (isWuzapiEventKind(body.kind)) {
        disposition = await handleWuzapiEvent(body, runtime);
      } else if (body.kind === "payment.event") {
        disposition = await handlePaymentEvent(body, runtime);
      } else if (body.kind === "outbox.tick") {
        disposition = await handleOutboxTick(body, runtime);
      } else {
        log.warn("bot_unknown_kind", { kind: body.kind, messageId: message.id });
        await archive(`unknown envelope kind ${JSON.stringify(body.kind)}`, body);
        message.ack();
        continue;
      }
    } catch (error) {
      // handleWuzapiEvent never throws, but the payment/outbox handlers will once
      // phase 5 gives them real work; an unexpected throw must still be a retry.
      const detail = error instanceof Error ? error.message : String(error);
      log.error("bot_handler_crashed", { error: detail, messageId: message.id, kind: body.kind });
      disposition = { action: "retry", delaySeconds: 30 };
    }

    if (disposition.action === "ack") {
      message.ack();
      continue;
    }

    // A handler that asks for a retry gets the same capped, jittered backoff as
    // the relay path, calculated from the queue's own attempt counter.
    const delaySeconds = Math.max(
      disposition.delaySeconds,
      retryDelaySeconds(message.attempts, {
        baseSeconds: config.retryBaseSeconds,
        maxSeconds: config.retryMaxSeconds,
      }),
    );
    log.info("bot_retry", { messageId: message.id, delaySeconds, attempt: message.attempts });
    message.retry({ delaySeconds });
  }
}
