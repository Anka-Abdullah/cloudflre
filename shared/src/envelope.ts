/**
 * The canonical message shape carried by the per-number Cloudflare Queue.
 *
 * Keeping one documented envelope means the bot (or any future consumer) never
 * has to know how the event reached Cloudflare: inline events carry the parsed
 * payload, oversized media is replaced by an R2 pointer plus the scalar metadata
 * that survived the streaming scan.
 */

export const ENVELOPE_VERSION = 1;

/**
 * What a queue message carries.
 *
 *   wuzapi.event  one wuzapi webhook (`event`) or its oversized form
 *                 (`media-pointer`). `wuzapi.event` is accepted as an alias so an
 *                 external producer can name the source explicitly.
 *   payment.event a payment-gateway or Telegram-admin callback (phase 5)
 *   outbox.tick   "flush the outbox now" (phase 5)
 *
 * `event` and `media-pointer` are what `POST /ingest` emits and what the tests
 * and every existing deployment already carry, so they stay the canonical names
 * for wuzapi-sourced traffic rather than being renamed.
 */
export type EnvelopeKind = "event" | "media-pointer" | "wuzapi.event" | "payment.event" | "outbox.tick";

export function isWuzapiEventKind(kind: string): boolean {
  return kind === "event" || kind === "media-pointer" || kind === "wuzapi.event";
}

export type HmacVerification =
  | { verified: true; algorithm: "hmac-sha256" }
  | { verified: false; reason: "disabled" | "absent" };

export interface MediaPointer {
  /** Object key inside the per-number R2 bucket. */
  r2Key: string;
  /** Raw body size in bytes. */
  size: number;
  /** sha256 of the raw body, hex. */
  sha256: string;
  /** Byte length per field the scanner skipped, for example `{ base64: 21431234 }`. */
  skippedFields: Record<string, number>;
  /** Top-level fields that were kept, `base64` excluded. Null when unparsable. */
  fields: Record<string, unknown> | null;
  /**
   * True when `fields` had to be dropped because the kept fields alone did not
   * fit in a 128 KB queue message. The scalar metadata above is still populated.
   */
  fieldsOmitted: boolean;
  /** Public URL when R2_PUBLIC_BASE_URL is configured, otherwise null. */
  mediaUrl: string | null;
}

export interface EnvelopeV1 {
  v: typeof ENVELOPE_VERSION;
  kind: EnvelopeKind;
  receivedAt: string;
  /**
   * sha256 of the raw webhook body. Stable across wuzapi retries, so a consumer
   * can deduplicate on it.
   */
  deliveryId: string;
  contentType: string;
  hmac: HmacVerification;
  event: {
    type: string | null;
    userID: string | null;
    instanceName: string | null;
    /** Parsed event for `kind: "event"`, null for oversized payloads. */
    payload: unknown | null;
  };
  media?: MediaPointer;
  source: {
    worker: string;
    slug: string;
    ua: string | null;
    ip: string | null;
    rawSize: number | null;
  };
}

export interface DlqRecord {
  v: typeof ENVELOPE_VERSION;
  failedAt: string;
  stage: "ingest" | "relay" | "dlq-consumer";
  reason: string;
  queue: string;
  messageId: string;
  attempts: number;
  envelope: unknown;
}

export function isEnvelopeV1(value: unknown): value is EnvelopeV1 {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<EnvelopeV1>;
  return candidate.v === ENVELOPE_VERSION && typeof candidate.deliveryId === "string";
}
