/**
 * Contact sync: `GET /user/contacts` → `contacts` + the `no_ai` switch.
 *
 * wuzapi emits no event when a contact is renamed, so the only way to notice
 * `Budi no_ai` before the customer's next message is to poll the contact list.
 * This module is the poller; the rule it feeds is `contacts/policy.ts`.
 *
 * Two design decisions worth knowing:
 *
 *  - **Editing a name is a transition, not a level.** `bot_enabled` is only
 *    written when the `no_ai` marker appears or disappears. A sync that wrote
 *    the level on every pass would silently undo an admin's manual "bot off"
 *    switch every CONTACT_SYNC_INTERVAL_MINUTES; a transition-based sync leaves
 *    that decision alone while still honouring the naming convention.
 *  - **A missing wuzapi is not an error the caller has to handle.** The sync
 *    returns a structured result with `error` set, so a cron pass can log one
 *    line instead of aborting the rest of its jobs (work order section 6: the
 *    cron must still flush the outbox when wuzapi is down).
 */
import type { Logger } from "../../lib/logger";
import { upsertContact } from "./policy";
import type { WuzapiClient } from "../wuzapi/client";

export interface ContactSyncOptions {
  /** Epoch ms written to `updated_at`. */
  at?: number;
  log?: Logger;
  /** Test seam: replaces the client call. */
  fetchContacts?: () => Promise<{ ok: boolean; contacts: Record<string, unknown>; error: string }>;
}

export interface ContactSyncResult {
  /** Entries returned by wuzapi, before filtering. */
  fetched: number;
  /** Chat rows written (or refreshed) in D1. */
  upserted: number;
  /** Chats where the bot was switched off by this pass. */
  disabled: number;
  /** Chats where the bot was switched back on by this pass. */
  enabled: number;
  /** Chats skipped because they are not 1:1 conversations. */
  skipped: number;
  /** Empty when the sync succeeded. */
  error: string;
}

/**
 * Groups, newsletters and status broadcasts are never answered by the bot, so
 * storing their names would only waste rows (and could turn a group named
 * `no_ai` into a confusing "disabled chat").
 */
export function isDirectChatJid(jid: string): boolean {
  if (jid === "" || jid.includes("@g.us") || jid.includes("@newsletter") || jid.includes("status@broadcast")) {
    return false;
  }
  return jid.includes("@");
}

export async function syncContacts(
  db: D1Database,
  client: Pick<WuzapiClient, "getContacts"> | null,
  options: ContactSyncOptions = {},
): Promise<ContactSyncResult> {
  const at = options.at ?? Date.now();
  const result: ContactSyncResult = { fetched: 0, upserted: 0, disabled: 0, enabled: 0, skipped: 0, error: "" };

  const response = options.fetchContacts
    ? await options.fetchContacts()
    : client
      ? await client.getContacts()
      : { ok: false, contacts: {}, error: "wuzapi client is not configured" };

  if (!response.ok) {
    result.error = response.error === "" ? "contact sync failed" : response.error;
    return result;
  }

  const entries = Object.entries(response.contacts);
  result.fetched = entries.length;

  for (const [jid, contact] of entries) {
    if (!isDirectChatJid(jid)) {
      result.skipped += 1;
      continue;
    }
    if (typeof contact !== "object" || contact === null || Array.isArray(contact)) {
      result.skipped += 1;
      continue;
    }

    const outcome = await upsertContact(db, { chatJid: jid, contact: contact as Record<string, unknown>, at });
    result.upserted += 1;
    // A chat seen for the first time counts as "disabled" only when it already
    // carries the marker (that is a real switch-off from the default-on state);
    // a brand-new contact without the marker changed nothing, so it is not
    // reported as "enabled".
    if (outcome.changed && (outcome.hasNoAi || !outcome.firstSeen)) {
      if (outcome.hasNoAi) result.disabled += 1;
      else result.enabled += 1;
      options.log?.info("contact_sync_changed", {
        chatJid: jid,
        hasNoAi: outcome.hasNoAi,
        botEnabled: outcome.botEnabled,
      });
    }
  }

  options.log?.info("contact_sync", {
    fetched: result.fetched,
    upserted: result.upserted,
    disabled: result.disabled,
    enabled: result.enabled,
    skipped: result.skipped,
  });
  return result;
}
