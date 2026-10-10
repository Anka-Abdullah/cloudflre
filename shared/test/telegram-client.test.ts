/**
 * Telegram Bot API client tests (FASE 5b/7).
 *
 * The client is the only thing standing between the worker and Telegram, and its
 * failure modes are the ones that decide whether an approval card survives a bad
 * minute: a 429 must be retried after the `retry_after` Telegram asks for, a 5xx
 * must be retried with backoff, and a 4xx (blocked bot, "message is not
 * modified") must be reported as permanent so nobody retries it forever.
 *
 * All of it runs against a stubbed `fetch`, with sleeps recorded instead of
 * performed.
 */
import { describe, expect, it } from "vitest";
import { TelegramClient } from "../src/bot/telegram/client";
import { createLogger } from "../src/lib/logger";
import { stubRoutes } from "./helpers";

const quiet = createLogger({ handler: "test" }, () => {});

function client(
  routes: Record<string, { body?: unknown; status?: number } | ((init?: RequestInit) => { body?: unknown; status?: number })>,
  options: { token?: string; chatId?: string } = {},
) {
  const { stub, calls } = stubRoutes(routes);
  const sleeps: number[] = [];
  return {
    calls,
    sleeps,
    client: new TelegramClient({
      botToken: options.token ?? "bot-token",
      chatId: options.chatId ?? "-100123",
      apiBase: "https://api.telegram.test",
      deps: {
        fetchImpl: stub,
        log: quiet,
        sleep: async (ms) => void sleeps.push(ms),
        retryDelaysMs: [10, 20, 40],
      },
    }),
  };
}

describe("configuration", () => {
  it("refuses to call without a token or chat id", async () => {
    const empty = client({}, { token: "" });
    const result = await empty.client.sendMessage("halo");
    expect(result).toMatchObject({ ok: false, permanent: true, attempts: 0 });
    expect(empty.calls).toHaveLength(0);
  });
});

describe("sendMessage", () => {
  it("posts the documented body and returns the message id", async () => {
    const harness = client({ "/sendMessage": { body: { ok: true, result: { message_id: 42 } } } });
    const result = await harness.client.sendMessage("halo", { disablePreview: true });

    expect(result).toMatchObject({ ok: true, messageId: 42, attempts: 1 });
    const call = harness.calls[0]!;
    expect(call.url).toBe("https://api.telegram.test/botbot-token/sendMessage");
    expect(call.body).toMatchObject({ chat_id: "-100123", text: "halo" });
  });

  it("carries an inline keyboard and a force_reply marker", async () => {
    const harness = client({ "/sendMessage": { body: { ok: true, result: { message_id: 1 } } } });
    await harness.client.sendMessage("kartu", {
      replyMarkup: { inline_keyboard: [[{ text: "Terima", callback_data: "o:INV-1:a" }]] },
    });
    await harness.client.sendMessage("biaya?", { replyMarkup: { force_reply: true, selective: true } });

    expect(harness.calls[0]?.body).toMatchObject({
      reply_markup: { inline_keyboard: [[{ text: "Terima", callback_data: "o:INV-1:a" }]] },
    });
    expect(harness.calls[1]?.body).toMatchObject({ reply_markup: { force_reply: true, selective: true } });
  });
});

describe("retry behaviour", () => {
  it("honours retry_after on a 429", async () => {
    let attempt = 0;
    const harness = client({
      "/sendMessage": () => {
        attempt += 1;
        return attempt === 1
          ? { status: 429, body: { ok: false, description: "Too Many Requests", parameters: { retry_after: 3 } } }
          : { body: { ok: true, result: { message_id: 7 } } };
      },
    });

    const result = await harness.client.sendMessage("halo");
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(harness.sleeps).toEqual([3_000]);
  });

  it("retries a 5xx with the configured ladder and gives up", async () => {
    const harness = client({ "/sendMessage": { status: 503, body: { ok: false, description: "Bad Gateway" } } });
    const result = await harness.client.sendMessage("halo");

    expect(result).toMatchObject({ ok: false, permanent: false, attempts: 4 });
    expect(harness.sleeps).toEqual([10, 20, 40]);
  });

  it("treats a 4xx as permanent", async () => {
    const harness = client({ "/sendMessage": { status: 403, body: { ok: false, description: "bot was blocked by the user" } } });
    const result = await harness.client.sendMessage("halo");

    expect(result).toMatchObject({ ok: false, permanent: true, attempts: 1 });
    expect(result.error).toContain("blocked");
    expect(harness.sleeps).toEqual([]);
  });

  it("retries a network failure and reports the error", async () => {
    const harness = client({
      "/sendMessage": () => {
        throw new Error("ECONNRESET");
      },
    });
    const result = await harness.client.sendMessage("halo");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ECONNRESET");
    expect(harness.sleeps.length).toBe(3);
  });
});

describe("other methods", () => {
  it("edits a message and answers a callback query", async () => {
    const harness = client({
      "/editMessageText": { body: { ok: true, result: { message_id: 5 } } },
      "/answerCallbackQuery": { body: { ok: true, result: true } },
      "/sendDocument": { body: { ok: true, result: { message_id: 6 } } },
    });

    expect(await harness.client.editMessageText(5, "diedit")).toMatchObject({ ok: true, messageId: 5 });
    expect(await harness.client.answerCallbackQuery("cb-1", { text: "ok", showAlert: true })).toMatchObject({ ok: true });
    expect(await harness.client.sendDocument("JVBERi0=", "Nota.pdf", { caption: "nota" })).toMatchObject({ ok: true, messageId: 6 });

    expect(harness.calls[1]?.body).toMatchObject({ callback_query_id: "cb-1", text: "ok", show_alert: true });
    expect(harness.calls[2]?.body).toMatchObject({ file_name: "Nota.pdf", caption: "nota" });
  });

  it("treats HTTP 200 with ok:false as a permanent failure", async () => {
    // Telegram does this for "message is not modified" and for a blocked bot.
    const harness = client({ "/editMessageText": { body: { ok: false, description: "message is not modified" } } });
    const result = await harness.client.editMessageText(5, "sama");
    expect(result).toMatchObject({ ok: false, permanent: true });
  });
});
