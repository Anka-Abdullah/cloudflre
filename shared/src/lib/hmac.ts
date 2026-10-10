/**
 * HMAC-SHA256 helpers.
 *
 * wuzapi signs every webhook with `x-hmac-signature = hex(HMAC-SHA256(key, payload))`
 * (see wuzapi/helpers.go generateHmacSignature and wuzapi/media_delivery.go
 * mediaSignature). In every delivery mode the signed payload is the request body
 * exactly as sent:
 *
 *   - JSON mode: `json.Marshal` of the event map, which resty writes verbatim.
 *   - Form mode: resty writes `r.FormData.Encode()` (resty v2 middleware.go:493)
 *     and wuzapi signs the same `url.Values.Encode()` output.
 *   - Media: the signature is computed over the streamed body file itself.
 *
 * So verification never needs a Go-compatible encoder: hash the raw bytes.
 * Because media bodies can be tens of megabytes, a streaming variant is provided
 * as well, built on `crypto.DigestStream` (SHA-256) with manual ipad/opad.
 */

const BLOCK_SIZE = 64;

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  if (clean.length % 2 !== 0 || /[^0-9a-f]/.test(clean)) {
    throw new Error("hexToBytes: input is not valid hex");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

/** Normalises a key the way Go's crypto/hmac does (hash it if longer than a block). */
async function normaliseKey(key: Uint8Array): Promise<Uint8Array> {
  return key.length > BLOCK_SIZE ? await sha256(key) : key;
}

function padKey(key: Uint8Array, pad: number): Uint8Array {
  const block = new Uint8Array(BLOCK_SIZE);
  for (let i = 0; i < BLOCK_SIZE; i++) block[i] = (key[i] ?? 0) ^ pad;
  return block;
}

/** HMAC-SHA256 over an in-memory payload, returned as lowercase hex. */
export async function hmacSha256Hex(key: Uint8Array, data: Uint8Array): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, data);
  return bytesToHex(new Uint8Array(signature));
}

/**
 * Incremental HMAC-SHA256 over chunks, for callers that already consume the
 * request body once (the ingest worker writes every chunk to R2, to a SHA-256
 * digest and to the JSON scanner in a single pass, so it cannot hand a stream to
 * `hmacSha256HexStream`).
 */
export interface StreamingHmac {
  write(chunk: Uint8Array): Promise<void>;
  finish(): Promise<string>;
}

export async function createStreamingHmac(key: Uint8Array): Promise<StreamingHmac> {
  const normalised = await normaliseKey(key);
  const inner = new crypto.DigestStream("SHA-256");
  const innerWriter = inner.getWriter();
  await innerWriter.write(padKey(normalised, 0x36));
  let finished: Promise<string> | null = null;

  return {
    async write(chunk: Uint8Array): Promise<void> {
      if (chunk.byteLength > 0) await innerWriter.write(chunk);
    },
    async finish(): Promise<string> {
      finished ??= (async () => {
        await innerWriter.close();
        const innerDigest = new Uint8Array(await inner.digest);
        const outer = new crypto.DigestStream("SHA-256");
        const outerWriter = outer.getWriter();
        await outerWriter.write(padKey(normalised, 0x5c));
        await outerWriter.write(innerDigest);
        await outerWriter.close();
        return bytesToHex(new Uint8Array(await outer.digest));
      })();
      return finished;
    },
  };
}

/**
 * HMAC-SHA256 over a stream, returned as lowercase hex.
 *
 * WebCrypto cannot sign incrementally, so the MAC is assembled from two
 * SHA-256 digest streams: H((K ^ opad) || H((K ^ ipad) || message)).
 * Nothing beyond one chunk per stream is buffered, so the caller can verify
 * arbitrarily large media webhooks without holding them in memory.
 */
export async function hmacSha256HexStream(
  key: Uint8Array,
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const hmac = await createStreamingHmac(key);
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) await hmac.write(value);
    }
  } finally {
    reader.releaseLock();
  }
  return await hmac.finish();
}

/**
 * Constant-time string comparison. Both sides are hashed first so the compared
 * buffers always have the same length, which keeps the comparison independent
 * of both content and length.
 */
export async function timingSafeEqualString(a: string, b: string): Promise<boolean> {
  const [digestA, digestB] = await Promise.all([
    sha256(new TextEncoder().encode(a)),
    sha256(new TextEncoder().encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(digestA, digestB);
}

/**
 * Checks a hex signature against any of the configured keys (keyring, so a key
 * can be rotated by configuring both the old and the new key in wuzapi and the
 * worker for the length of the rotation).
 */
export async function matchesAnyKey(
  keys: readonly string[],
  signatureHex: string | null,
  data: Uint8Array,
): Promise<boolean> {
  if (!signatureHex) return false;
  for (const key of keys) {
    if (!key) continue;
    const expected = await hmacSha256Hex(new TextEncoder().encode(key), data);
    if (await timingSafeEqualString(expected, signatureHex)) return true;
  }
  return false;
}
