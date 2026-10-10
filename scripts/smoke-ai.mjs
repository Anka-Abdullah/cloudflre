#!/usr/bin/env node
/**
 * FASE 0 smoke test for the OpenAI-compatible endpoint (work plan section 0).
 *
 *   pnpm run smoke:ai -- --number 6281234567890
 *   AI_API_KEY=… pnpm run smoke:ai -- --base-url https://…/v1 --model …
 *
 * It answers three questions the architecture depends on, and prints a verdict
 * for each instead of a wall of JSON:
 *
 *   1. does a plain chat completion return text?
 *   2. does the model actually emit `tool_calls` (native function calling), or
 *      does the pipeline need the JSON-mode fallback?
 *   3. does `response_format: { type: "json_object" }` return parsable JSON?
 *
 * The API key is read from (in order) `--api-key`, `AI_API_KEY`, the number's
 * `.dev.vars`, or `cloudflare/.dev.vars` — all of which are git-ignored. The key
 * is never printed, never logged, and never written anywhere.
 *
 * Exit code 0 means "dialogue works"; a missing tool-calling capability is
 * reported but is not a failure, because the plan already specifies the JSON-mode
 * fallback (risk R1).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cloudflareRoot } from "./lib.mjs";

const DEFAULTS = {
  baseUrl: "https://sejahteraselamanya.my.id/v1",
  model: "cmc/deepseek/deepseek-v4.1-flash",
  timeoutMs: 60_000,
};

function parseArgs(argv) {
  const options = {
    number: null,
    baseUrl: null,
    model: null,
    apiKey: null,
    envFile: null,
    timeoutMs: DEFAULTS.timeoutMs,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--number":
      case "-n":
        options.number = next();
        break;
      case "--base-url":
        options.baseUrl = next();
        break;
      case "--model":
        options.model = next();
        break;
      case "--api-key":
        options.apiKey = next();
        break;
      case "--env-file":
        options.envFile = next();
        break;
      case "--timeout-ms":
        options.timeoutMs = Number(next());
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "usage: pnpm run smoke:ai -- [--number <nomor>] [--base-url <url>] [--model <id>]",
            "                            [--api-key <key>] [--env-file <path>] [--json]",
            "",
            "The key is read from --api-key, then $AI_API_KEY, then <number>/.dev.vars,",
            "then cloudflare/.dev.vars. Nothing is written to disk.",
          ].join("\n"),
        );
        process.exit(0);
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
        if (options.number === null) options.number = arg;
        else throw new Error(`unexpected argument ${arg}`);
    }
  }
  return options;
}

/** Minimal KEY=VALUE reader for .dev.vars and .env style files. */
async function readEnvFile(path) {
  try {
    const content = await readFile(path, "utf8");
    const values = {};
    for (const line of content.split("\n")) {
      const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      values[match[1]] = match[2].replace(/^["']|["']$/g, "").trim();
    }
    return values;
  } catch {
    return null;
  }
}

async function resolveSettings(options) {
  const candidates = [];
  if (options.envFile) candidates.push(options.envFile);
  if (options.number) candidates.push(join(cloudflareRoot, options.number, ".dev.vars"));
  candidates.push(join(cloudflareRoot, ".dev.vars"));

  let fromFile = {};
  let usedFile = null;
  for (const candidate of candidates) {
    const values = await readEnvFile(candidate);
    if (values && Object.keys(values).length > 0) {
      fromFile = values;
      usedFile = candidate;
      break;
    }
  }

  const apiKey = options.apiKey ?? process.env["AI_API_KEY"] ?? fromFile["AI_API_KEY"] ?? null;
  return {
    baseUrl: (options.baseUrl ?? process.env["AI_BASE_URL"] ?? fromFile["AI_BASE_URL"] ?? DEFAULTS.baseUrl).replace(/\/+$/, ""),
    model: options.model ?? process.env["AI_MODEL"] ?? fromFile["AI_MODEL"] ?? DEFAULTS.model,
    apiKey,
    timeoutMs: options.timeoutMs,
    keySource:
      options.apiKey !== null
        ? "--api-key"
        : process.env["AI_API_KEY"]
          ? "AI_API_KEY environment variable"
          : fromFile["AI_API_KEY"]
            ? usedFile
            : null,
  };
}

async function chatCompletion(settings, body) {
  const started = Date.now();
  const response = await fetch(`${settings.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({ model: settings.model, ...body }),
    signal: AbortSignal.timeout(settings.timeoutMs),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, ok: response.ok, parsed, text, elapsedMs: Date.now() - started };
}

function contentOf(parsed) {
  const message = parsed?.choices?.[0]?.message;
  return typeof message?.content === "string" ? message.content : "";
}

function toolCallsOf(parsed) {
  const calls = parsed?.choices?.[0]?.message?.tool_calls;
  return Array.isArray(calls) ? calls : [];
}

function errorText(result) {
  if (result.parsed?.error) return JSON.stringify(result.parsed.error).slice(0, 300);
  return result.text.slice(0, 300);
}

let options;

async function main() {
  options = parseArgs(process.argv.slice(2));
  const settings = await resolveSettings(options);

  console.log("AI smoke test (FASE 0)");
  console.log(`  base URL : ${settings.baseUrl}`);
  console.log(`  model    : ${settings.model}`);
  console.log(`  key      : ${settings.apiKey ? `present (${settings.keySource})` : "MISSING"}`);
  console.log("");

  if (!settings.apiKey) {
    console.error("error: no AI API key found.");
    console.error("  export AI_API_KEY=…            or  pnpm run smoke:ai -- --api-key …");
    console.error("  (production value: pnpm run secrets -- --number <nomor> --from-env)");
    process.exit(2);
  }

  const results = [];
  const record = (name, verdict, detail) => {
    results.push({ name, verdict, detail });
    const mark = verdict === "pass" ? "PASS" : verdict === "warn" ? "WARN" : "FAIL";
    console.log(`[${mark}] ${name}: ${detail}`);
  };

  // 1. plain dialogue ------------------------------------------------------
  let textOk = false;
  try {
    const result = await chatCompletion(settings, {
      messages: [
        { role: "system", content: "Jawab sangat singkat." },
        { role: "user", content: "Balas hanya dengan kata: SIAP" },
      ],
      max_tokens: 32,
      temperature: 0,
    });
    if (!result.ok) {
      record("text", "fail", `HTTP ${result.status} — ${errorText(result)}`);
    } else {
      const content = contentOf(result.parsed).trim();
      textOk = content !== "";
      record("text", textOk ? "pass" : "fail", textOk ? `"${content.slice(0, 60)}" in ${result.elapsedMs} ms` : "empty content");
    }
  } catch (error) {
    record("text", "fail", String(error.message ?? error));
  }

  // 2. native function calling --------------------------------------------
  let toolsOk = false;
  try {
    const result = await chatCompletion(settings, {
      messages: [
        { role: "system", content: "Gunakan tool yang tersedia. Jangan menebak harga." },
        { role: "user", content: "Berapa harga kaos polos? Pakai tool get_price." },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_price",
            description: "Ambil harga produk dari katalog.",
            parameters: {
              type: "object",
              properties: { kode: { type: "string", description: "kode produk" } },
              required: ["kode"],
            },
          },
        },
      ],
      tool_choice: "auto",
      max_tokens: 128,
      temperature: 0,
    });
    if (!result.ok) {
      record("function calling", "warn", `HTTP ${result.status} — ${errorText(result)}`);
    } else {
      const calls = toolCallsOf(result.parsed);
      toolsOk = calls.length > 0;
      record(
        "function calling",
        toolsOk ? "pass" : "warn",
        toolsOk
          ? `${calls.map((call) => call?.function?.name).join(", ")} in ${result.elapsedMs} ms`
          : "model answered in text; enable the JSON-mode fallback",
      );
    }
  } catch (error) {
    record("function calling", "warn", String(error.message ?? error));
  }

  // 3. JSON mode -----------------------------------------------------------
  let jsonOk = false;
  try {
    const result = await chatCompletion(settings, {
      messages: [
        { role: "system", content: 'Balas hanya dengan JSON: {"intent":"...","kode":"..."}' },
        { role: "user", content: "Saya mau beli kaos polos 2 pcs" },
      ],
      response_format: { type: "json_object" },
      max_tokens: 128,
      temperature: 0,
    });
    if (!result.ok) {
      record("JSON mode", "warn", `HTTP ${result.status} — ${errorText(result)}`);
    } else {
      const content = contentOf(result.parsed).trim();
      try {
        const parsed = JSON.parse(content);
        jsonOk = typeof parsed === "object" && parsed !== null;
        record("JSON mode", jsonOk ? "pass" : "warn", jsonOk ? `parsed ${Object.keys(parsed).join(", ")}` : "not an object");
      } catch {
        record("JSON mode", "warn", `content is not JSON: ${content.slice(0, 120)}`);
      }
    }
  } catch (error) {
    record("JSON mode", "warn", String(error.message ?? error));
  }

  console.log("");
  console.log("verdict:");
  console.log(`  dialogue         : ${textOk ? "OK" : "FAILED"}`);
  console.log(`  native tool call : ${toolsOk ? "OK — use native tool calling" : "NOT AVAILABLE — use JSON mode + internal parser"}`);
  console.log(`  JSON mode        : ${jsonOk ? "OK" : "NOT AVAILABLE — parse free text defensively"}`);
  console.log("");
  if (!textOk) {
    // Advice about tool calling is noise when nothing worked: the operator has a
    // credential or connectivity problem, not a capability question.
    console.log("config: fix the endpoint/key first - no capability was measured.");
  } else if (toolsOk) {
    console.log("config: leave AI tool calling on (plan Q7=A, native).");
  } else {
    console.log("config: AI_TOOLS_MODE=json - the agent must fall back to JSON mode (plan R1).");
  }

  if (options.json) {
    console.log("");
    console.log(JSON.stringify({ baseUrl: settings.baseUrl, model: settings.model, textOk, toolsOk, jsonOk, results }, null, 2));
  }

  process.exit(textOk ? 0 : 1);
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exit(1);
});
