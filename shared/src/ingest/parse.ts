/**
 * Normalises the two webhook shapes wuzapi produces into one structure.
 *
 * Per-user webhook, JSON mode (WEBHOOK_FORMAT=json):
 *   { "type": "Message", "event": { ... }, "userID": "1", "instanceName": "nomor-1" }
 *
 * Per-user webhook, form mode (the default):
 *   jsonData=<the same JSON>&userID=1&instanceName=nomor-1
 *
 * Global webhook (WUZAPI_GLOBAL_WEBHOOK) wraps the event differently: jsonData
 * stays a JSON *string* in both modes. It is supported here so a team that
 * already points the global webhook at the worker is not surprised, but the
 * per-number dashboard webhook is the recommended wiring.
 */

export interface ParsedWebhook {
  eventType: string | null;
  userID: string | null;
  instanceName: string | null;
  /** The resolved event object (the parsed `jsonData` when one was nested). */
  payload: unknown;
  /** Outer wrapper as received, kept for debugging. */
  wrapper: "event" | "jsonData" | "unknown";
}

export class WebhookParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookParseError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function fromRecord(outer: Record<string, unknown>): ParsedWebhook {
  let payload: unknown = outer;
  let wrapper: ParsedWebhook["wrapper"] = "event";

  // Global webhook shape: the event travels as a JSON string.
  const jsonData = outer["jsonData"];
  if (typeof jsonData === "string" && jsonData.trim() !== "") {
    try {
      payload = JSON.parse(jsonData) as unknown;
      wrapper = "jsonData";
    } catch {
      throw new WebhookParseError("jsonData is not valid JSON");
    }
  }

  const inner = asRecord(payload);
  return {
    eventType: asString(outer["type"]) ?? asString(inner?.["type"]),
    userID: asString(outer["userID"]) ?? asString(inner?.["userID"]),
    instanceName: asString(outer["instanceName"]) ?? asString(inner?.["instanceName"]),
    payload,
    wrapper,
  };
}

export function parseJsonWebhook(text: string): ParsedWebhook {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new WebhookParseError("request body is not valid JSON");
  }
  const record = asRecord(parsed);
  if (!record) {
    return { eventType: null, userID: null, instanceName: null, payload: parsed, wrapper: "unknown" };
  }
  return fromRecord(record);
}

export function parseFormWebhook(form: URLSearchParams): ParsedWebhook {
  const record: Record<string, unknown> = {};
  for (const [key, value] of form) {
    // Repeated keys keep their first value; wuzapi never sends duplicates.
    if (!(key in record)) record[key] = value;
  }
  if (Object.keys(record).length === 0) {
    throw new WebhookParseError("form body is empty");
  }
  return fromRecord(record);
}

export function parseWebhookBody(body: Uint8Array, contentType: string): ParsedWebhook {
  const text = new TextDecoder().decode(body);
  if (contentType === "application/json" || contentType.endsWith("+json")) {
    return parseJsonWebhook(text);
  }
  if (contentType === "application/x-www-form-urlencoded") {
    return parseFormWebhook(new URLSearchParams(text));
  }
  throw new WebhookParseError(`unsupported content type ${JSON.stringify(contentType)}`);
}
