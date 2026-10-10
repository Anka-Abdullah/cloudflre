/**
 * Loads the prompt and the knowledge for one number.
 *
 * Storage follows work plan Q8: KV first (small knowledge, one cheap GET), R2 as
 * the fallback and as the home of anything larger. Both use the same object keys
 * (`knowledge/prompt.txt`, `knowledge/knowledge.txt`), so `pnpm run knowledge`
 * can write to either and the loader does not care which one answered.
 *
 * Two details that matter in production:
 *
 *  - **Isolate cache.** Every inbound message would otherwise re-read the whole
 *    knowledge from KV, which is both slow and billed per operation. The bundle
 *    is cached in the isolate for a short TTL; the admin sync calls
 *    `invalidateKnowledgeCache()` so a change is visible immediately.
 *  - **Never throw.** A missing or unreadable knowledge file is a configuration
 *    state, not a crash: the pipeline answers with the built-in prompt instead,
 *    which is far better than dropping the customer's message.
 */
import type { Env, InstanceConfig, KnowledgeMode } from "../../config";
import { createLogger, type Logger } from "../../lib/logger";

/** Object keys shared by the KV namespace and the R2 bucket. */
export const KNOWLEDGE_KEYS = {
  prompt: "knowledge/prompt.txt",
  knowledge: "knowledge/knowledge.txt",
  /** Ongkir policy JSON (FASE 3, step 1). */
  ongkirPolicy: "knowledge/ongkir-policy.json",
} as const;

export type KnowledgeSource = "kv" | "r2";

export interface KnowledgeBundle {
  prompt: string;
  knowledge: string;
  /** Which backend answered. */
  source: KnowledgeSource;
  /** Combined size of both files, the input to `resolveKnowledgeMode`. */
  bytes: number;
  /** Resolved storage mode for retrieval. */
  mode: "kv_inline" | "r2_d1_fts";
  /** Individual file sizes, for /healthz and logs. */
  sizes: { prompt: number; knowledge: number };
}

export interface LoadKnowledgeOptions {
  env: Pick<Env, "KNOWLEDGE_KV" | "MEDIA">;
  config: InstanceConfig;
  log?: Logger;
  /** Test seam for the cache. */
  useCache?: boolean;
}

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  key: string;
  at: number;
  bundle: KnowledgeBundle | null;
}

let cache: CacheEntry | null = null;

/** Called by the admin sync so the next message sees the new knowledge. */
export function invalidateKnowledgeCache(): void {
  cache = null;
}

/**
 * Turns KNOWLEDGE_MODE into the mode actually used for this bundle.
 *
 * `auto` keeps the common case cheap: knowledge that fits in KV is scored in
 * memory, and only a bundle larger than KNOWLEDGE_INLINE_MAX_BYTES goes to R2 +
 * D1 FTS5 (whose virtual table the sync creates lazily, because not every D1
 * account is guaranteed to have FTS5 — see risk R3).
 */
export function resolveKnowledgeMode(
  configured: KnowledgeMode,
  bytes: number,
  inlineMaxBytes: number,
): "kv_inline" | "r2_d1_fts" {
  if (configured === "kv_inline") return "kv_inline";
  if (configured === "r2_d1_fts") return "r2_d1_fts";
  return bytes <= inlineMaxBytes ? "kv_inline" : "r2_d1_fts";
}

async function readText(
  env: Pick<Env, "KNOWLEDGE_KV" | "MEDIA">,
  key: string,
): Promise<{ text: string; source: KnowledgeSource } | null> {
  if (env.KNOWLEDGE_KV) {
    try {
      const value = await env.KNOWLEDGE_KV.get(key, "text");
      if (typeof value === "string" && value !== "") return { text: value, source: "kv" };
    } catch {
      // Fall through to R2: a KV outage must not take the bot down.
    }
  }
  if (env.MEDIA) {
    try {
      const object = await env.MEDIA.get(key);
      if (object) {
        const text = await object.text();
        if (text !== "") return { text, source: "r2" };
      }
    } catch {
      // Treated as "not configured" by the caller.
    }
  }
  return null;
}

/** Reads the ongkir policy JSON; returns null when absent or malformed. */
export async function loadOngkirPolicy(
  env: Pick<Env, "KNOWLEDGE_KV" | "MEDIA">,
  log?: Logger,
): Promise<unknown | null> {
  const found = await readText(env, KNOWLEDGE_KEYS.ongkirPolicy);
  if (!found) return null;
  try {
    return JSON.parse(found.text) as unknown;
  } catch (error) {
    log?.error("ongkir_policy_unreadable", { error: String(error) });
    return null;
  }
}

export async function loadKnowledge(options: LoadKnowledgeOptions): Promise<KnowledgeBundle | null> {
  const { env, config } = options;
  const log = options.log ?? createLogger({ slug: config.slug, handler: "knowledge" });
  const useCache = options.useCache ?? true;
  const cacheKey = `${config.slug}:${config.bot.knowledgeMode}:${config.bot.knowledgeInlineMaxBytes}`;

  if (useCache && cache && cache.key === cacheKey && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.bundle;
  }

  const [prompt, knowledge] = await Promise.all([
    readText(env, KNOWLEDGE_KEYS.prompt),
    readText(env, KNOWLEDGE_KEYS.knowledge),
  ]);

  let bundle: KnowledgeBundle | null = null;
  if (prompt || knowledge) {
    const promptText = prompt?.text ?? "";
    const knowledgeText = knowledge?.text ?? "";
    const bytes = promptText.length + knowledgeText.length;
    bundle = {
      prompt: promptText,
      knowledge: knowledgeText,
      // Prefer whichever backend answered; R2 only wins when KV had nothing.
      source: prompt?.source === "r2" || knowledge?.source === "r2" ? "r2" : "kv",
      bytes,
      mode: resolveKnowledgeMode(config.bot.knowledgeMode, bytes, config.bot.knowledgeInlineMaxBytes),
      sizes: { prompt: promptText.length, knowledge: knowledgeText.length },
    };
    log.info("knowledge_loaded", {
      source: bundle.source,
      mode: bundle.mode,
      promptBytes: bundle.sizes.prompt,
      knowledgeBytes: bundle.sizes.knowledge,
    });
  } else {
    log.warn("knowledge_missing", {
      hint: "upload with: pnpm run knowledge -- --number <nomor>",
      keys: [KNOWLEDGE_KEYS.prompt, KNOWLEDGE_KEYS.knowledge],
    });
  }

  if (useCache) cache = { key: cacheKey, at: Date.now(), bundle };
  return bundle;
}
