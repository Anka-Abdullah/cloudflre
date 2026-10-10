/**
 * Pulls the customer's text out of a wuzapi `Message` object.
 *
 * wuzapi forwards the raw `waE2E.Message` protobuf as JSON, so the same sentence
 * can arrive under a dozen different keys depending on how the customer sent it
 * (typed, captioned, tapped a button, picked from a list, replied with a
 * template button). Missing one of them means the bot looks like it ignored the
 * customer, so every shape the dashboard can produce is handled here and the
 * `kind` is recorded so replies can be tuned per shape.
 */
import { asRecord, asString, type JsonRecord, type MessageKind } from "./types";

export interface ExtractedBody {
  kind: MessageKind;
  body: string;
}

/**
 * Wrappers WhatsApp puts around the real message. A disappearing-message chat or
 * a "view once" photo nests the actionable message one or two levels down, so it
 * is unwrapped before extraction instead of being treated as unsupported.
 */
const WRAPPERS = [
  "ephemeralMessage",
  "viewOnceMessage",
  "viewOnceMessageV2",
  "viewOnceMessageV2Extension",
  "documentWithCaptionMessage",
  "editedMessage",
] as const;

/** Returns the innermost message that still has an unwrappable payload. */
export function unwrapMessage(message: JsonRecord): JsonRecord {
  let current = message;
  for (let depth = 0; depth < WRAPPERS.length; depth++) {
    let unwrapped = false;
    for (const wrapper of WRAPPERS) {
      const inner = asRecord(asRecord(current[wrapper])?.["message"]);
      if (inner) {
        current = inner;
        unwrapped = true;
        break;
      }
    }
    if (!unwrapped) break;
  }
  return current;
}

function nonEmpty(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function textOf(message: JsonRecord, key: string, field: string): string | null {
  return nonEmpty(asString(asRecord(message[key])?.[field]));
}

function captionOf(message: JsonRecord, key: string): string | null {
  return textOf(message, key, "caption");
}

/**
 * Extracts the reply text, or null when the message carries no usable text.
 *
 * Order matters: a wuzapi message object normally holds exactly one of these
 * keys, but `extendedTextMessage` wins over `conversation` when both are present
 * (WhatsApp sends an empty `conversation` alongside link previews).
 */
export function extractBody(message: JsonRecord): ExtractedBody | null {
  const inner = unwrapMessage(message);

  const extended = textOf(inner, "extendedTextMessage", "text");
  if (extended !== null) return { kind: "text", body: extended };

  const conversation = nonEmpty(asString(inner["conversation"]));
  if (conversation !== null) return { kind: "text", body: conversation };

  const buttonReply =
    textOf(inner, "buttonsResponseMessage", "selectedDisplayText") ??
    textOf(inner, "buttonsResponseMessage", "selectedButtonId") ??
    textOf(inner, "templateButtonReplyMessage", "selectedDisplayText") ??
    textOf(inner, "templateButtonReplyMessage", "selectedId");
  if (buttonReply !== null) return { kind: "button", body: buttonReply };

  const listReply =
    textOf(inner, "listResponseMessage", "title") ??
    nonEmpty(asString(asRecord(asRecord(inner["listResponseMessage"])?.["singleSelectReply"])?.["selectedRowId"]));
  if (listReply !== null) return { kind: "list", body: listReply };

  const caption =
    captionOf(inner, "imageMessage") ?? captionOf(inner, "videoMessage") ?? captionOf(inner, "documentMessage");
  if (caption !== null) return { kind: "caption", body: caption };

  // Audio is recognised but carries no text; the caller decides what to do with
  // it (VOICE_ENABLED is false until phase 9).
  if (asRecord(inner["audioMessage"]) !== null) return { kind: "audio", body: "" };

  return null;
}
