/**
 * Dead-letter consumer.
 *
 * Without RabbitMQ there is no external error queue any more, so failed
 * deliveries land here instead of disappearing: each record is archived to R2
 * under `_dlq/` and announced — to `ALERT_WEBHOOK_URL` and/or to the admin's
 * Telegram chat — exactly once per record.
 * The message is only acknowledged after the archive write succeeds, so a
 * storage outage keeps records in the queue (retention: 4 days by default,
 * 24 hours on the Workers Free plan).
 *
 * The alert is best-effort on purpose: a failing webhook or a blocked bot must
 * not keep a dead letter in the queue forever, because the R2 archive already
 * holds the record.
 */
import { type Env, type InstanceConfig } from "../config";
import { type DlqRecord } from "../envelope";
import { createLogger } from "../lib/logger";
import { TelegramClient } from "../bot/telegram/client";

export interface DlqDeps {
  now?: () => Date;
  log?: ReturnType<typeof createLogger>;
  put?: (key: string, value: string) => Promise<unknown>;
  fetchImpl?: typeof fetch;
  /** Test seam: replaces the Telegram alerter. */
  telegram?: TelegramClient;
}

export interface DlqOptions {
  env: Env;
  config: InstanceConfig;
  deps?: DlqDeps;
}

const ALERT_TIMEOUT_MS = 10_000;

/** One Telegram message per record: what failed, where, and the R2 key. */
export function dlqAlertText(slug: string, queue: string, record: DlqRecord | null, key: string, attempts: number): string {
  return [
    `DLQ ${slug}`,
    "",
    `Antrean  : ${queue}`,
    `Tahap    : ${record?.stage ?? "unknown"}`,
    `Alasan   : ${record?.reason ?? "n/a"}`,
    `Percobaan: ${attempts}`,
    `Arsip R2 : ${key}`,
    "",
    "Periksa `wrangler tail` lalu kirim ulang bila perlu.",
  ].join("\n");
}

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

  const telegram =
    deps.telegram ??
    (config.bot.telegramEnabled && config.bot.telegramBotToken !== "" && config.bot.telegramChatId !== ""
      ? new TelegramClient({
          botToken: config.bot.telegramBotToken,
          chatId: config.bot.telegramChatId,
          apiBase: config.bot.telegramApiBase,
          deps: { log, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) },
        })
      : null);

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

    if (telegram) {
      const sent = await telegram.sendMessage(dlqAlertText(config.slug, batch.queue, record ?? null, key, message.attempts));
      log.info("dlq_alert", {
        channel: "telegram",
        ok: sent.ok,
        messageId: message.id,
        error: sent.error === "" ? null : sent.error,
      });
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
