/**
 * `POST /ingest/<INGEST_TOKEN>` — turns one wuzapi webhook into one queue message.
 *
 * Design constraints that shape this file:
 *
 *  - Cloudflare queue messages are limited to 128 KB while wuzapi media events
 *    are not (base64 is inlined). Small bodies travel inline, larger ones are
 *    streamed to R2 and replaced by a pointer.
 *  - The worker request body limit is 100 MB and Worker memory is 128 MB, so the
 *    large path must never buffer: one tee feeds R2 while a single pass computes
 *    the streaming HMAC, the SHA-256 delivery id and the streaming JSON scan.
 *  - Content-Length is not relied upon (it is absent for streamed requests), so
 *    the handler reads a bounded prefix and decides from the bytes it saw.
 *  - wuzapi retries a webhook up to WEBHOOK_RETRY_COUNT times when it does not
 *    see 2xx. Returning 503 when the queue write fails therefore turns wuzapi
 *    into a free retry layer; returning 202 after a successful send stops it.
 */
import { type Env, type InstanceConfig } from "../config";
import { ENVELOPE_VERSION, type DlqRecord, type EnvelopeV1 } from "../envelope";
import { createLogger } from "../lib/logger";
import {
  bytesToHex,
  createStreamingHmac,
  matchesAnyKey,
  timingSafeEqualString,
  type StreamingHmac,
} from "../lib/hmac";
import { ScanError, scanTopLevelJson, type ScanResult } from "../lib/jsonScan";
import { parseWebhookBody, WebhookParseError, type ParsedWebhook } from "./parse";

/** Budget for scanned fields inside one 128 KB queue message. */
const POINTER_FIELDS_BUDGET_BYTES = 60_000;
/** Bytes of a large body kept in memory to recover routing metadata. */
const PREFIX_BYTES = 8_192;

export interface IngestDeps {
  now?: () => Date;
  log?: ReturnType<typeof createLogger>;
  randomUUID?: () => string;
  /** Test seam: replaces `env.EVENTS.send`. */
  send?: (envelope: EnvelopeV1) => Promise<unknown>;
  /** Test seam: replaces `env.MEDIA.put`. */
  put?: (key: string, value: ReadableStream<Uint8Array> | ArrayBuffer, options?: R2PutOptions) => Promise<unknown>;
  /** Test seam: replaces `env.MEDIA.delete`. */
  remove?: (key: string) => Promise<unknown>;
  /** Test seam: replaces `env.DLQ.send`. */
  sendDlq?: (record: DlqRecord) => Promise<unknown>;
}

export interface IngestOptions {
  env: Env;
  config: InstanceConfig;
  deps?: IngestDeps;
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function str(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export function ingestTokenFromPath(pathname: string): string | null {
  const match = /^\/ingest\/([^/]+)\/?$/.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function isJsonContentType(contentType: string): boolean {
  return contentType === "application/json" || contentType.endsWith("+json");
}

/**
 * A stable, non-reversible label for a request path.
 *
 * Used instead of the raw pathname because `POST /ingest/<token>` carries the
 * shared secret *in the path*: logging it would copy the credential into every
 * log sink, alert payload and DLQ archive. Twelve hex characters are enough to
 * tell two senders apart and far too few to recover the token from.
 */
async function pathFingerprint(pathname: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pathname));
  return bytesToHex(new Uint8Array(digest)).slice(0, 12);
}

function r2KeyFor(slug: string, contentType: string, at: Date, id: string): string {
  const yyyy = String(at.getUTCFullYear());
  const mm = String(at.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(at.getUTCDate()).padStart(2, "0");
  const extension = isJsonContentType(contentType) ? "json" : "form";
  return `events/${slug}/${yyyy}/${mm}/${dd}/${id}.${extension}`;
}

/** Wraps already-buffered bytes in a stream so every code path has one input shape. */
function singleChunkStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

function concat(chunks: readonly Uint8Array[], totalLength: number): Uint8Array {
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

interface PrefixRead {
  exceeded: boolean;
  prefix: Uint8Array;
  remainder: ReadableStream<Uint8Array> | null;
}

/**
 * Reads at most `limit` bytes. When the body is larger, the rest is exposed as a
 * stream so the caller can choose between rejecting it and streaming it to R2
 * without ever buffering the whole payload.
 */
async function readPrefix(stream: ReadableStream<Uint8Array>, limit: number): Promise<PrefixRead> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      reader.releaseLock();
      return { exceeded: false, prefix: concat(chunks, total), remainder: null };
    }
    if (!value || value.byteLength === 0) continue;

    if (total + value.byteLength > limit) {
      const keep = Math.max(0, limit - total);
      if (keep > 0) {
        chunks.push(value.subarray(0, keep).slice());
        total += keep;
      }
      const tail = value.subarray(keep).slice();
      const remainder = new ReadableStream<Uint8Array>({
        start(controller) {
          if (tail.byteLength > 0) controller.enqueue(tail);
        },
        async pull(controller) {
          const next = await reader.read();
          if (next.done) {
            reader.releaseLock();
            controller.close();
            return;
          }
          if (next.value && next.value.byteLength > 0) controller.enqueue(next.value);
        },
        cancel(reason) {
          void reader.cancel(reason);
        },
      });
      return { exceeded: true, prefix: concat(chunks, total), remainder };
    }

    chunks.push(value.slice());
    total += value.byteLength;
  }
}

function hmacField(config: InstanceConfig, verified: boolean): EnvelopeV1["hmac"] {
  return verified
    ? { verified: true, algorithm: "hmac-sha256" }
    : { verified: false, reason: config.hmacMode === "off" ? "disabled" : "absent" };
}

function sourceOf(config: InstanceConfig, request: Request, rawSize: number | null): EnvelopeV1["source"] {
  return {
    worker: config.slug,
    slug: config.slug,
    ua: request.headers.get("user-agent"),
    ip: request.headers.get("cf-connecting-ip"),
    rawSize,
  };
}

/** Keeps scanned fields only when they still fit comfortably in a queue message. */
function fieldsWithinBudget(scan: ScanResult | null): { fields: Record<string, unknown> | null; omitted: boolean } {
  if (!scan) return { fields: null, omitted: false };
  let serialised: string;
  try {
    serialised = JSON.stringify(scan.fields);
  } catch {
    return { fields: null, omitted: true };
  }
  if (serialised.length > POINTER_FIELDS_BUDGET_BYTES) return { fields: null, omitted: true };
  return { fields: scan.fields, omitted: false };
}

/**
 * Recovers `instanceName`/`userID` from the leading bytes of a large
 * form-encoded body. wuzapi writes the media form as
 * `instanceName=...&jsonData=<escaped event>&userID=...`, so the leading keys are
 * available even though the jsonData value cannot be parsed without buffering it.
 */
function metadataFromFormPrefix(prefix: Uint8Array): { userID: string | null; instanceName: string | null } {
  const text = new TextDecoder().decode(prefix);
  const pairs = text.split("&");
  // The last pair may be cut mid-value, so it is ignored.
  const complete = pairs.slice(0, -1);
  let userID: string | null = null;
  let instanceName: string | null = null;
  for (const pair of complete) {
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const key = pair.slice(0, index);
    if (key !== "userID" && key !== "instanceName") continue;
    let value: string;
    try {
      value = decodeURIComponent(pair.slice(index + 1).replace(/\+/g, " "));
    } catch {
      continue;
    }
    if (value === "") continue;
    if (key === "userID") userID = value;
    else instanceName = value;
  }
  return { userID, instanceName };
}

interface PointerContext {
  config: InstanceConfig;
  request: Request;
  receivedAt: Date;
  contentType: string;
  key: string;
  size: number;
  sha256: string;
  scan: ScanResult | null;
  formMeta?: { userID: string | null; instanceName: string | null } | undefined;
  /**
   * Routing metadata that was already parsed. The inline path sets this when it
   * has to offload an event whose *envelope* did not fit: the payload is then
   * only in R2, but type/userID/instanceName are known exactly and must not be
   * re-derived from a scan.
   */
  parsed?: { type: string | null; userID: string | null; instanceName: string | null } | undefined;
  hmacVerified: boolean;
}

function pointerEnvelope(context: PointerContext): EnvelopeV1 {
  const { config, request, receivedAt, contentType, key, size, sha256, scan, formMeta, parsed, hmacVerified } = context;
  const { fields, omitted } = fieldsWithinBudget(scan);
  return {
    v: ENVELOPE_VERSION,
    kind: "media-pointer",
    receivedAt: receivedAt.toISOString(),
    deliveryId: sha256,
    contentType,
    hmac: hmacField(config, hmacVerified),
    event: {
      type: parsed?.type ?? str(fields?.["type"]),
      userID: parsed?.userID ?? str(fields?.["userID"]) ?? formMeta?.userID ?? null,
      instanceName: parsed?.instanceName ?? str(fields?.["instanceName"]) ?? formMeta?.instanceName ?? null,
      payload: null,
    },
    media: {
      r2Key: key,
      size,
      sha256,
      skippedFields: scan?.skipped ?? {},
      fields,
      fieldsOmitted: omitted,
      mediaUrl: config.r2PublicBaseUrl === "" ? null : `${config.r2PublicBaseUrl}/${key}`,
    },
    source: sourceOf(config, request, size),
  };
}

export async function handleIngest(request: Request, options: IngestOptions): Promise<Response> {
  const { env, config } = options;
  const deps = options.deps ?? {};
  const log = deps.log ?? createLogger({ slug: config.slug, handler: "ingest" });
  const now = deps.now ?? (() => new Date());
  const randomUUID = deps.randomUUID ?? (() => crypto.randomUUID());
  const sendEnvelope = deps.send ?? ((envelope: EnvelopeV1) => env.EVENTS.send(envelope, { contentType: "json" }));
  const putObject =
    deps.put ??
    ((key: string, value: ReadableStream<Uint8Array> | ArrayBuffer, putOptions?: R2PutOptions) =>
      env.MEDIA.put(key, value, putOptions));
  const deleteObject = deps.remove ?? ((key: string) => env.MEDIA.delete(key));
  const sendDlq = deps.sendDlq ?? ((record: DlqRecord) => env.DLQ.send(record, { contentType: "json" }));

  const url = new URL(request.url);
  const receivedAt = now();

  /**
   * Enqueues an envelope, offloading the raw body to R2 first when the envelope
   * would not fit in a queue message (WP-4C).
   *
   * The inline path used to trust that a parsed event fits, but fitting is not a
   * property of the payload — a text message just under INLINE_MAX_BYTES still
   * serialises into more than ENVELOPE_MAX_BYTES once the envelope wrapper, the
   * HMAC block and the source block are added, and Cloudflare rejects a queue
   * message over 128 KB outright. Offloading keeps the event and hands the
   * consumer the same pointer shape the oversized path already produces.
   *
   * The queue write is also where an R2 object can become an orphan: if `send`
   * fails after a successful `put`, nothing will ever read the object, so it is
   * deleted rather than left behind (WP-4D).
   */
  const enqueueOrOffload = async (
    envelope: EnvelopeV1,
    source: {
      bytes: Uint8Array;
      sha256: string;
      scan: ScanResult | null;
      formMeta?: { userID: string | null; instanceName: string | null } | undefined;
      parsed?: { type: string | null; userID: string | null; instanceName: string | null } | undefined;
    },
  ): Promise<{ ok: true; envelope: EnvelopeV1; r2Key: string | null } | { ok: false; error: unknown }> => {
    let outgoing = envelope;
    let r2Key: string | null = null;

    const serialised = JSON.stringify(envelope);
    if (serialised.length > config.envelopeMaxBytes) {
      const key = r2KeyFor(config.slug, contentType, receivedAt, randomUUID());
      try {
        await putObject(key, source.bytes.buffer as ArrayBuffer, {
          httpMetadata: { contentType },
          customMetadata: {
            slug: config.slug,
            receivedAt: receivedAt.toISOString(),
            contentType,
            offloaded: "envelope-too-large",
          },
        });
      } catch (error) {
        log.error("ingest_storage_failed", { error: String(error), key, size: source.bytes.byteLength });
        return { ok: false, error };
      }

      r2Key = key;
      outgoing = pointerEnvelope({
        config,
        request,
        receivedAt,
        contentType,
        key,
        size: source.bytes.byteLength,
        sha256: source.sha256,
        scan: source.scan,
        ...(source.formMeta ? { formMeta: source.formMeta } : {}),
        ...(source.parsed ? { parsed: source.parsed } : {}),
        hmacVerified,
      });
      log.warn("ingest_envelope_offloaded", {
        deliveryId: envelope.deliveryId,
        envelopeBytes: serialised.length,
        limit: config.envelopeMaxBytes,
        size: source.bytes.byteLength,
        r2Key: key,
      });
    }

    try {
      await sendEnvelope(outgoing);
    } catch (error) {
      if (r2Key !== null) {
        try {
          await deleteObject(r2Key);
        } catch {
          // Best effort: an orphaned object is harmless, a lost event is not.
        }
      }
      return { ok: false, error };
    }
    return { ok: true, envelope: outgoing, r2Key };
  };

  // 1. Shared secret in the URL path. This is the credential pasted into the
  //    wuzapi dashboard, because wuzapi cannot send custom headers.
  const token = ingestTokenFromPath(url.pathname);
  if (config.ingestToken === "") {
    log.error("ingest_misconfigured", { reason: "INGEST_TOKEN secret is not set" });
    return json(500, { error: "INGEST_TOKEN is not configured" });
  }
  if (token === null || !(await timingSafeEqualString(token, config.ingestToken))) {
    // The path *is* the credential, so it must never reach a log line. A short
    // fingerprint keeps the line useful — it tells two wrong URLs apart, and lets
    // an operator confirm which deployment a sender is aiming at — without
    // copying the secret into a log sink, an alert or an R2 archive.
    log.warn("ingest_unauthorized", {
      route: "ingest",
      pathHash: await pathFingerprint(url.pathname),
      pathLength: url.pathname.length,
      ip: request.headers.get("cf-connecting-ip"),
    });
    return json(401, { error: "invalid ingest token" });
  }

  // 2. Method and content type.
  if (request.method !== "POST") {
    return json(405, { error: "method not allowed" });
  }
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!isJsonContentType(contentType) && contentType !== "application/x-www-form-urlencoded") {
    log.warn("ingest_unsupported_content_type", { contentType });
    return json(415, { error: `unsupported content type ${JSON.stringify(contentType)}` });
  }

  // 3. Signature pre-checks, before the body is read so a misconfigured sender is
  //    cheap to reject. The three modes are deliberately distinct (WP-4A):
  //
  //      strict   a webhook without a signature is refused outright
  //      optional no signature is accepted and recorded as `absent`; a signature
  //               that *is* present must still verify
  //      off      the header is not looked at at all
  const signature = request.headers.get("x-hmac-signature");
  const shouldVerify = config.hmacMode !== "off" && signature !== null;

  if (config.hmacMode === "strict" && signature === null) {
    log.warn("ingest_signature_missing", { ip: request.headers.get("cf-connecting-ip") });
    return json(403, { error: "x-hmac-signature header is required" });
  }
  if (shouldVerify && config.hmacKeys.length === 0) {
    // A signature was presented but there is no key to check it against. Passing
    // it through would stamp the envelope `verified: false` on a request nobody
    // could authenticate, which is exactly what the mode was meant to prevent.
    log.error("ingest_misconfigured", { reason: "WUZAPI_HMAC_KEYS secret is not set" });
    return json(500, { error: "WUZAPI_HMAC_KEYS is not configured" });
  }
  const hmacVerified = shouldVerify;

  // 3b. Hard ceiling on the upload, decided from the header alone (WP-4C). This
  //     runs before the body is read on purpose: a runaway upload is refused in
  //     one round trip, instead of being streamed into R2 until the runtime cuts
  //     it off — which would leave a truncated object and a wasted transfer.
  const declaredHeader = request.headers.get("content-length");
  const declared = declaredHeader === null ? Number.NaN : Number(declaredHeader);
  if (Number.isFinite(declared) && declared > config.mediaMaxBytes) {
    log.warn("ingest_payload_rejected", { reason: "MEDIA_MAX_BYTES exceeded", limit: config.mediaMaxBytes, declared });
    try {
      await request.body?.cancel("payload rejected");
    } catch {
      // Cancelling a rejected body is best effort.
    }
    try {
      await sendDlq({
        v: ENVELOPE_VERSION,
        failedAt: receivedAt.toISOString(),
        stage: "ingest",
        reason: `Content-Length ${declared} exceeds MEDIA_MAX_BYTES=${config.mediaMaxBytes}`,
        queue: "ingest",
        messageId: "-",
        attempts: 0,
        envelope: { contentType, declared },
      });
    } catch (error) {
      log.error("ingest_dlq_record_failed", { error: String(error) });
    }
    return json(413, { error: `payload exceeds MEDIA_MAX_BYTES=${config.mediaMaxBytes}` });
  }

  const body = request.body;
  if (!body) {
    return json(400, { error: "request body is required" });
  }

  const read = await readPrefix(body, config.inlineMaxBytes);

  // 4. Small payload: verify, parse, enqueue.
  if (!read.exceeded) {
    const bytes = read.prefix;

    if (shouldVerify && !(await matchesAnyKey(config.hmacKeys, signature, bytes))) {
      log.warn("ingest_signature_invalid", { size: bytes.byteLength });
      return json(403, { error: "invalid x-hmac-signature" });
    }

    const deliveryId = bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));

    let parsed: ParsedWebhook;
    try {
      parsed = parseWebhookBody(bytes, contentType);
    } catch (error) {
      const reason = error instanceof WebhookParseError ? error.message : "could not parse webhook body";
      log.warn("ingest_parse_failed", { reason, size: bytes.byteLength });
      return json(400, { error: reason });
    }

    const envelope: EnvelopeV1 = {
      v: ENVELOPE_VERSION,
      kind: "event",
      receivedAt: receivedAt.toISOString(),
      deliveryId,
      contentType,
      hmac: hmacField(config, hmacVerified),
      event: {
        type: parsed.eventType,
        userID: parsed.userID,
        instanceName: parsed.instanceName,
        payload: parsed.payload,
      },
      source: sourceOf(config, request, bytes.byteLength),
    };

    // A parsed event can still be too big for a queue message, so the send goes
    // through the same offload path the oversized bodies use.
    const queued = await enqueueOrOffload(envelope, {
      bytes,
      sha256: deliveryId,
      scan: await scanJsonSafely(bytes, contentType, config, log),
      ...(isJsonContentType(contentType) ? {} : { formMeta: metadataFromFormPrefix(bytes) }),
      parsed: { type: parsed.eventType, userID: parsed.userID, instanceName: parsed.instanceName },
    });
    if (!queued.ok) {
      log.error("ingest_enqueue_failed", { error: String(queued.error), deliveryId, kind: envelope.kind });
      return json(503, { error: "queue write failed, retry" });
    }
    log.info("ingest_queued", {
      deliveryId,
      kind: queued.envelope.kind,
      eventType: queued.envelope.event.type,
      userID: queued.envelope.event.userID,
      size: bytes.byteLength,
      r2Key: queued.r2Key,
    });
    return json(202, {
      ok: true,
      deliveryId,
      kind: queued.envelope.kind,
      ...(queued.r2Key === null ? {} : { r2Key: queued.r2Key }),
    });
  }

  // 5. Oversized payload when R2 offload is disabled.
  if (config.mediaMode === "reject") {
    log.warn("ingest_payload_rejected", { limit: config.inlineMaxBytes });
    try {
      await read.remainder?.cancel("payload rejected");
    } catch {
      // Cancelling a rejected body is best effort.
    }
    try {
      await sendDlq({
        v: ENVELOPE_VERSION,
        failedAt: receivedAt.toISOString(),
        stage: "ingest",
        reason: `payload exceeds INLINE_MAX_BYTES=${config.inlineMaxBytes} and MEDIA_MODE=reject`,
        queue: "ingest",
        messageId: "-",
        attempts: 0,
        envelope: { contentType, prefixSize: read.prefix.byteLength },
      });
    } catch (error) {
      log.error("ingest_dlq_record_failed", { error: String(error) });
    }
    return json(413, { error: "payload too large for the queue and MEDIA_MODE=reject" });
  }

  const declaredHeader = request.headers.get("content-length");
  const declared = declaredHeader === null ? Number.NaN : Number(declaredHeader);
  const hasDeclaredLength = Number.isFinite(declared) && declared > config.inlineMaxBytes;

  // 5b. A body that announces more than MEDIA_MAX_BYTES is refused up front, so
  //     a runaway upload is rejected in one round trip instead of being streamed
  //     into R2 until the runtime truncates it. Checked before the buffered path
  //     too, where a declared length is present by definition.
  if (hasDeclaredLength && declared > config.mediaMaxBytes) {
    log.warn("ingest_payload_rejected", { reason: "MEDIA_MAX_BYTES exceeded", limit: config.mediaMaxBytes, declared });
    try {
      await read.remainder?.cancel("payload rejected");
    } catch {
      // Cancelling a rejected body is best effort.
    }
    try {
      await sendDlq({
        v: ENVELOPE_VERSION,
        failedAt: receivedAt.toISOString(),
        stage: "ingest",
        reason: `Content-Length ${declared} exceeds MEDIA_MAX_BYTES=${config.mediaMaxBytes}`,
        queue: "ingest",
        messageId: "-",
        attempts: 0,
        envelope: { contentType, prefixSize: read.prefix.byteLength, declared },
      });
    } catch (error) {
      log.error("ingest_dlq_record_failed", { error: String(error) });
    }
    return json(413, { error: `payload exceeds MEDIA_MAX_BYTES=${config.mediaMaxBytes}` });
  }

  // 6. Oversized without a usable Content-Length: buffer up to the cap. R2
  //    requires a known length for streamed puts, so without one the only way to
  //    keep the body is to materialise it (bounded, and reported when exceeded).
  if (!hasDeclaredLength) {
    const remainder = await drainWithCap(read.remainder as ReadableStream<Uint8Array>, config.mediaBufferMaxBytes);
    if (!remainder.ok) {
      log.warn("ingest_payload_rejected", {
        reason: "no Content-Length and body exceeds MEDIA_BUFFER_MAX_BYTES",
        limit: config.mediaBufferMaxBytes,
        read: remainder.read,
      });
      try {
        await sendDlq({
          v: ENVELOPE_VERSION,
          failedAt: receivedAt.toISOString(),
          stage: "ingest",
          reason: `no Content-Length and body exceeds MEDIA_BUFFER_MAX_BYTES=${config.mediaBufferMaxBytes}`,
          queue: "ingest",
          messageId: "-",
          attempts: 0,
          envelope: { contentType, prefixSize: read.prefix.byteLength, read: remainder.read },
        });
      } catch (error) {
        log.error("ingest_dlq_record_failed", { error: String(error) });
      }
      return json(413, { error: "payload too large without Content-Length and MEDIA_BUFFER_MAX_BYTES exceeded" });
    }

    const bytes = concat([read.prefix, remainder.bytes], read.prefix.byteLength + remainder.bytes.byteLength);

    if (shouldVerify && !(await matchesAnyKey(config.hmacKeys, signature, bytes))) {
      log.warn("ingest_signature_invalid", { size: bytes.byteLength, path: "buffered-oversize" });
      return json(403, { error: "invalid x-hmac-signature" });
    }

    const sha256 = bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
    const scan = await scanJsonSafely(bytes, contentType, config, log);
    const key = r2KeyFor(config.slug, contentType, receivedAt, randomUUID());

    try {
      await putObject(key, bytes.buffer as ArrayBuffer, {
        httpMetadata: { contentType },
        customMetadata: { slug: config.slug, receivedAt: receivedAt.toISOString(), contentType },
      });
    } catch (error) {
      log.error("ingest_storage_failed", { error: String(error), key, size: bytes.byteLength });
      return json(500, { error: "media storage failed, retry" });
    }

    const envelope = pointerEnvelope({
      config,
      request,
      receivedAt,
      contentType,
      key,
      size: bytes.byteLength,
      sha256,
      scan,
      hmacVerified,
      formMeta: isJsonContentType(contentType) ? undefined : metadataFromFormPrefix(read.prefix),
    });

    const queued = await enqueueOrOffload(envelope, {
      bytes,
      sha256,
      scan,
      ...(isJsonContentType(contentType) ? {} : { formMeta: metadataFromFormPrefix(read.prefix) }),
    });
    if (!queued.ok) {
      log.error("ingest_enqueue_failed", { error: String(queued.error), deliveryId: sha256, kind: envelope.kind });
      // The object was already stored for an event that will now never be
      // consumed, and wuzapi will retry the whole request, so leaving it behind
      // would leak one object per failed attempt.
      try {
        await deleteObject(key);
      } catch {
        // Best effort: an orphaned object is harmless, a lost event is not.
      }
      return json(503, { error: "queue write failed, retry" });
    }
    log.info("ingest_queued", {
      deliveryId: sha256,
      kind: queued.envelope.kind,
      size: bytes.byteLength,
      r2Key: queued.r2Key ?? key,
      path: "buffered-oversize",
    });
    return json(202, { ok: true, deliveryId: sha256, kind: queued.envelope.kind, r2Key: queued.r2Key ?? key });
  }

  // 7. Oversized with a known length: one streaming pass into R2 through a
  //    FixedLengthStream, computing the HMAC, the SHA-256 delivery id and the
  //    JSON scan from the same chunks without ever buffering the payload.
  const input = chainStreams(singleChunkStream(read.prefix), read.remainder as ReadableStream<Uint8Array>);
  const key = r2KeyFor(config.slug, contentType, receivedAt, randomUUID());

  const fixed = new FixedLengthStream(declared);
  const fixedWriter = fixed.writable.getWriter();

  const hmacs: StreamingHmac[] = shouldVerify
    ? await Promise.all(config.hmacKeys.map((keyValue) => createStreamingHmac(new TextEncoder().encode(keyValue))))
    : [];

  const shaStream = new crypto.DigestStream("SHA-256");
  const shaWriter = shaStream.getWriter();

  const scannerEnabled = isJsonContentType(contentType);
  const scannerStream = scannerEnabled ? new TransformStream<Uint8Array, Uint8Array>() : null;
  const scannerPromise: Promise<ScanResult | null> = scannerStream
    ? scanTopLevelJson(scannerStream.readable, {
        skip: ["base64"],
        maxFieldBytes: config.scanMaxFieldBytes,
      }).catch((error: unknown) => {
        if (error instanceof ScanError) {
          log.warn("ingest_scan_failed", { reason: error.message });
          return null;
        }
        throw error;
      })
    : Promise.resolve(null);
  const scannerWriter = scannerStream ? scannerStream.writable.getWriter() : null;

  // The rejection handler is attached immediately: the streaming pass runs for a
  // while before the put result is awaited, and an unhandled rejection would
  // otherwise surface as a runtime error.
  const putOutcome = putObject(key, fixed.readable, {
    httpMetadata: { contentType },
    customMetadata: { slug: config.slug, receivedAt: receivedAt.toISOString(), contentType },
  }).then(
    () => ({ ok: true as const, error: null }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  // If R2 stops reading (failed put, closed bucket) a write into the
  // fixed-length stream would block until the request is killed. Racing every
  // write against the put outcome turns that deadlock into a clean 500, which
  // wuzapi then retries.
  let putFailed = false;
  let signalPutFailure: (error: unknown) => void = () => {};
  const putFailure = new Promise<never>((_resolve, reject) => {
    signalPutFailure = reject;
  });
  void putFailure.catch(() => {});
  void putOutcome.then((outcome) => {
    if (!outcome.ok) {
      putFailed = true;
      signalPutFailure(outcome.error);
    }
  });

  let size = 0;
  const prefixParts: Uint8Array[] = [];
  let prefixLength = 0;
  let streamError: unknown = null;

  const reader = input.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      size += value.byteLength;
      await Promise.race([fixedWriter.write(value), putFailure]);
      for (const hmac of hmacs) await hmac.write(value);
      await shaWriter.write(value);
      if (scannerWriter) await scannerWriter.write(value);
      if (prefixLength < PREFIX_BYTES) {
        const slice = value.subarray(0, PREFIX_BYTES - prefixLength);
        prefixParts.push(slice.slice());
        prefixLength += slice.byteLength;
      }
    }
  } catch (error) {
    streamError = error;
  } finally {
    reader.releaseLock();
  }

  if (streamError === null && size !== declared) {
    streamError = new Error(`body length mismatch: expected ${declared} bytes, received ${size}`);
  }

  if (streamError !== null) {
    // A storage failure aborts the fixed-length stream and surfaces here as a
    // write error, so the two causes must be reported differently: wuzapi
    // retries a 5xx but treats 4xx as a permanent misconfiguration.
    if (putFailed) {
      log.error("ingest_storage_failed", { error: String(streamError), key, declared, size });
      return json(500, { error: "media storage failed, retry" });
    }
    log.error("ingest_body_read_failed", { error: String(streamError), declared, size });
    try {
      await fixedWriter.abort(streamError);
    } catch {
      // The writer may already be closed by the failed upstream stream.
    }
    const stored = await putOutcome;
    if (stored.ok) {
      try {
        await deleteObject(key);
      } catch {
        // Best effort cleanup only.
      }
    }
    return json(400, { error: `could not read request body: ${String(streamError)}` });
  }

  await Promise.race([fixedWriter.close(), putFailure]);
  await shaWriter.close();
  const sha256 = bytesToHex(new Uint8Array(await shaStream.digest));
  if (scannerWriter) await scannerWriter.close();
  const scan = await scannerPromise;

  if (hmacs.length > 0) {
    const expected = await Promise.all(hmacs.map((hmac) => hmac.finish()));
    const accepted = await Promise.all(expected.map((value) => timingSafeEqualString(value, signature as string)));
    if (!accepted.some(Boolean)) {
      log.warn("ingest_signature_invalid", { size, key });
      const stored = await putOutcome;
      if (stored.ok) {
        try {
          await deleteObject(key);
        } catch {
          // Best effort: an orphaned object is harmless, a failed request is not.
        }
      }
      return json(403, { error: "invalid x-hmac-signature" });
    }
  }

  const storage = await putOutcome;
  if (!storage.ok) {
    log.error("ingest_storage_failed", { error: String(storage.error), key, size });
    return json(500, { error: "media storage failed, retry" });
  }

  const envelope = pointerEnvelope({
    config,
    request,
    receivedAt,
    contentType,
    key,
    size,
    sha256,
    scan,
    hmacVerified,
    formMeta: isJsonContentType(contentType)
      ? undefined
      : metadataFromFormPrefix(concat(prefixParts, prefixLength)),
  });

  try {
    await sendEnvelope(envelope);
  } catch (error) {
    log.error("ingest_enqueue_failed", { error: String(error), deliveryId: sha256, kind: envelope.kind });
    // The streamed object is already in R2 but no consumer will ever see it,
    // because the only reference to it was the message that failed to send.
    try {
      await deleteObject(key);
    } catch {
      // Best effort: an orphaned object is harmless, a lost event is not.
    }
    return json(503, { error: "queue write failed, retry" });
  }

  log.info("ingest_queued", {
    deliveryId: sha256,
    kind: envelope.kind,
    size,
    r2Key: key,
    skipped: envelope.media?.skippedFields,
    fieldsOmitted: envelope.media?.fieldsOmitted,
  });
  return json(202, { ok: true, deliveryId: sha256, kind: envelope.kind, r2Key: key });
}

/** Reads a stream into memory, aborting as soon as `cap` bytes are exceeded. */
async function drainWithCap(
  stream: ReadableStream<Uint8Array>,
  cap: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; read: number }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > cap) {
        // Cancelling releases the sender instead of letting it push the rest of a
        // body the worker has already decided to refuse. Without this the upload
        // keeps being buffered at the edge for the whole transfer.
        try {
          await reader.cancel("payload exceeds cap");
        } catch {
          // Cancelling is best effort; the 413 is returned either way.
        }
        return { ok: false, read: total };
      }
      chunks.push(value.slice());
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The reader is already released when the stream errored or was cancelled.
    }
  }
  return { ok: true, bytes: concat(chunks, total) };
}

/** Scans a buffered body, downgrading a malformed payload to "no metadata". */
async function scanJsonSafely(
  bytes: Uint8Array,
  contentType: string,
  config: InstanceConfig,
  log: ReturnType<typeof createLogger>,
): Promise<ScanResult | null> {
  if (!isJsonContentType(contentType)) return null;
  try {
    return await scanTopLevelJson(singleChunkStream(bytes), {
      skip: ["base64"],
      maxFieldBytes: config.scanMaxFieldBytes,
    });
  } catch (error) {
    if (error instanceof ScanError) {
      log.warn("ingest_scan_failed", { reason: error.message });
      return null;
    }
    throw error;
  }
}

/** Reads `first` to completion, then continues with `second`. */
function chainStreams(
  first: ReadableStream<Uint8Array>,
  second: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const firstReader = first.getReader();
      for (;;) {
        const { done, value } = await firstReader.read();
        if (done) break;
        if (value && value.byteLength > 0) controller.enqueue(value);
      }
      firstReader.releaseLock();

      const secondReader = second.getReader();
      for (;;) {
        const { done, value } = await secondReader.read();
        if (done) break;
        if (value && value.byteLength > 0) controller.enqueue(value);
      }
      secondReader.releaseLock();
      controller.close();
    },
    cancel(reason) {
      void second.cancel(reason);
    },
  });
}
