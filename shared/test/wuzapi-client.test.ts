/**
 * WuzapiClient tests.
 *
 * The first test is the important one. It passes the *raw global* `fetch` as the
 * client's transport, which is exactly what the worker does in production. An
 * earlier version stored that function in a field and called it as
 * `this.fetchImpl(...)`, so workerd saw `this` bound to the client and threw
 * "Illegal invocation: function called with incorrect `this` reference" — every
 * outbound reply in `BOT_MODE=on` failed. The whole test suite passed anyway,
 * because every other test injects an arrow function that ignores `this`. This
 * case exists so that regression can never come back silently.
 *
 * It asserts on the absence of that specific error rather than on a successful
 * request, because it needs no network: `wuzapi.invalid` is guaranteed never to
 * resolve (RFC 2606), so a correctly bound call fails with a DNS error instead.
 */
import { describe, expect, it } from "vitest";
import { WuzapiClient, type WuzapiSendResult } from "../src/bot/wuzapi/client";
import { createLogger } from "../src/lib/logger";

const quiet = createLogger({ handler: "test" }, () => {});

interface Call {
  url: string;
  method: string;
  token: string | null;
  contentType: string | null;
  body: Record<string, unknown> | null;
}

/** A transport that records calls; a double, so it cannot catch the `this` bug. */
function recorder(
  reply: (call: Call, attempt: number) => Response,
): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  return {
    calls,
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const call: Call = {
        url: String(input),
        method: init?.method ?? "GET",
        token: headers.get("token"),
        contentType: headers.get("content-type"),
        body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      };
      calls.push(call);
      return reply(call, calls.length);
    }) as typeof fetch,
  };
}

function ok(data: Record<string, unknown> = { Id: "WA-1", Details: "sent" }): Response {
  return new Response(JSON.stringify({ code: 200, success: true, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function client(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof WuzapiClient>[0]> = {}): WuzapiClient {
  return new WuzapiClient({
    baseUrl: "https://wuzapi.example.test",
    token: "test-token",
    deps: { fetchImpl, log: quiet, sleep: async () => {} },
    ...extra,
  });
}

describe("WuzapiClient transport", () => {
  it("calls the raw global fetch without an Illegal invocation error", async () => {
    const bare = new WuzapiClient({
      baseUrl: "https://wuzapi.invalid",
      token: "test-token",
      // The point: the real global fetch, not a double. A `.invalid` host never
      // resolves, so a correctly bound call reports a network error.
      deps: { fetchImpl: fetch, log: quiet, sleep: async () => {}, retryDelaysMs: [] },
    });

    const result = await bare.sendText("628111@s.whatsapp.net", "halo");

    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("Illegal invocation");
    expect(result.attempts).toBe(1);
  });

  it("refuses to call anything when it is not configured", async () => {
    const { calls, fetchImpl } = recorder(() => ok());
    const unconfigured = new WuzapiClient({
      baseUrl: "",
      token: "",
      deps: { fetchImpl, log: quiet, sleep: async () => {} },
    });

    const result = await unconfigured.sendText("628111@s.whatsapp.net", "halo");
    expect(result.ok).toBe(false);
    expect(result.permanent).toBe(true);
    expect(result.error).toContain("not configured");
    expect(calls).toHaveLength(0);
  });
});

describe("WuzapiClient requests", () => {
  it("posts text to /chat/send/text with the Token header and {Phone, Body}", async () => {
    const { calls, fetchImpl } = recorder(() => ok());
    const api = client(fetchImpl);

    const result = await api.sendText("628111@s.whatsapp.net", "Halo Kak");

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("WA-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://wuzapi.example.test/chat/send/text");
    expect(calls[0]?.method).toBe("POST");
    // wuzapi's authalice() reads the token from this header, not Authorization.
    expect(calls[0]?.token).toBe("test-token");
    expect(calls[0]?.contentType).toBe("application/json");
    expect(calls[0]?.body).toEqual({ Phone: "628111@s.whatsapp.net", Body: "Halo Kak" });
  });

  it("passes the fields wuzapi's SendImage and SendDocument decoders expect", async () => {
    const { calls, fetchImpl } = recorder(() => ok());
    const api = client(fetchImpl);

    await api.sendImage("628111@s.whatsapp.net", "BASE64", "caption", { mimeType: "image/jpeg" });
    await api.sendDocument("628111@s.whatsapp.net", "BASE64", "nota.pdf", {
      caption: "nota",
      mimeType: "application/pdf",
    });

    expect(calls[0]?.url).toBe("https://wuzapi.example.test/chat/send/image");
    expect(calls[0]?.body).toEqual({
      Phone: "628111@s.whatsapp.net",
      Image: "BASE64",
      Caption: "caption",
      MimeType: "image/jpeg",
    });
    expect(calls[1]?.url).toBe("https://wuzapi.example.test/chat/send/document");
    expect(calls[1]?.body).toEqual({
      Phone: "628111@s.whatsapp.net",
      Document: "BASE64",
      FileName: "nota.pdf",
      Caption: "nota",
      MimeType: "application/pdf",
    });
  });

  it("sends presence with the state values whatsmeow accepts", async () => {
    const { calls, fetchImpl } = recorder(() => ok({ Details: "Chat presence set successfuly" }));
    const api = client(fetchImpl);

    await api.sendPresence("628111@s.whatsapp.net", "composing");
    await api.sendPresence("628111@s.whatsapp.net", "paused");

    expect(calls[0]?.url).toBe("https://wuzapi.example.test/chat/presence");
    expect(calls[0]?.body).toEqual({ Phone: "628111@s.whatsapp.net", State: "composing", Media: "" });
    expect(calls[1]?.body).toEqual({ Phone: "628111@s.whatsapp.net", State: "paused", Media: "" });
  });

  it("strips a trailing slash from the base URL", async () => {
    const { calls, fetchImpl } = recorder(() => ok());
    const api = new WuzapiClient({
      baseUrl: "https://wuzapi.example.test/",
      token: "t",
      deps: { fetchImpl, log: quiet, sleep: async () => {} },
    });
    await api.sendText("628111@s.whatsapp.net", "halo");
    expect(calls[0]?.url).toBe("https://wuzapi.example.test/chat/send/text");
  });

  it("reads the { <jid>: ContactInfo } map from GET /user/contacts", async () => {
    const { calls, fetchImpl } = recorder(
      () =>
        new Response(
          JSON.stringify({
            code: 200,
            success: true,
            data: {
              "628111@s.whatsapp.net": { Found: true, FullName: "Budi no_ai", PushName: "budi" },
              "628222@s.whatsapp.net": { Found: true, FullName: "Siti" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const api = client(fetchImpl);

    const result = await api.getContacts();
    expect(result.ok).toBe(true);
    expect(Object.keys(result.contacts)).toHaveLength(2);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("https://wuzapi.example.test/user/contacts");
  });
});

describe("WuzapiClient failure handling", () => {
  it("retries 429 and 5xx, then succeeds", async () => {
    const { calls, fetchImpl } = recorder((_call, attempt) => {
      if (attempt === 1) return new Response(JSON.stringify({ code: 429, success: false, error: "slow down" }), { status: 429 });
      if (attempt === 2) return new Response("upstream boom", { status: 502 });
      return ok({ Id: "WA-3" });
    });

    const result = await client(fetchImpl).sendText("628111@s.whatsapp.net", "halo");
    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("WA-3");
    expect(result.attempts).toBe(3);
    expect(calls).toHaveLength(3);
  });

  it("gives up after the retry ladder is exhausted and reports it as retryable", async () => {
    const { calls, fetchImpl } = recorder(() => new Response("boom", { status: 500 }));
    const result = await client(fetchImpl).sendText("628111@s.whatsapp.net", "halo");

    expect(result.ok).toBe(false);
    // 1 initial attempt + 3 configured delays.
    expect(result.attempts).toBe(4);
    expect(calls).toHaveLength(4);
    expect(result.permanent).toBe(false);
  });

  it("does not retry a 4xx, because the same call cannot succeed", async () => {
    const { calls, fetchImpl } = recorder(
      () => new Response(JSON.stringify({ code: 400, success: false, error: "missing Body in Payload" }), { status: 400 }),
    );
    const result = await client(fetchImpl).sendText("628111@s.whatsapp.net", "halo");

    expect(result.ok).toBe(false);
    expect(result.permanent).toBe(true);
    expect(result.error).toBe("missing Body in Payload");
    expect(calls).toHaveLength(1);
  });

  it("treats success:false with HTTP 200 as a failure", async () => {
    const { fetchImpl } = recorder(
      () => new Response(JSON.stringify({ code: 200, success: false, error: "no session" }), { status: 200 }),
    );
    const result: WuzapiSendResult = await client(fetchImpl).sendText("628111@s.whatsapp.net", "halo");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("no session");
  });

  it("survives a non-JSON error body", async () => {
    const { fetchImpl } = recorder(() => new Response("<html>502 Bad Gateway</html>", { status: 502 }));
    const result = await client(fetchImpl).sendText("628111@s.whatsapp.net", "halo");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("502 Bad Gateway");
  });

  it("reports a missing message id without failing the send", async () => {
    const { fetchImpl } = recorder(() => ok({ Details: "Chat presence set successfuly" }));
    const result = await client(fetchImpl).sendPresence("628111@s.whatsapp.net", "paused");
    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("Chat presence set successfuly");
  });
});
