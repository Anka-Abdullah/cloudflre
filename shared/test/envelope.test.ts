/**
 * WP-4E — runtime validation of an untrusted queue body.
 *
 * The queue consumer cannot repair a malformed envelope, and the old check
 * (`v === 1 && typeof deliveryId === "string"`) was loose enough to let a body
 * through that then threw inside the handler. That mattered because of how the
 * failure was classified: an exception in the handler is a *transient* failure, so
 * the message was retried until the queue gave up and only then archived — four
 * attempts to discover a payload that could never work.
 *
 * These cases are the contract the check has to hold: anything a producer really
 * emits is accepted, and anything missing a required part is refused at the door.
 */
import { describe, expect, it } from "vitest";
import {
  ENVELOPE_KINDS,
  ENVELOPE_VERSION,
  isEnvelopeKind,
  isEnvelopeV1,
  isWuzapiEventKind,
  type EnvelopeV1,
} from "../src/envelope";

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: ENVELOPE_VERSION,
    kind: "event",
    receivedAt: "2026-10-10T08:00:00.000Z",
    deliveryId: "a".repeat(64),
    contentType: "application/json",
    hmac: { verified: true, algorithm: "hmac-sha256" },
    event: { type: "Message", userID: "1", instanceName: "nomor-1", payload: { type: "Message" } },
    source: { worker: "6281234567890", slug: "6281234567890", ua: null, ip: null, rawSize: 300 },
    ...overrides,
  };
}

describe("isEnvelopeV1", () => {
  it("accepts a complete event envelope", () => {
    expect(isEnvelopeV1(valid())).toBe(true);
  });

  it("accepts an offloaded media pointer, where payload is explicitly null", () => {
    const pointer = valid({
      kind: "media-pointer",
      event: { type: "Message", userID: "1", instanceName: "nomor-1", payload: null },
      media: {
        r2Key: "events/6281234567890/2026/10/10/x.json",
        size: 140_069,
        sha256: "b".repeat(64),
        skippedFields: { base64: 140_002 },
        fields: { type: "Message" },
        fieldsOmitted: false,
        mediaUrl: null,
      },
    });
    expect(isEnvelopeV1(pointer)).toBe(true);
  });

  it("accepts the payment and outbox kinds a worker enqueues itself", () => {
    for (const kind of ["payment.event", "outbox.tick"] as const) {
      expect(isEnvelopeV1(valid({ kind }))).toBe(true);
    }
  });

  it.each([
    ["null", null],
    ["a string", "event"],
    ["a number", 1],
    ["an array", []],
    ["an empty object", {}],
    ["a wrong version", valid({ v: 99 })],
    ["a string version", valid({ v: "1" })],
    ["a missing delivery id", valid({ deliveryId: undefined })],
    ["an empty delivery id", valid({ deliveryId: "" })],
    ["a numeric delivery id", valid({ deliveryId: 42 })],
    ["an unknown kind", valid({ kind: "nonsense" })],
    ["a non-string kind", valid({ kind: 1 })],
    ["a missing kind", valid({ kind: undefined })],
    ["a missing event block", valid({ event: undefined })],
    ["a null event block", valid({ event: null })],
    ["a string event block", valid({ event: "Message" })],
    ["an event with no payload key", valid({ event: { type: "Message", userID: null, instanceName: null } })],
    ["an event with a mistyped type", valid({ event: { type: 7, userID: null, instanceName: null, payload: null } })],
    ["an event with a mistyped userID", valid({ event: { type: null, userID: 7, instanceName: null, payload: null } })],
    ["an event with a mistyped instanceName", valid({ event: { type: null, userID: null, instanceName: 7, payload: null } })],
  ])("refuses %s", (_label, body) => {
    expect(isEnvelopeV1(body)).toBe(false);
  });

  it("narrows the type, so a consumer can use the body without a cast", () => {
    const body: unknown = valid();
    if (!isEnvelopeV1(body)) throw new Error("expected a valid envelope");
    // The assertion is the compile-time narrowing: this line only type-checks
    // because the guard proved the shape.
    const typed: EnvelopeV1 = body;
    expect(typed.event.type).toBe("Message");
  });
});

describe("envelope kind helpers", () => {
  it("lists every kind a consumer is allowed to see", () => {
    expect([...ENVELOPE_KINDS]).toEqual(["event", "media-pointer", "wuzapi.event", "payment.event", "outbox.tick"]);
  });

  it("recognises exactly those kinds", () => {
    for (const kind of ENVELOPE_KINDS) expect(isEnvelopeKind(kind)).toBe(true);
    for (const bad of ["", "Event", "all", null, undefined, 1, {}]) expect(isEnvelopeKind(bad)).toBe(false);
  });

  it("classifies the three wuzapi-sourced kinds and nothing else", () => {
    expect(isWuzapiEventKind("event")).toBe(true);
    expect(isWuzapiEventKind("media-pointer")).toBe(true);
    expect(isWuzapiEventKind("wuzapi.event")).toBe(true);
    expect(isWuzapiEventKind("payment.event")).toBe(false);
    expect(isWuzapiEventKind("outbox.tick")).toBe(false);
    expect(isWuzapiEventKind("nonsense")).toBe(false);
  });
});
