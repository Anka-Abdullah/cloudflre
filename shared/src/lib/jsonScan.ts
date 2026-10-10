/**
 * Streaming extractor for a single top-level JSON object.
 *
 * Media events can be tens of megabytes (wuzapi inlines base64 in the `base64`
 * top-level field, or escapes the whole event into a form field), and the queue
 * message limit is 128 KB. To build a small pointer envelope without buffering
 * the payload, the ingest worker streams the body into this scanner: fields named
 * in `skip` are measured and discarded, the rest are captured up to
 * `maxFieldBytes` and parsed.
 *
 * The scanner works on raw bytes rather than decoded text so the reported sizes
 * are exact byte counts. That is safe because every JSON structural character is
 * ASCII and UTF-8 continuation bytes are always >= 0x80, so multi-byte sequences
 * can never be mistaken for a quote or backslash.
 */

export class ScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScanError";
  }
}

export interface ScanResult {
  /** Parsed top-level fields, excluding skipped and truncated ones. */
  fields: Record<string, unknown>;
  /** Raw byte length per skipped field (for example `{ base64: 21431234 }`). */
  skipped: Record<string, number>;
  /** Fields dropped because they exceeded `maxFieldBytes`. */
  truncated: string[];
}

export interface ScanOptions {
  /** Field names whose values are measured but never buffered. */
  skip?: readonly string[];
  /** Maximum buffered size of a single kept field, in bytes. */
  maxFieldBytes?: number;
  /** Keys whose raw encoding is longer than this are never stored. */
  maxKeyBytes?: number;
}

const enum State {
  Start,
  ExpectKey,
  InKey,
  ExpectColon,
  InValue,
  AfterValue,
  Done,
}

const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const COMMA = 0x2c;
const COLON = 0x3a;

export async function scanTopLevelJson(
  stream: ReadableStream<Uint8Array>,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const skip = new Set(options.skip ?? ["base64"]);
  const maxFieldBytes = options.maxFieldBytes ?? 262_144;
  const maxKeyBytes = options.maxKeyBytes ?? 1024;

  const fields: Record<string, unknown> = {};
  const skipped: Record<string, number> = {};
  const truncated: string[] = [];

  let state: State = State.Start;
  let valueStarted = false;

  let keyText = "";
  let keyOverflow = false;
  const keyBytes: number[] = [];

  let keyIsSkipped = false;
  let valueTooLong = false;
  let valueLength = 0;
  let valueBytes: number[] = [];

  let valueKind: "string" | "container" | "scalar" = "scalar";
  let depth = 0;
  let inString = false;
  let escaped = false;

  const decoder = new TextDecoder();
  const decodeBytes = (bytes: readonly number[]): string => decoder.decode(new Uint8Array(bytes));

  function beginValue(byte: number): "string" | "container" | "scalar" {
    keyIsSkipped = skip.has(keyText) && !keyOverflow;
    valueTooLong = false;
    valueLength = 0;
    valueBytes = [];
    inString = false;
    escaped = false;
    depth = 0;
    valueStarted = true;

    let kind: "string" | "container" | "scalar";
    if (byte === QUOTE) {
      kind = "string";
      inString = true;
    } else if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
      kind = "container";
      depth = 1;
    } else {
      kind = "scalar";
    }
    capture(byte);
    return kind;
  }

  function capture(byte: number): void {
    valueLength += 1;
    if (keyIsSkipped || keyOverflow) return;
    if (valueLength <= maxFieldBytes) {
      valueBytes.push(byte);
    } else if (!valueTooLong) {
      valueTooLong = true;
      valueBytes = [];
    }
  }

  function completeValue(): State {
    if (keyIsSkipped) {
      skipped[keyText] = (skipped[keyText] ?? 0) + valueLength;
    } else if (keyOverflow || valueTooLong) {
      truncated.push(keyText);
    } else {
      const raw = decodeBytes(valueBytes);
      try {
        fields[keyText] = JSON.parse(raw) as unknown;
      } catch {
        throw new ScanError(`field ${JSON.stringify(keyText)} is not valid JSON`);
      }
    }
    valueStarted = false;
    return State.AfterValue;
  }

  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value && value.byteLength > 0) {
        for (let i = 0; i < value.byteLength; i++) {
          const byte = value[i] as number;
          let consumed = false;
          while (!consumed) {
            switch (state) {
              case State.Start: {
                if (WS.has(byte)) break;
                if (byte !== OPEN_BRACE) {
                  throw new ScanError("expected a JSON object at the top level");
                }
                state = State.ExpectKey;
                break;
              }
              case State.ExpectKey: {
                if (WS.has(byte)) break;
                if (byte === CLOSE_BRACE) {
                  state = State.Done;
                  break;
                }
                if (byte !== QUOTE) {
                  throw new ScanError("expected a field name or the end of the object");
                }
                keyBytes.length = 0;
                keyText = "";
                keyOverflow = false;
                escaped = false;
                state = State.InKey;
                break;
              }
              case State.InKey: {
                if (escaped) {
                  escaped = false;
                } else if (byte === BACKSLASH) {
                  escaped = true;
                } else if (byte === QUOTE) {
                  if (keyOverflow) {
                    keyText = "";
                  } else if (keyBytes.includes(BACKSLASH)) {
                    // Re-parse so escaped keys ("a\u0041") match their real name.
                    try {
                      keyText = JSON.parse(`"${decodeBytes(keyBytes)}"`) as string;
                    } catch {
                      keyOverflow = true;
                      keyText = "";
                    }
                  } else {
                    keyText = decodeBytes(keyBytes);
                  }
                  state = State.ExpectColon;
                  break;
                }
                if (keyBytes.length < maxKeyBytes) {
                  keyBytes.push(byte);
                } else if (!keyOverflow) {
                  keyOverflow = true;
                  keyBytes.length = 0;
                }
                break;
              }
              case State.ExpectColon: {
                if (WS.has(byte)) break;
                if (byte !== COLON) throw new ScanError("expected ':' after a field name");
                state = State.InValue;
                valueStarted = false;
                break;
              }
              case State.InValue: {
                if (!valueStarted) {
                  if (WS.has(byte)) break;
                  valueKind = beginValue(byte);
                  state = State.InValue;
                  break;
                }
                if (inString) {
                  capture(byte);
                  if (escaped) {
                    escaped = false;
                  } else if (byte === BACKSLASH) {
                    escaped = true;
                  } else if (byte === QUOTE) {
                    inString = false;
                    if (valueKind === "string") state = completeValue();
                  }
                  break;
                }
                if (valueKind === "container") {
                  if (byte === QUOTE) {
                    inString = true;
                    capture(byte);
                    break;
                  }
                  capture(byte);
                  if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
                    depth += 1;
                  } else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
                    depth -= 1;
                    if (depth === 0) state = completeValue();
                  }
                  break;
                }
                // Scalar: ends before the delimiter, which is handled by AfterValue.
                if (WS.has(byte) || byte === COMMA || byte === CLOSE_BRACE) {
                  state = completeValue();
                  continue;
                }
                capture(byte);
                break;
              }
              case State.AfterValue: {
                if (WS.has(byte)) break;
                if (byte === COMMA) {
                  state = State.ExpectKey;
                  break;
                }
                if (byte === CLOSE_BRACE) {
                  state = State.Done;
                  break;
                }
                throw new ScanError("expected ',' or '}' after a field value");
              }
              case State.Done: {
                if (WS.has(byte)) break;
                throw new ScanError("unexpected data after the JSON object");
              }
            }
            consumed = true;
          }
        }
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }

  if (state !== State.Done) {
    throw new ScanError(`unexpected end of JSON input (state ${state})`);
  }

  return { fields, skipped, truncated };
}
