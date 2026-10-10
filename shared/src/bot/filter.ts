/**
 * Decides whether one wuzapi event becomes a customer message the bot answers.
 *
 * The filters are deliberately strict and ordered cheapest-first, because the
 * expensive things behind them (D1 reads, Durable Object lock, AI call) must not
 * run for a group message or for the bot's own reply echoed back by the webhook.
 *
 * The chat-server rules follow the work plan section 4: only 1:1 chats are
 * answered. `@lid` is accepted next to `@s.whatsapp.net` because WhatsApp has
 * been migrating direct chats to LID addressing; dropping those would make the
 * bot silently ignore real customers, while the group/broadcast/status servers
 * stay rejected.
 */
import { extractBody } from "./text";
import {
  asBoolean,
  asRecord,
  asString,
  type FilterReason,
  type InboundMessage,
  type WuzapiMessageEvent,
  type WuzapiMessageInfo,
} from "./types";

const DIRECT_SERVERS = ["s.whatsapp.net", "lid"];

export type FilterResult =
  | { ok: true; message: InboundMessage }
  | { ok: false; reason: FilterReason; chatJid: string | null };

export interface FilterOptions {
  /** VOICE_ENABLED; when false an audio-only message is ignored, not answered. */
  voiceEnabled: boolean;
  /** Injectable clock for the "Timestamp missing" fallback. */
  now?: () => Date;
}

/**
 * Reads the `{ Info, Message, … }` object out of a parsed postmap.
 *
 * `payload` is `{ type, event, userID, instanceName }` for every shape wuzapi
 * produces (see ingest/parse.ts); the raw event is accepted directly as well so
 * a hand-rolled test payload or a future producer still works.
 */
export function messageEventOf(payload: unknown): WuzapiMessageEvent | null {
  const root = asRecord(payload);
  if (!root) return null;
  const candidate = asRecord(root["event"]) ?? root;
  const info = asRecord(candidate["Info"]);
  const message = asRecord(candidate["Message"]);
  if (!info || !message) return null;

  const readInfo: WuzapiMessageInfo = {
    Chat: asString(info["Chat"]) ?? "",
    Sender: asString(info["Sender"]),
    IsFromMe: asBoolean(info["IsFromMe"]),
    IsGroup: asBoolean(info["IsGroup"]),
    ID: asString(info["ID"]),
    Timestamp: asString(info["Timestamp"]),
    Type: asString(info["Type"]),
    PushName: asString(info["PushName"]),
    Category: asString(info["Category"]),
  };

  return {
    Info: readInfo,
    Message: message,
    IsEphemeral: asBoolean(candidate["IsEphemeral"]),
    IsViewOnce: asBoolean(candidate["IsViewOnce"]),
  };
}

/** WhatsApp timestamp strings are RFC3339; anything unparsable falls back to now. */
export function parseTimestamp(raw: string | null | undefined, fallback: Date): number {
  if (!raw) return fallback.getTime();
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : fallback.getTime();
}

function chatRejection(chatJid: string, isGroup: boolean): FilterReason | null {
  if (chatJid.endsWith("@g.us") || isGroup) return "group";
  if (chatJid.endsWith("@newsletter")) return "newsletter";
  if (chatJid.endsWith("@broadcast")) return chatJid.startsWith("status@") ? "status" : "broadcast";
  const server = chatJid.includes("@") ? chatJid.slice(chatJid.indexOf("@") + 1) : "";
  if (server === "") return "unsupported_chat";
  if (!DIRECT_SERVERS.includes(server)) return "unsupported_chat";
  if (chatJid.startsWith("0@")) return "unsupported_chat";
  return null;
}

export function filterInbound(
  input: { type: string | null; payload: unknown },
  options: FilterOptions,
): FilterResult {
  if (input.type !== null && input.type !== "Message") {
    return { ok: false, reason: "not_message", chatJid: null };
  }

  const event = messageEventOf(input.payload);
  if (!event) return { ok: false, reason: "not_message", chatJid: null };

  const chatJid = event.Info.Chat;
  if (chatJid === "") return { ok: false, reason: "unsupported_chat", chatJid: null };

  if (event.Info.IsFromMe === true) return { ok: false, reason: "from_me", chatJid };

  const rejected = chatRejection(chatJid, event.Info.IsGroup === true);
  if (rejected !== null) return { ok: false, reason: rejected, chatJid };

  const extracted = extractBody(event.Message);
  if (!extracted) return { ok: false, reason: "unsupported_message", chatJid };

  if (extracted.kind === "audio" && !options.voiceEnabled) {
    return { ok: false, reason: "voice_disabled", chatJid };
  }
  if (extracted.body === "") return { ok: false, reason: "empty_body", chatJid };

  const now = (options.now ?? (() => new Date()))();
  const message: InboundMessage = {
    chatJid,
    senderJid: event.Info.Sender ?? chatJid,
    waMessageId: event.Info.ID ?? "",
    pushName: event.Info.PushName ?? "",
    timestamp: parseTimestamp(event.Info.Timestamp, now),
    kind: extracted.kind,
    body: extracted.body,
  };
  return { ok: true, message };
}
