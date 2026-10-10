#!/usr/bin/env node
/**
 * `pnpm run mock:services [-- --port 8898]`
 *
 * One process that stands in for the three third parties the worker calls:
 *
 *   /wuzapi/*    wuzapi REST API — records every send, so the E2E test can assert
 *                "exactly one reply reached the customer"
 *   /telegram/*  Telegram Bot API — records messages and edits, so the E2E test
 *                can press the approval buttons and check the card was edited
 *   /ai/v1/*     an OpenAI-compatible endpoint driven by a *script*: the test
 *                decides which tool the model asks for, which is the only way to
 *                test the tool loop deterministically
 *
 * Control endpoints (used by scripts/e2e-bot.mjs, not by the worker):
 *   GET  /__health                      ready check
 *   POST /__reset                       forget every recorded call
 *   POST /__script  { "steps": [...] }  set the AI's scripted turns
 *   GET  /__calls   ?service=wuzapi     recorded calls (wuzapi | telegram | ai)
 *
 * It binds to 127.0.0.1 only and stores nothing: a test harness, not a service.
 */
import http from "node:http";

function flagValue(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : (argv[index + 1] ?? fallback);
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.error("usage: node scripts/mock-services.mjs [--port 8898] [--fail-first-sends 0]");
  process.exit(0);
}

const port = Number(flagValue(argv, "--port", "8898"));
const failFirstSends = Number(flagValue(argv, "--fail-first-sends", "0"));

/** service → recorded calls */
const calls = { wuzapi: [], telegram: [], ai: [] };
let nextTelegramMessageId = 1000;
let sendAttempts = 0;
/** AI script: one entry consumed per chat completion request. */
let aiScript = [{ content: "Halo, ada yang bisa dibantu?" }];
let aiCursor = 0;

function record(service, url, body) {
  calls[service].push({ url, body, at: new Date().toISOString() });
  if (calls[service].length > 500) calls[service].shift();
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

function parseJson(text) {
  try {
    return text === "" ? {} : JSON.parse(text);
  } catch {
    return {};
  }
}

/** wuzapi answers `{ code, success, data }`. */
function wuzapiReply(res, data) {
  sendJson(res, 200, { code: 200, success: true, data });
}

function handleWuzapi(path, method, body, res) {
  const json = parseJson(body);
  record("wuzapi", `${method} ${path}`, json);

  if (path === "/user/contacts" && method === "GET") {
    wuzapiReply(res, {
      "628222@s.whatsapp.net": { FullName: "Siti", FirstName: "Siti", PushName: "siti", BusinessName: "" },
    });
    return true;
  }

  if (path === "/chat/presence") {
    wuzapiReply(res, {});
    return true;
  }

  if (path.startsWith("/chat/send/")) {
    sendAttempts += 1;
    if (sendAttempts <= failFirstSends) {
      sendJson(res, 503, { code: 503, success: false, error: "simulated outage" });
      return true;
    }
    wuzapiReply(res, { Id: json.Id ?? `MOCK-${sendAttempts}` });
    return true;
  }

  sendJson(res, 404, { code: 404, success: false, error: `mock wuzapi has no ${method} ${path}` });
  return true;
}

function handleTelegram(path, method, body, res) {
  const json = parseJson(body);
  record("telegram", `${method} ${path}`, json);
  const methodName = path.split("/").pop();

  switch (methodName) {
    case "sendMessage":
    case "sendDocument": {
      nextTelegramMessageId += 1;
      sendJson(res, 200, { ok: true, result: { message_id: nextTelegramMessageId } });
      return true;
    }
    case "editMessageText":
    case "answerCallbackQuery":
    case "deleteMessage":
      sendJson(res, 200, { ok: true, result: true });
      return true;
    default:
      sendJson(res, 404, { ok: false, description: `mock telegram has no ${methodName}` });
      return true;
  }
}

function handleAi(path, method, body, res) {
  const json = parseJson(body);
  const messages = Array.isArray(json.messages) ? json.messages : [];
  record("ai", `${method} ${path}`, {
    model: json.model,
    tools: Array.isArray(json.tools) ? json.tools.map((tool) => tool.function?.name) : [],
    lastMessage: messages[messages.length - 1]?.role ?? null,
    messageCount: messages.length,
  });

  if (path.endsWith("/models")) {
    sendJson(res, 200, { object: "list", data: [{ id: json.model ?? "mock-model", object: "model" }] });
    return true;
  }

  if (!path.endsWith("/chat/completions")) {
    sendJson(res, 404, { error: { message: `mock ai has no ${method} ${path}` } });
    return true;
  }

  const step = aiScript[Math.min(aiCursor, aiScript.length - 1)] ?? { content: "Halo!" };
  // One script step per *turn*: a turn that asks for a tool is followed by a turn
  // that consumes the tool result, which is how the real loop behaves.
  aiCursor += 1;

  const message = { role: "assistant", content: step.content ?? "" };
  if (step.tool) {
    message.content = step.content ?? "";
    message.tool_calls = [
      {
        id: `call_${aiCursor}`,
        type: "function",
        function: { name: step.tool.name, arguments: JSON.stringify(step.tool.arguments ?? {}) },
      },
    ];
  }

  sendJson(res, 200, {
    id: `chatcmpl-mock-${aiCursor}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: json.model ?? "mock-model",
    choices: [
      {
        index: 0,
        message,
        finish_reason: step.tool ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  });
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const path = url.pathname;
  const method = req.method ?? "GET";
  const body = method === "POST" ? await readBody(req) : "";

  if (path === "/__health") {
    sendJson(res, 200, { ok: true, aiCursor, calls: { wuzapi: calls.wuzapi.length, telegram: calls.telegram.length, ai: calls.ai.length } });
    return;
  }

  if (path === "/__reset") {
    calls.wuzapi.length = 0;
    calls.telegram.length = 0;
    calls.ai.length = 0;
    aiCursor = 0;
    sendAttempts = 0;
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path === "/__script") {
    const parsed = parseJson(body);
    if (Array.isArray(parsed.steps) && parsed.steps.length > 0) {
      aiScript = parsed.steps;
      aiCursor = 0;
    }
    sendJson(res, 200, { ok: true, steps: aiScript.length });
    return;
  }

  if (path === "/__calls") {
    const service = url.searchParams.get("service") ?? "wuzapi";
    sendJson(res, 200, { ok: true, service, calls: calls[service] ?? [] });
    return;
  }

  if (path.startsWith("/wuzapi/")) return void handleWuzapi(path.slice("/wuzapi".length), method, body, res);
  if (path.startsWith("/telegram/")) return void handleTelegram(path.slice("/telegram".length), method, body, res);
  if (path.startsWith("/ai/")) return void handleAi(path.slice("/ai".length), method, body, res);

  sendJson(res, 404, { error: `unknown path ${path}` });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`[mock-services] listening on http://127.0.0.1:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
