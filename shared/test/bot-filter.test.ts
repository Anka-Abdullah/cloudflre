/**
 * Filter and extraction tests.
 *
 * These are the rules that decide which WhatsApp traffic the bot is even allowed
 * to look at, so every rejection reason in the work plan (section 4) has an
 * explicit case here — including the ones that are easy to get wrong because
 * wuzapi nests them differently (`IsGroup` for a group, `@newsletter` for a
 * channel, `viewOnceMessage` around a captioned photo).
 */
import { describe, expect, it } from "vitest";
import { extractBody, unwrapMessage } from "../src/bot/text";
import { filterInbound, messageEventOf, parseTimestamp } from "../src/bot/filter";

const NOW = new Date("2026-10-10T08:00:00.000Z");
const options = { voiceEnabled: false, now: () => NOW };
const voiceOptions = { voiceEnabled: true, now: () => NOW };

/** The postmap wuzapi puts in the webhook `jsonData` field. */
function postmap(
  chat: string,
  message: Record<string, unknown>,
  info: Record<string, unknown> = {},
  type = "Message",
): Record<string, unknown> {
  return {
    type,
    userID: "1",
    instanceName: "nomor-1",
    event: {
      Info: {
        Chat: chat,
        Sender: chat,
        IsFromMe: false,
        IsGroup: false,
        ID: "WA-1",
        Timestamp: "2026-10-10T07:59:00Z",
        PushName: "Budi",
        Type: "text",
        ...info,
      },
      Message: message,
    },
  };
}

/** What the queue handler hands to `filterInbound`. */
function inbound(
  chat: string,
  message: Record<string, unknown>,
  info: Record<string, unknown> = {},
  type = "Message",
): { type: string; payload: unknown } {
  return { type, payload: postmap(chat, message, info, type) };
}

describe("filterInbound", () => {
  it("accepts a plain 1:1 text message", () => {
    const result = filterInbound(inbound("628111@s.whatsapp.net", { conversation: "halo" }), options);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.chatJid).toBe("628111@s.whatsapp.net");
    expect(result.message.body).toBe("halo");
    expect(result.message.kind).toBe("text");
    expect(result.message.pushName).toBe("Budi");
    expect(result.message.timestamp).toBe(Date.parse("2026-10-10T07:59:00Z"));
    expect(result.message.waMessageId).toBe("WA-1");
  });

  it("accepts a LID-addressed direct chat", () => {
    const result = filterInbound(inbound("998877@lid", { conversation: "halo" }), options);
    expect(result.ok).toBe(true);
  });

  it("accepts extendedTextMessage over an empty conversation", () => {
    const result = filterInbound(
      inbound("628111@s.whatsapp.net", { conversation: "", extendedTextMessage: { text: "ada stok?" } }),
      options,
    );
    expect(result.ok && result.message.body).toBe("ada stok?");
  });

  it.each([
    ["group", "628999-123@g.us", {}, "group"],
    ["group flag", "628111@s.whatsapp.net", { IsGroup: true }, "group"],
    ["newsletter", "123@newsletter", {}, "newsletter"],
    ["status", "status@broadcast", {}, "status"],
    ["broadcast", "628111@broadcast", {}, "broadcast"],
    ["zero sender", "0@s.whatsapp.net", {}, "unsupported_chat"],
    ["unknown server", "628111@example.com", {}, "unsupported_chat"],
  ])("rejects %s", (_label, chat, info, reason) => {
    const result = filterInbound(inbound(chat, { conversation: "halo" }, info), options);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(reason);
  });

  it("rejects the bot's own echo", () => {
    const result = filterInbound(
      inbound("628111@s.whatsapp.net", { conversation: "halo" }, { IsFromMe: true }),
      options,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("from_me");
  });

  it("rejects non-Message event types", () => {
    const result = filterInbound(
      { type: "Connected", payload: { type: "Connected", event: { Info: {} } } },
      options,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_message");
  });

  it("rejects a Message event with no usable body", () => {
    const result = filterInbound(
      inbound("628111@s.whatsapp.net", { stickerMessage: { mimetype: "image/webp" } }),
      options,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsupported_message");
  });

  it("ignores an audio note while VOICE_ENABLED is false", () => {
    const payload = inbound("628111@s.whatsapp.net", { audioMessage: { seconds: 7 } });
    const off = filterInbound(payload, options);
    expect(off.ok).toBe(false);
    if (!off.ok) expect(off.reason).toBe("voice_disabled");

    const on = filterInbound(payload, voiceOptions);
    // Recognised, but with no transcript it is still not something to answer.
    expect(on.ok).toBe(false);
    if (!on.ok) expect(on.reason).toBe("empty_body");
  });

  it("falls back to the injected clock when Timestamp is missing", () => {
    const payload = inbound("628111@s.whatsapp.net", { conversation: "halo" }, { Timestamp: null });
    const result = filterInbound(payload, options);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.message.timestamp).toBe(NOW.getTime());
  });
});

describe("extractBody", () => {
  it.each([
    ["conversation", { conversation: "halo" }, "text", "halo"],
    ["extendedTextMessage", { extendedTextMessage: { text: "halo" } }, "text", "halo"],
    ["image caption", { imageMessage: { caption: "ini bajunya" } }, "caption", "ini bajunya"],
    ["video caption", { videoMessage: { caption: "videonya" } }, "caption", "videonya"],
    ["document caption", { documentMessage: { caption: "nota" } }, "caption", "nota"],
    ["button reply", { buttonsResponseMessage: { selectedDisplayText: "Ya, lanjut" } }, "button", "Ya, lanjut"],
    ["button id", { buttonsResponseMessage: { selectedButtonId: "btn-1" } }, "button", "btn-1"],
    ["template button", { templateButtonReplyMessage: { selectedId: "tpl-2" } }, "button", "tpl-2"],
    ["list title", { listResponseMessage: { title: "Kaos Polos" } }, "list", "Kaos Polos"],
    ["list row id", { listResponseMessage: { singleSelectReply: { selectedRowId: "SKU-9" } } }, "list", "SKU-9"],
  ])("reads %s", (_label, message, kind, body) => {
    expect(extractBody(message)).toEqual({ kind, body });
  });

  it("unwraps disappearing and view-once wrappers", () => {
    const wrapped = {
      viewOnceMessageV2: { message: { ephemeralMessage: { message: { imageMessage: { caption: "rahasia" } } } } },
    };
    expect(extractBody(wrapped)).toEqual({ kind: "caption", body: "rahasia" });
  });

  it("returns null for a body-less message", () => {
    expect(extractBody({ stickerMessage: {} })).toBeNull();
    expect(extractBody({ conversation: "   " })).toBeNull();
  });

  it("leaves an already-unwrapped message unchanged", () => {
    const message = { conversation: "halo" };
    expect(unwrapMessage(message)).toBe(message);
  });
});

describe("messageEventOf", () => {
  it("accepts the nested postmap and a bare event object", () => {
    const nested = messageEventOf(postmap("628111@s.whatsapp.net", { conversation: "a" }));
    const bare = messageEventOf({ Info: { Chat: "628111@s.whatsapp.net" }, Message: { conversation: "a" } });
    expect(nested?.Info.Chat).toBe("628111@s.whatsapp.net");
    expect(bare?.Info.Chat).toBe("628111@s.whatsapp.net");
  });

  it("returns null when the payload is not a message event", () => {
    expect(messageEventOf(null)).toBeNull();
    expect(messageEventOf({ type: "Connected" })).toBeNull();
  });
});

describe("parseTimestamp", () => {
  it("uses the fallback for an unparsable value", () => {
    expect(parseTimestamp("not a date", NOW)).toBe(NOW.getTime());
    expect(parseTimestamp(null, NOW)).toBe(NOW.getTime());
    expect(parseTimestamp("2026-01-02T03:04:05Z", NOW)).toBe(Date.parse("2026-01-02T03:04:05Z"));
  });
});
