/**
 * The `no_ai` switch and the manual opt-out.
 *
 * wuzapi never emits an event when a contact name changes, so "bot off for this
 * chat" is derived from two sources that are checked on every inbound message:
 *
 *   1. the D1 `contacts`/`suppressed_chats` tables, refreshed by the periodic
 *      contact sync (`contacts/sync.ts`, phase 4), and
 *   2. `Info.PushName` on the message itself, which is always present and costs
 *      nothing — so a contact renamed to `no_ai` stops the bot immediately,
 *      even before the next sync.
 *
 * The convention (work plan Q21) is a case-insensitive substring match on any
 * known name field, so `Budi no_ai`, `NO_AI` and `no_ai-2` all disable the bot;
 * removing the marker re-enables it on the next check.
 */
import type { JsonRecord } from "../types";

export const NO_AI_MARKER = "no_ai";

export type PolicyReason = "suppressed" | "no_ai_contact" | "no_ai_pushname" | "bot_disabled";

export interface ChatPolicy {
  allowed: boolean;
  reason: PolicyReason | null;
}

export interface ContactRow {
  chat_jid: string;
  full_name: string | null;
  first_name: string | null;
  push_name: string | null;
  business_name: string | null;
  has_no_ai: number;
  updated_at: number;
}

/** True when any supplied name field carries the marker. */
export function containsNoAi(...fields: (string | null | undefined)[]): boolean {
  return fields.some((field) => typeof field === "string" && field.toLowerCase().includes(NO_AI_MARKER));
}

/** Reads the four name fields wuzapi returns from `GET /user/contacts`. */
export function namesFromContact(contact: JsonRecord): {
  fullName: string;
  firstName: string;
  pushName: string;
  businessName: string;
} {
  const pick = (key: string): string => {
    const value = contact[key];
    return typeof value === "string" ? value.trim() : "";
  };
  return {
    fullName: pick("FullName"),
    firstName: pick("FirstName"),
    pushName: pick("PushName"),
    businessName: pick("BusinessName"),
  };
}

/** `has_no_ai` for a freshly synced contact. */
export function noAiFromContact(contact: JsonRecord): boolean {
  const names = namesFromContact(contact);
  return containsNoAi(names.fullName, names.firstName, names.pushName, names.businessName);
}

/**
 * Decides whether the bot may answer this chat.
 *
 * Order: an explicit manual suppression wins over everything, then the synced
 * contact row, then the push name on the message, then the per-chat switch that
 * the admin endpoints flip.
 */
export async function resolveChatPolicy(
  db: D1Database,
  input: { chatJid: string; pushName: string },
): Promise<ChatPolicy> {
  const suppressed = await db
    .prepare("SELECT chat_jid FROM suppressed_chats WHERE chat_jid = ?")
    .bind(input.chatJid)
    .first<{ chat_jid: string }>();
  if (suppressed) return { allowed: false, reason: "suppressed" };

  const contact = await db
    .prepare("SELECT has_no_ai FROM contacts WHERE chat_jid = ?")
    .bind(input.chatJid)
    .first<{ has_no_ai: number }>();
  if (contact && contact.has_no_ai === 1) return { allowed: false, reason: "no_ai_contact" };

  if (containsNoAi(input.pushName)) return { allowed: false, reason: "no_ai_pushname" };

  const state = await db
    .prepare("SELECT bot_enabled FROM chat_state WHERE chat_jid = ?")
    .bind(input.chatJid)
    .first<{ bot_enabled: number }>();
  if (state && state.bot_enabled === 0) return { allowed: false, reason: "bot_disabled" };

  return { allowed: true, reason: null };
}

/**
 * Writes one synced contact and the bot switch it implies. Returns whether the
 * switch changed, so the sync can log only real transitions.
 */
export async function upsertContact(
  db: D1Database,
  input: { chatJid: string; contact: JsonRecord; at: number },
): Promise<{ hasNoAi: boolean; botEnabled: boolean; changed: boolean }> {
  const names = namesFromContact(input.contact);
  const hasNoAi = noAiFromContact(input.contact);
  const previous = await db
    .prepare("SELECT has_no_ai FROM contacts WHERE chat_jid = ?")
    .bind(input.chatJid)
    .first<{ has_no_ai: number }>();

  await db
    .prepare(
      `INSERT INTO contacts (chat_jid, full_name, first_name, push_name, business_name, has_no_ai, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (chat_jid) DO UPDATE SET
         full_name = excluded.full_name,
         first_name = excluded.first_name,
         push_name = excluded.push_name,
         business_name = excluded.business_name,
         has_no_ai = excluded.has_no_ai,
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.chatJid,
      names.fullName,
      names.firstName,
      names.pushName,
      names.businessName,
      hasNoAi ? 1 : 0,
      input.at,
    )
    .run();

  // The contact name is the source of truth for the no_ai convention, so the
  // per-chat switch follows it: rename to `no_ai` turns the bot off, removing it
  // turns the bot back on — unless an admin suppressed the chat outright.
  const suppressed = await db
    .prepare("SELECT chat_jid FROM suppressed_chats WHERE chat_jid = ?")
    .bind(input.chatJid)
    .first<{ chat_jid: string }>();
  const botEnabled = !hasNoAi && !suppressed;

  await db
    .prepare(
      `INSERT INTO chat_state (chat_jid, bot_enabled, lock_until, last_inbound_at, last_outbound_at, updated_at)
       VALUES (?, ?, 0, NULL, NULL, ?)
       ON CONFLICT (chat_jid) DO UPDATE SET bot_enabled = excluded.bot_enabled, updated_at = excluded.updated_at`,
    )
    .bind(input.chatJid, botEnabled ? 1 : 0, input.at)
    .run();

  const previousNoAi = previous ? previous.has_no_ai === 1 : null;
  return { hasNoAi, botEnabled, changed: previousNoAi !== hasNoAi };
}
