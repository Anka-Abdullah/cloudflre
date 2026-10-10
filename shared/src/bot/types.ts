/**
 * WuzAPI payload shapes and the normalised types the bot works with.
 *
 * Everything here was derived from the Go source in `wuzapi/` rather than from
 * documentation, because the exact nesting decides whether a customer message is
 * answered or silently dropped:
 *
 *   wmiau.go  myEventHandler()      → postmap = { type, event: <raw event> }
 *   wmiau.go  onMessage(events.Message) → event = { Info, Message, IsEphemeral, … }
 *   wuzapi/helpers.go callHookWithHmac() → form-encoded jsonData=<that JSON>,
 *                                          or the same object when WEBHOOK_FORMAT=json
 *
 * `shared/src/ingest/parse.ts` already unwraps the transport, so by the time the
 * bot sees a payload it is always the postmap object: `payload.event.Info`.
 */

export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null;
}

export function asString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export function asBoolean(value: unknown): boolean {
  return value === true;
}

/** `Info` of a wuzapi `Message` event (`whatsmeow` types.MessageInfo). */
export interface WuzapiMessageInfo {
  Chat: string;
  Sender?: string | null;
  IsFromMe?: boolean;
  IsGroup?: boolean;
  ID?: string | null;
  Timestamp?: string | null;
  Type?: string | null;
  PushName?: string | null;
  Category?: string | null;
}

/** The `event` object of a `Message` webhook. */
export interface WuzapiMessageEvent {
  Info: WuzapiMessageInfo;
  Message: JsonRecord;
  IsEphemeral?: boolean;
  IsViewOnce?: boolean;
}

export type MessageKind = "text" | "caption" | "button" | "list" | "audio";

/** A customer message that survived filtering. */
export interface InboundMessage {
  chatJid: string;
  senderJid: string;
  waMessageId: string;
  pushName: string;
  /** Epoch milliseconds, UTC. */
  timestamp: number;
  kind: MessageKind;
  /** Text as the customer wrote it; empty for an audio-only message. */
  body: string;
}

/** Why an event did not become an `InboundMessage`; logged, never sent to users. */
export type FilterReason =
  | "not_message"
  | "from_me"
  | "group"
  | "newsletter"
  | "broadcast"
  | "status"
  | "unsupported_chat"
  | "empty_body"
  | "unsupported_message"
  | "voice_disabled";

export interface ChatMessage {
  direction: "in" | "out";
  kind: MessageKind;
  body: string;
  createdAt: number;
}

/** What the agent is allowed to ask the outbound layer to do. */
export interface OutboundText {
  kind: "text";
  body: string;
}

export interface OutboundImage {
  kind: "image";
  /** Base64 (no data: prefix) or an https URL wuzapi can fetch. */
  image: string;
  caption: string;
  mimeType?: string;
}

export interface OutboundDocument {
  kind: "document";
  /** Base64 (no data: prefix) or an https URL wuzapi can fetch. */
  document: string;
  fileName: string;
  caption?: string;
  mimeType?: string;
}

export type OutboundMessage = OutboundText | OutboundImage | OutboundDocument;

/** Everything the responder needs to decide what to answer. */
export interface ReplyContext {
  slug: string;
  chatJid: string;
  pushName: string;
  /** The message being answered. */
  message: InboundMessage;
  /** Oldest first, excluding the current message. */
  history: ChatMessage[];
  now: Date;
}
