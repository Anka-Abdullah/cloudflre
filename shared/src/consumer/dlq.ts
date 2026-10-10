/**
 * Dead-letter consumer.
 *
 * Without RabbitMQ there is no external error queue any more, so failed
 * deliveries land here instead of disappearing: each record is archived to R2
 * under `_dlq/` and, when ALERT_WEBHOOK_URL is configured, announced once.
 * The message is only acknowledged after the archive write succeeds, so a
 * storage outage keeps records in the queue (retention: 4 days by default,
 * 24 hours on the Workers Free plan).
 */
import { type Env, type InstanceConfig } from "../config";
import { type DlqRecord } from "../envelope";
import { createLogger } from "../lib/logger";

export interface DlqDeps {
  now?: () => Date;
  log?: ReturnType<typeof createLogger>;
  put?: (key: string, value: string) => Promise<unknown>;
  fetchImpl?: typeof fetch;
}

export interface DlqOptions {
  env: Env;
  config: InstanceConfig;
  deps?: DlqDeps;
}

const ALERT_TIMEOUT_MS = 10_000;

export async function handleDlqBatch(batch: MessageBatch<unknown>, options: DlqOptions): Promise<void> {
  const { env, config } = options;
  const deps = options.deps ?? {};
  const log = deps.log ?? createLogger({ slug: config.slug, handler: "dlq" });
  const now = deps.now ?? (() => new Date());
  const fetchImpl = deps.fetchImpl ?? fetch;
  const putObject =
    deps.put ??
    ((key: string, value: string) =>
      env.MEDIA.put(key, value, { httpMetadata: { contentType: "application/json" } }));

  for (const message of batch.messages) {
    const record = message.body as DlqRecord | undefined;
    const day = now().toISOString().slice(0, 10);
    const key = `_dlq/${config.slug}/${day}/${message.id}.json`;

    try {
      await putObject(
        key,
        JSON.stringify({
          archivedAt: now().toISOString(),
          queue: batch.queue,
          messageId: message.id,
          attempts: message.attempts,
          record: record ?? null,
        }),
      );
    } catch (error) {
      log.error("dlq_archive_failed", { error: String(error), messageId: message.id, key });
      message.retry({ delaySeconds: 60 });
      continue;
    }

    if (config.alertWebhookUrl !== "") {
      try {
        await fetchImpl(config.alertWebhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: `wuzapi ${config.slug}: delivery failed (${record?.stage ?? "unknown"}): ${record?.reason ?? "n/a"}`,
            slug: config.slug,
            queue: batch.queue,
            messageId: message.id,
            attempts: message.attempts,
            r2Key: key,
            record: record ?? null,
          }),
          signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
        });
      } catch (error) {
        log.warn("dlq_alert_failed", { error: String(error), messageId: message.id });
      }
    }

    log.warn("dlq_archived", {
      messageId: message.id,
      r2Key: key,
      stage: record?.stage ?? null,
      reason: record?.reason ?? null,
      attempts: message.attempts,
    });
    message.ack();
  }
}
