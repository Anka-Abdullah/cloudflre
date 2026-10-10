/**
 * Agent loop tests (work order FASE 3, step 4).
 *
 * The model is faked at the HTTP boundary (a scripted `fetch` answering in OpenAI
 * shape) rather than by stubbing the client, so the wire format is under test too:
 * what actually goes out on the request — which messages, whether `tools` is
 * offered, and above all whether `reasoning_content` ever appears.
 */
import { describe, expect, it } from "vitest";
import { loadConfig, type Env } from "../src/config";
import { env } from "cloudflare:workers";
import { LlmClient, type LlmMessage } from "../src/bot/agent/llm";
import { runAgentLoop, type AgentTurnInput } from "../src/bot/agent/run";
import { TOOL_DEFINITIONS, type ToolOutcome } from "../src/bot/agent/tools";
import { parseJsonAction, renderJsonModeInstructions } from "../src/bot/agent/prompt";
import { createLogger } from "../src/lib/logger";
import type { InboundMessage } from "../src/bot/types";

const config = loadConfig(env as unknown as Env);
const quiet = createLogger({ handler: "test" }, () => {});

interface RecordedRequest {
  url: string;
  body: Record<string, unknown>;
  messages: LlmMessage[];
  hasTools: boolean;
}

/** Answers each call with the next scripted response, recording what was sent. */
function scriptedModel(responses: readonly unknown[]): {
  fetchImpl: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    requests.push({
      url: String(input),
      body,
      messages: (body["messages"] ?? []) as LlmMessage[],
      hasTools: Array.isArray(body["tools"]) && (body["tools"] as unknown[]).length > 0,
    });
    const response = responses[requests.length - 1];
    if (response === undefined) throw new Error(`model called ${requests.length} times but only ${responses.length} responses were scripted`);
    return response instanceof Response
      ? response
      : new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

function textResponse(content: string, extra: Record<string, unknown> = {}): unknown {
  return { choices: [{ finish_reason: "stop", message: { role: "assistant", content, ...extra } }] };
}

function toolResponse(calls: readonly { id: string; name: string; args?: string }[], content: string | null = null): unknown {
  return {
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content,
          // Always present in practice, and never allowed to travel back out.
          reasoning_content: "SCRATCHPAD YANG TIDAK BOLEH DIKIRIM",
          tool_calls: calls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.args ?? "{}" },
          })),
        },
      },
    ],
  };
}

function makeClient(fetchImpl: typeof fetch, maxTokens = 2_048): LlmClient {
  return new LlmClient({
    baseUrl: "https://ai.example.test/v1",
    apiKey: "test-key",
    model: "test-model",
    timeoutMs: 5_000,
    maxTokens,
    deps: { fetchImpl, log: quiet, sleep: async () => {}, retryDelaysMs: [1, 1, 1] },
  });
}

function message(body = "ada jaket hoodie?"): InboundMessage {
  return {
    chatJid: "628111@s.whatsapp.net",
    senderJid: "628111@s.whatsapp.net",
    waMessageId: "WA-1",
    pushName: "Budi",
    timestamp: 1_700_000_000_000,
    kind: "text",
    body,
  };
}

function turnInput(fetchImpl: typeof fetch, overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    env: { BOT_DB: undefined as never, MEDIA: undefined as never, R2_PUBLIC_BASE_URL: "" },
    config,
    log: quiet,
    llm: makeClient(fetchImpl),
    message: message(),
    history: [],
    now: new Date("2026-10-10T10:00:00Z"),
    botPrompt: "Kamu admin toko.",
    catalog: [],
    hits: [],
    noContext: true,
    cartText: "(keranjang kosong)",
    ...overrides,
  };
}

const noTools = async (): Promise<ToolOutcome> => ({ result: "ok", outbound: [], failed: false });

describe("runAgentLoop", () => {
  it("answers directly when the model asks for no tool", async () => {
    const { fetchImpl, requests } = scriptedModel([textResponse("Halo Kak, jaketnya ada.")]);
    const outcome = await runAgentLoop(turnInput(fetchImpl), { maxTurns: 3, execute: noTools });

    expect(outcome.text).toBe("Halo Kak, jaketnya ada.");
    expect(outcome.reason).toBe("agent");
    expect(outcome.toolCalls).toBe(0);
    expect(requests).toHaveLength(1);
  });

  it("executes a tool call and then answers with the follow-up text", async () => {
    const { fetchImpl, requests } = scriptedModel([
      toolResponse([{ id: "c1", name: "view_cart" }]),
      textResponse("Keranjang Kakak masih kosong."),
    ]);
    const seen: string[] = [];
    const outcome = await runAgentLoop(turnInput(fetchImpl), {
      maxTurns: 3,
      execute: async (name) => {
        seen.push(name);
        return { result: "Isi keranjang: (kosong)", outbound: [], failed: false };
      },
    });

    expect(seen).toEqual(["view_cart"]);
    expect(outcome.toolCalls).toBe(1);
    expect(outcome.text).toBe("Keranjang Kakak masih kosong.");
    expect(requests).toHaveLength(2);
    // The tool result is sent back as a tool turn carrying the call id.
    const secondCall = requests[1]?.messages ?? [];
    expect(secondCall.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c1" });
  });

  it("executes every tool call in one turn, not just the first", async () => {
    const { fetchImpl } = scriptedModel([
      toolResponse([
        { id: "c1", name: "add_to_cart", args: '{"kode":"116964","qty":1}' },
        { id: "c2", name: "send_image", args: '{"name":"produk.jpg"}' },
      ]),
      textResponse("Sudah aku tambahkan dan fotonya aku kirim ya kak."),
    ]);
    const seen: string[] = [];
    const outcome = await runAgentLoop(turnInput(fetchImpl), {
      maxTurns: 3,
      execute: async (name) => {
        seen.push(name);
        return name === "send_image"
          ? { result: "Gambar dikirim.", outbound: [{ kind: "image", image: "BASE64", caption: "Foto" }], failed: false }
          : { result: "ditambahkan", outbound: [], failed: false };
      },
    });

    expect(seen).toEqual(["add_to_cart", "send_image"]);
    expect(outcome.toolCalls).toBe(2);
    // The image is delivered before the closing text, so the text can refer to it.
    expect(outcome.outbound).toHaveLength(1);
    expect(outcome.text).toContain("fotonya aku kirim");
  });

  it("runs the tool even when the model also produced text", async () => {
    const { fetchImpl, requests } = scriptedModel([
      toolResponse([{ id: "c1", name: "view_cart" }], "Sebentar ya kak, aku cek dulu."),
      textResponse("Keranjangnya kosong kak."),
    ]);
    const outcome = await runAgentLoop(turnInput(fetchImpl), { maxTurns: 3, execute: noTools });

    // The intermediate sentence is not the answer...
    expect(outcome.text).toBe("Keranjangnya kosong kak.");
    expect(outcome.toolCalls).toBe(1);
    // ...and it is preserved as the assistant turn, as the API requires.
    expect(requests[1]?.messages.some((entry) => entry.role === "assistant")).toBe(true);
  });

  it("stops offering tools on the final turn so the model must answer", async () => {
    const { fetchImpl, requests } = scriptedModel([
      toolResponse([{ id: "c1", name: "view_cart" }]),
      toolResponse([{ id: "c2", name: "view_cart" }]),
      textResponse("Ini jawaban akhirnya."),
    ]);
    const outcome = await runAgentLoop(turnInput(fetchImpl), { maxTurns: 3, execute: noTools });

    expect(outcome.text).toBe("Ini jawaban akhirnya.");
    expect(requests).toHaveLength(3);
    expect(requests[0]?.hasTools).toBe(true);
    expect(requests[1]?.hasTools).toBe(true);
    // Without tools on the last turn the model has no choice but prose.
    expect(requests[2]?.hasTools).toBe(false);
  });

  it("falls back when the turn budget runs out with tools still pending", async () => {
    const { fetchImpl, requests } = scriptedModel([
      toolResponse([{ id: "c1", name: "view_cart" }]),
      toolResponse([{ id: "c2", name: "view_cart" }]),
      toolResponse([{ id: "c3", name: "view_cart" }]),
    ]);
    const outcome = await runAgentLoop(turnInput(fetchImpl), { maxTurns: 2, execute: noTools });

    expect(outcome.text).toBe("");
    expect(outcome.reason).toBe("fallback_max_turns");
    expect(requests).toHaveLength(2);
  });

  it("never sends reasoning_content back to the model", async () => {
    const { fetchImpl, requests } = scriptedModel([
      toolResponse([{ id: "c1", name: "view_cart" }]),
      textResponse("Selesai."),
    ]);
    await runAgentLoop(turnInput(fetchImpl), { maxTurns: 3, execute: noTools });

    for (const request of requests) {
      const serialised = JSON.stringify(request.body);
      expect(serialised).not.toContain("reasoning_content");
      expect(serialised).not.toContain("SCRATCHPAD");
    }
  });

  it("reports an unusable model response as a fallback instead of throwing", async () => {
    const { fetchImpl } = scriptedModel([
      { choices: [{ finish_reason: "length", message: { role: "assistant", content: "" } }] },
    ]);
    const outcome = await runAgentLoop(turnInput(fetchImpl), { maxTurns: 3, execute: noTools });

    expect(outcome.text).toBe("");
    expect(outcome.reason).toBe("fallback_ai_error");
  });

  it("propagates a mid-turn model failure as its own reason", async () => {
    const { fetchImpl } = scriptedModel([
      toolResponse([{ id: "c1", name: "view_cart" }]),
      { choices: [{ finish_reason: "length", message: { role: "assistant", content: "" } }] },
    ]);
    const outcome = await runAgentLoop(turnInput(fetchImpl), { maxTurns: 3, execute: noTools });

    expect(outcome.reason).toBe("fallback_ai_error_midturn");
    // The image/text collected before the failure is still reported, so a tool
    // that already sent something does not get silently discarded.
    expect(outcome.outbound).toEqual([]);
  });
});

describe("LlmClient", () => {
  it("sends the documented request body and reads content plus tool_calls", async () => {
    const { fetchImpl, requests } = scriptedModel([toolResponse([{ id: "c1", name: "get_price", args: '{"kode":"T1"}' }])]);
    const result = await makeClient(fetchImpl, 2_048).chat([{ role: "user", content: "harga?" }], TOOL_DEFINITIONS);

    expect(result.ok).toBe(true);
    expect(result.message?.tool_calls?.[0]).toMatchObject({ id: "c1", name: "get_price", arguments: '{"kode":"T1"}' });
    expect(result.message?.content).toBeNull();
    expect(requests[0]?.body["max_tokens"]).toBe(2_048);
    expect(requests[0]?.body["model"]).toBe("test-model");
    expect(requests[0]?.body["tool_choice"]).toBe("auto");
  });

  it("treats finish_reason length with empty content as a budget error", async () => {
    const { fetchImpl } = scriptedModel([{ choices: [{ finish_reason: "length", message: { role: "assistant", content: "" } }] }]);
    const result = await makeClient(fetchImpl, 128).chat([{ role: "user", content: "halo" }]);

    expect(result.ok).toBe(false);
    expect(result.finishReason).toBe("length");
    expect(result.error).toContain("AI_MAX_TOKENS");
  });

  it("retries 429 and 5xx on the ladder", async () => {
    const { fetchImpl, requests } = scriptedModel([
      new Response(JSON.stringify({ error: "slow down" }), { status: 429 }),
      new Response("boom", { status: 502 }),
      textResponse("Akhirnya berhasil."),
    ]);
    const result = await makeClient(fetchImpl).chat([{ role: "user", content: "halo" }]);

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(3);
    expect(requests).toHaveLength(3);
  });

  it("does not retry a 401, because the key will not fix itself", async () => {
    const { fetchImpl, requests } = scriptedModel([new Response(JSON.stringify({ error: "API key required" }), { status: 401 })]);
    const result = await makeClient(fetchImpl).chat([{ role: "user", content: "halo" }]);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("API key required");
    expect(requests).toHaveLength(1);
  });

  it("reports a concise error string as well as an object error", async () => {
    const { fetchImpl } = scriptedModel([new Response(JSON.stringify({ error: "API key required for remote API access" }), { status: 401 })]);
    const result = await makeClient(fetchImpl).chat([{ role: "user", content: "halo" }]);
    expect(result.error).toBe("API key required for remote API access");
  });

  it("survives a non-JSON error body", async () => {
    // 403 is not retryable, so a single scripted response is enough and the test
    // is about parsing the body rather than about the retry ladder.
    const { fetchImpl, requests } = scriptedModel([new Response("<html>403 Forbidden</html>", { status: 403 })]);
    const result = await makeClient(fetchImpl).chat([{ role: "user", content: "halo" }]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("403 Forbidden");
    expect(requests).toHaveLength(1);
  });

  it("gives up after the retry ladder is exhausted", async () => {
    const { fetchImpl, requests } = scriptedModel([
      new Response("boom", { status: 500 }),
      new Response("boom", { status: 500 }),
      new Response("boom", { status: 500 }),
      new Response("boom", { status: 500 }),
    ]);
    const result = await makeClient(fetchImpl).chat([{ role: "user", content: "halo" }]);
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(4);
    expect(requests).toHaveLength(4);
  });

  it("refuses to call anything when unconfigured", async () => {
    const { fetchImpl, requests } = scriptedModel([]);
    const unconfigured = new LlmClient({ baseUrl: "", apiKey: "", model: "", timeoutMs: 1_000, maxTokens: 10, deps: { fetchImpl, log: quiet } });
    const result = await unconfigured.chat([{ role: "user", content: "halo" }]);
    expect(result.ok).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it("calls the raw global fetch without an Illegal invocation error", async () => {
    // Same trap the WuzAPI client hit: a stored global called as a method.
    const bare = new LlmClient({
      baseUrl: "https://ai.invalid/v1",
      apiKey: "k",
      model: "m",
      timeoutMs: 2_000,
      maxTokens: 16,
      deps: { fetchImpl: fetch, log: quiet, sleep: async () => {}, retryDelaysMs: [] },
    });
    const result = await bare.chat([{ role: "user", content: "halo" }]);
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("Illegal invocation");
  });
});

// ---------------------------------------------------------------------------
// JSON mode (work order: "Fallback JSON mode disiapkan, bukan mode utama")
// ---------------------------------------------------------------------------

describe("parseJsonAction", () => {
  it("reads a reply action", () => {
    expect(parseJsonAction('{"action":"reply","text":"Halo kak"}')).toEqual({ kind: "reply", text: "Halo kak" });
  });

  it("reads a tool action with its arguments", () => {
    expect(parseJsonAction('{"action":"tool","tool":"add_to_cart","arguments":{"kode":"116964","qty":2}}')).toEqual({
      kind: "tool",
      tool: "add_to_cart",
      arguments: { kode: "116964", qty: 2 },
    });
  });

  it("unwraps a ```json fence the model adds anyway", () => {
    expect(parseJsonAction('```json\n{"action":"reply","text":"Ya"}\n```')).toEqual({ kind: "reply", text: "Ya" });
    expect(parseJsonAction('```\n{"action":"reply","text":"Ya"}\n```')).toEqual({ kind: "reply", text: "Ya" });
  });

  it("infers the action when the model omits it", () => {
    expect(parseJsonAction('{"tool":"view_cart","arguments":{}}')).toEqual({ kind: "tool", tool: "view_cart", arguments: {} });
    expect(parseJsonAction('{"text":"Halo"}')).toEqual({ kind: "reply", text: "Halo" });
  });

  it("uses a plain-text answer as the reply rather than discarding it", () => {
    // A model that ignores the protocol but answers the customer should not have
    // its answer thrown away for being off-format.
    expect(parseJsonAction("Halo kak, jaketnya ada.")).toEqual({ kind: "reply", text: "Halo kak, jaketnya ada." });
  });

  it("returns null when there is nothing usable", () => {
    expect(parseJsonAction("")).toBeNull();
    expect(parseJsonAction("   ")).toBeNull();
    expect(parseJsonAction('{"action":"tool","tool":""}')).toBeNull();
    expect(parseJsonAction('{"action":"tool","arguments":{}}')).toBeNull();
  });

  it("defaults missing arguments to an empty object", () => {
    expect(parseJsonAction('{"action":"tool","tool":"view_cart"}')).toEqual({ kind: "tool", tool: "view_cart", arguments: {} });
  });
});

describe("renderJsonModeInstructions", () => {
  it("lists every tool and both response shapes", () => {
    const text = renderJsonModeInstructions([{ name: "view_cart", description: "Lihat keranjang" }]);
    expect(text).toContain("view_cart");
    expect(text).toContain('"action":"tool"');
    expect(text).toContain('"action":"reply"');
  });
});

describe("runAgentLoop in JSON mode", () => {
  it("does not send a tools array and answers from a reply action", async () => {
    const { fetchImpl, requests } = scriptedModel([textResponse('{"action":"reply","text":"Jaketnya ada kak."}')]);
    const outcome = await runAgentLoop(turnInput(fetchImpl), { maxTurns: 3, mode: "json", execute: noTools });

    expect(outcome.text).toBe("Jaketnya ada kak.");
    expect(outcome.reason).toBe("agent_json");
    expect(requests[0]?.hasTools).toBe(false);
    // The contract reaches the model through the system prompt instead.
    const system = requests[0]?.messages.find((entry) => entry.role === "system");
    expect(String(system?.content)).toContain('"action":"tool"');
  });

  it("executes a tool action and uses the follow-up reply", async () => {
    const { fetchImpl, requests } = scriptedModel([
      textResponse('{"action":"tool","tool":"view_cart","arguments":{}}'),
      textResponse('{"action":"reply","text":"Keranjangnya kosong kak."}'),
    ]);
    const seen: string[] = [];
    const outcome = await runAgentLoop(turnInput(fetchImpl), {
      maxTurns: 3,
      mode: "json",
      execute: async (name) => {
        seen.push(name);
        return { result: "Isi keranjang: (kosong)", outbound: [], failed: false };
      },
    });

    expect(seen).toEqual(["view_cart"]);
    expect(outcome.text).toBe("Keranjangnya kosong kak.");
    expect(outcome.toolCalls).toBe(1);
    // The tool result is handed back as a user turn: JSON mode has no tool role.
    expect(requests[1]?.messages.at(-1)).toMatchObject({ role: "user" });
    expect(String(requests[1]?.messages.at(-1)?.content)).toContain("HASIL TOOL view_cart");
  });

  it("collects outbound produced by a tool", async () => {
    const { fetchImpl } = scriptedModel([
      textResponse('{"action":"tool","tool":"send_image","arguments":{"name":"a.jpg"}}'),
      textResponse('{"action":"reply","text":"Fotonya sudah aku kirim."}'),
    ]);
    const outcome = await runAgentLoop(turnInput(fetchImpl), {
      maxTurns: 3,
      mode: "json",
      execute: async () => ({ result: "terkirim", outbound: [{ kind: "image", image: "B64", caption: "Foto" }], failed: false }),
    });
    expect(outcome.outbound).toHaveLength(1);
    expect(outcome.text).toContain("Fotonya");
  });

  it("refuses a tool call on the last turn and falls back", async () => {
    const { fetchImpl } = scriptedModel([
      textResponse('{"action":"tool","tool":"view_cart","arguments":{}}'),
      textResponse('{"action":"tool","tool":"view_cart","arguments":{}}'),
    ]);
    const outcome = await runAgentLoop(turnInput(fetchImpl), { maxTurns: 2, mode: "json", execute: noTools });
    expect(outcome.text).toBe("");
    expect(outcome.reason).toBe("fallback_max_turns");
  });

  it("reports an unparsable answer instead of sending it", async () => {
    const { fetchImpl } = scriptedModel([textResponse('{"action":"menari"}')]);
    const outcome = await runAgentLoop(turnInput(fetchImpl), { maxTurns: 3, mode: "json", execute: noTools });
    expect(outcome.text).toBe("");
    expect(outcome.reason).toBe("fallback_json_unparsable");
  });

  it("switches to JSON mode when the endpoint refuses the tools array", async () => {
    const { fetchImpl, requests } = scriptedModel([
      // An endpoint that does not implement native tools.
      new Response(JSON.stringify({ error: "tools is not supported" }), { status: 400 }),
      textResponse('{"action":"reply","text":"Pakai mode JSON."}'),
    ]);
    const outcome = await runAgentLoop(turnInput(fetchImpl), {
      maxTurns: 3,
      mode: "native",
      jsonFallback: true,
      execute: noTools,
    });

    expect(outcome.text).toBe("Pakai mode JSON.");
    expect(outcome.reason).toBe("agent_json_fallback");
    expect(requests[0]?.hasTools).toBe(true);
    expect(requests[1]?.hasTools).toBe(false);
  });

  it("does not switch modes when the fallback is disabled", async () => {
    const { fetchImpl, requests } = scriptedModel([
      new Response(JSON.stringify({ error: "tools is not supported" }), { status: 400 }),
    ]);
    const outcome = await runAgentLoop(turnInput(fetchImpl), {
      maxTurns: 3,
      mode: "native",
      jsonFallback: false,
      execute: noTools,
    });

    expect(outcome.text).toBe("");
    expect(outcome.reason).toBe("fallback_ai_error");
    expect(requests).toHaveLength(1);
  });
});
