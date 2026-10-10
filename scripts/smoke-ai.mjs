#!/usr/bin/env node
/**
 * FASE 0/3 smoke test for the OpenAI-compatible endpoint.
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
 * Findings that shaped this script (work order FASE 3, step 2):
 *
 *   * `max_tokens: 128` (and especially 32) is too small for this model: it is a
 *     reasoning model, so it spends the budget before it emits anything, the
 *     response comes back with `finish_reason: "length"` and empty content, and
 *     the model looks incapable when it was only truncated. Each probe now gets a
 *     realistic budget (64 / 2048 / 1024), and a truncated empty answer is retried
 *     once with double the budget before it is called a failure.
 *   * This model also returns `reasoning_content` next to `content`. It is not
 *     part of the answer and must never reach the customer; the script reports
 *     that it was seen and ignored, and the agent ignores it too.
 *   * `tool_calls` can arrive with `content: null`, so capability is judged on
 *     `tool_calls`, never on `content`.
 *
 * The API key is read from (in order) `--api-key`, `$AI_API_KEY`,
 * `cloudflare/.dev.vars`, then `<nomor>/.dev.vars`. The order matters: the
 * per-number file holds a placeholder (`dev-ai-key-change-me`) that must never
 * shadow a real key in the root file, so placeholder-looking values are skipped
 * outright. The key is never printed, logged, or written anywhere.
 *
 * Exit code: 0 = dialogue works (with or without native tools), 1 = dialogue
 * failed, 2 = no API key found.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cloudflareRoot } from "./lib.mjs";

const DEFAULTS = {
  baseUrl: "https://sejahteraselamanya.my.id/v1",
  model: "cmc/deepseek/deepseek-v4.1-flash",
  timeoutMs: 60_000,
};

/** Per-probe budgets. A reasoning model needs room before it answers. */
const MAX_TOKENS = { text: 64, tools: 2048, json: 1024 };

/** Values that are obviously not a real key, whatever file they came from. */
const PLACEHOLDER = /^(dev-|test-|your-|xxx|changeme|placeholder)|change[-_]?me|example\.com/i;

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
            "The key is read from --api-key, then $AI_API_KEY, then cloudflare/.dev.vars,",
            "then <number>/.dev.vars. Placeholder values (dev-…, change-me) are skipped.",
            "Nothing is written to disk.",
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

function looksLikePlaceholder(value) {
  return value === "" || PLACEHOLDER.test(value);
}

async function resolveSettings(options) {
  // Root file before the per-number file: the per-number file carries a
  // placeholder in this repo, and a placeholder must never shadow a real key.
  const candidates = [
    options.envFile,
    join(cloudflareRoot, ".dev.vars"),
    options.number ? join(cloudflareRoot, options.number, ".dev.vars") : null,
  ].filter((candidate) => typeof candidate === "string");

  let fileKey = null;
  let keySource = null;
  let placeholderSeenAt = null;
  let fileValues = {};

  for (const candidate of candidates) {
    const values = await readEnvFile(candidate);
    if (!values) continue;
    if (Object.keys(fileValues).length === 0) fileValues = values;
    const value = values["AI_API_KEY"];
    if (typeof value !== "string" || value === "") continue;
    if (looksLikePlaceholder(value)) {
      placeholderSeenAt ??= candidate;
      continue;
    }
    if (fileKey === null) {
      fileKey = value;
      keySource = candidate;
    }
  }

  const envKey = process.env["AI_API_KEY"];
  const envKeyUsable = typeof envKey === "string" && !looksLikePlaceholder(envKey);
  if (typeof envKey === "string" && !envKeyUsable) placeholderSeenAt ??= "$AI_API_KEY";

  const apiKey = options.apiKey ?? (envKeyUsable ? envKey : null) ?? fileKey;
  const source = options.apiKey !== null ? "--api-key" : envKeyUsable ? "$AI_API_KEY" : keySource;

  return {
    baseUrl: (options.baseUrl ?? process.env["AI_BASE_URL"] ?? fileValues["AI_BASE_URL"] ?? DEFAULTS.baseUrl).replace(/\/+$/, ""),
    model: options.model ?? process.env["AI_MODEL"] ?? fileValues["AI_MODEL"] ?? DEFAULTS.model,
    apiKey,
    timeoutMs: options.timeoutMs,
    keySource: source,
    placeholderSeenAt,
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

function messageOf(parsed) {
  const message = parsed?.choices?.[0]?.message;
  return typeof message === "object" && message !== null ? message : null;
}

function contentOf(parsed) {
  const content = messageOf(parsed)?.content;
  return typeof content === "string" ? content : "";
}

/** This model's private scratchpad. Never the answer, never sent to a customer. */
function reasoningOf(parsed) {
  const reasoning = messageOf(parsed)?.reasoning_content;
  return typeof reasoning === "string" ? reasoning : "";
}

function toolCallsOf(parsed) {
  const calls = messageOf(parsed)?.tool_calls;
  return Array.isArray(calls) ? calls : [];
}

function finishReasonOf(parsed) {
  const reason = parsed?.choices?.[0]?.finish_reason;
  return typeof reason === "string" ? reason : "";
}

function errorText(result) {
  const error = result.parsed?.error;
  if (typeof error === "string") return error.slice(0, 300);
  if (error) return JSON.stringify(error).slice(0, 300);
  return result.text.slice(0, 300);
}

/**
 * Sends one probe and retries once with double the budget when the model was cut
 * off before producing anything usable. A truncated answer is an inconclusive
 * run, not a missing capability — reporting it as "the model cannot do tools"
 * would push the project onto the JSON-mode path for no reason.
 */
async function probe(settings, body, maxTokens, isUsable) {
  const first = await chatCompletion(settings, { ...body, max_tokens: maxTokens });
  if (!first.ok || finishReasonOf(first.parsed) !== "length" || isUsable(first.parsed)) {
    return { result: first, retried: false, budget: maxTokens, truncated: false };
  }

  const budget = maxTokens * 2;
  const second = await chatCompletion(settings, { ...body, max_tokens: budget });
  return {
    result: second,
    retried: true,
    budget,
    truncated: finishReasonOf(second.parsed) === "length" && !isUsable(second.parsed),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const settings = await resolveSettings(options);

  console.log("AI smoke test (FASE 3)");
  console.log(`  base URL : ${settings.baseUrl}`);
  console.log(`  model    : ${settings.model}`);
  console.log(`  key      : ${settings.apiKey ? `present (${settings.keySource})` : "MISSING"}`);
  console.log(`  budget   : text ${MAX_TOKENS.text} · tools ${MAX_TOKENS.tools} · json ${MAX_TOKENS.json}`);
  console.log("");

  if (!settings.apiKey) {
    console.error("error: no AI API key found.");
    if (settings.placeholderSeenAt) {
      console.error(`  a placeholder value at ${settings.placeholderSeenAt} was ignored.`);
    }
    console.error("  export AI_API_KEY=…            or  pnpm run smoke:ai -- --api-key …");
    console.error("  (production value: pnpm run secrets -- --number <nomor> --from-env)");
    process.exit(2);
  }

  const results = [];
  let reasoningSeen = false;
  const record = (name, verdict, detail) => {
    results.push({ name, verdict, detail });
    const mark = verdict === "pass" ? "PASS" : verdict === "warn" ? "WARN" : "FAIL";
    console.log(`[${mark}] ${name}: ${detail}`);
  };

  // 1. plain dialogue ------------------------------------------------------
  let textOk = false;
  try {
    const { result, retried, budget, truncated } = await probe(
      settings,
      {
        messages: [
          { role: "system", content: "Jawab sangat singkat." },
          { role: "user", content: "Balas hanya dengan kata: SIAP" },
        ],
        temperature: 0,
      },
      MAX_TOKENS.text,
      (parsed) => contentOf(parsed).trim() !== "",
    );
    if (reasoningOf(result.parsed).length > 0) reasoningSeen = true;
    if (!result.ok) {
      record("text", "fail", `HTTP ${result.status} — ${errorText(result)}`);
    } else {
      const content = contentOf(result.parsed).trim();
      textOk = content !== "";
      const note = retried ? ` (retry naik ke ${budget} token${truncated ? ", masih terpotong" : ""})` : "";
      record(
        "text",
        textOk ? "pass" : "fail",
        textOk ? `"${content.slice(0, 60)}" in ${result.elapsedMs} ms${note}` : `content kosong pada ${budget} token${note}`,
      );
    }
  } catch (error) {
    record("text", "fail", String(error.message ?? error));
  }

  // 2. native function calling --------------------------------------------
  let toolsOk = false;
  try {
    const { result, retried, budget } = await probe(
      settings,
      {
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
        temperature: 0,
      },
      MAX_TOKENS.tools,
      // Judged on tool_calls, because content is legitimately null here.
      (parsed) => toolCallsOf(parsed).length > 0,
    );
    if (reasoningOf(result.parsed).length > 0) reasoningSeen = true;

    if (!result.ok) {
      record("function calling", "warn", `HTTP ${result.status} — ${errorText(result)}`);
    } else {
      const calls = toolCallsOf(result.parsed);
      toolsOk = calls.length > 0;
      const note = retried ? ` (retry naik ke ${budget} token)` : "";
      record(
        "function calling",
        toolsOk ? "pass" : "warn",
        toolsOk
          ? `${calls.map((call) => call?.function?.name ?? "?").join(", ")} in ${result.elapsedMs} ms${note}`
          : `tidak ada tool_calls; model menjawab teks — aktifkan fallback JSON mode${note}`,
      );
    }
  } catch (error) {
    record("function calling", "warn", String(error.message ?? error));
  }

  // 3. JSON mode -----------------------------------------------------------
  let jsonOk = false;
  try {
    const { result, retried, budget } = await probe(
      settings,
      {
        messages: [
          { role: "system", content: 'Balas hanya dengan JSON: {"intent":"...","kode":"..."}' },
          { role: "user", content: "Saya mau beli kaos polos 2 pcs" },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
      },
      MAX_TOKENS.json,
      (parsed) => {
        try {
          return typeof JSON.parse(contentOf(parsed).trim()) === "object";
        } catch {
          return false;
        }
      },
    );
    if (reasoningOf(result.parsed).length > 0) reasoningSeen = true;

    if (!result.ok) {
      record("JSON mode", "warn", `HTTP ${result.status} — ${errorText(result)}`);
    } else {
      const content = contentOf(result.parsed).trim();
      const note = retried ? ` (retry naik ke ${budget} token)` : "";
      try {
        const parsed = JSON.parse(content);
        jsonOk = typeof parsed === "object" && parsed !== null;
        record("JSON mode", jsonOk ? "pass" : "warn", jsonOk ? `parsed ${Object.keys(parsed).join(", ")}${note}` : `bukan objek${note}`);
      } catch {
        record("JSON mode", "warn", `content bukan JSON: ${content.slice(0, 120)}${note}`);
      }
    }
  } catch (error) {
    record("JSON mode", "warn", String(error.message ?? error));
  }

  console.log("");
  if (reasoningSeen) {
    console.log("catatan: model mengirim reasoning_content; nilai itu DIABAIKAN dan tidak");
    console.log("        pernah dikirim ke customer (agent/llm.ts membuangnya).");
    console.log("");
  }
  console.log("verdict:");
  console.log(`  dialogue         : ${textOk ? "OK" : "FAILED"}`);
  console.log(`  native tool call : ${toolsOk ? "OK — pakai native tool calling" : "NOT AVAILABLE — pakai JSON mode + parser internal"}`);
  console.log(`  JSON mode        : ${jsonOk ? "OK" : "NOT AVAILABLE — parse free text defensively"}`);
  console.log("");
  if (!textOk) {
    console.log("config: perbaiki endpoint/key dulu — belum ada kapabilitas yang terukur.");
  } else if (toolsOk) {
    console.log("config: AI_TOOLS_MODE=native, AI_JSON_FALLBACK=true (cadangan), AI_MAX_TOKENS=2048.");
  } else {
    console.log("config: AI_TOOLS_MODE=json — agent wajib memakai fallback JSON mode (R1).");
  }

  if (options.json) {
    console.log("");
    console.log(
      JSON.stringify(
        { baseUrl: settings.baseUrl, model: settings.model, textOk, toolsOk, jsonOk, reasoningSeen, results },
        null,
        2,
      ),
    );
  }

  process.exit(textOk ? 0 : 1);
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exit(1);
});
