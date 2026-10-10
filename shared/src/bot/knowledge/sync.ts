/**
 * Knowledge sync: writes prompt/knowledge into KV or R2 and (re)builds the D1
 * projections (`knowledge_chunks` + FTS5, `catalog_products`).
 *
 * This is the code `pnpm run knowledge` drives. It lives in the Worker rather
 * than in the Node script on purpose:
 *
 *  - the chunker, the catalogue parser and the FTS5 triggers are the same code
 *    the agent uses at runtime, so a sync can never produce chunks the retrieval
 *    path does not understand;
 *  - `wrangler kv key put` / `wrangler r2 object put` move the bytes, and the
 *    Worker (via `POST /admin/knowledge/sync`) owns the derived index, which is
 *    the only part that is expensive to get wrong.
 *
 * Storage target follows `resolveKnowledgeMode`: small bundles live in KV
 * (one cheap GET per message), larger ones in R2 with the D1 FTS index. The
 * loader reads KV first and R2 second, so writing to the resolved target is
 * enough — no copy is kept in both places.
 */
import type { Env, InstanceConfig, KnowledgeMode } from "../../config";
import type { Logger } from "../../lib/logger";
import { parseCatalog, resolveCatalog, type OngkirPolicy } from "./catalog";
import { chunkText } from "./chunker";
import { KNOWLEDGE_KEYS, resolveKnowledgeMode } from "./loader";
import { ensureFtsSchema } from "./search";

export interface KnowledgeStorageInput {
  prompt?: string;
  knowledge?: string;
  /** Overrides the ongkir policy object; `null` clears nothing, it is simply not written. */
  ongkirPolicy?: unknown;
}

export interface KnowledgeStorageResult {
  target: "kv" | "r2";
  mode: "kv_inline" | "r2_d1_fts";
  written: string[];
  bytes: { prompt: number; knowledge: number };
  /** Names the deployment lacks; the sync reports them instead of throwing. */
  skipped: string[];
}

/**
 * Chooses where the bundle goes.
 *
 * `auto` follows the loader's rule exactly (`resolveKnowledgeMode`), so the sync
 * and the reader never disagree about which backend is authoritative.
 */
export function storageTarget(
  mode: KnowledgeMode,
  bytes: number,
  inlineMaxBytes: number,
): { target: "kv" | "r2"; mode: "kv_inline" | "r2_d1_fts" } {
  const resolved = resolveKnowledgeMode(mode, bytes, inlineMaxBytes);
  return { target: resolved === "kv_inline" ? "kv" : "r2", mode: resolved };
}

export async function writeKnowledgeStorage(
  env: Pick<Env, "KNOWLEDGE_KV" | "MEDIA">,
  config: InstanceConfig,
  input: KnowledgeStorageInput,
): Promise<KnowledgeStorageResult> {
  const prompt = input.prompt ?? "";
  const knowledge = input.knowledge ?? "";
  const bytes = { prompt: prompt.length, knowledge: knowledge.length };
  const { target, mode } = storageTarget(
    config.bot.knowledgeMode,
    bytes.prompt + bytes.knowledge,
    config.bot.knowledgeInlineMaxBytes,
  );

  const written: string[] = [];
  const skipped: string[] = [];
  const objects: Array<[string, string]> = [];
  if (input.prompt !== undefined) objects.push([KNOWLEDGE_KEYS.prompt, prompt]);
  if (input.knowledge !== undefined) objects.push([KNOWLEDGE_KEYS.knowledge, knowledge]);
  if (input.ongkirPolicy !== undefined) {
    objects.push([KNOWLEDGE_KEYS.ongkirPolicy, JSON.stringify(input.ongkirPolicy, null, 2)]);
  }

  /** Keys the other backend may be holding a stale copy of. */
  const mirrored = [KNOWLEDGE_KEYS.prompt, KNOWLEDGE_KEYS.knowledge];

  if (target === "kv") {
    if (!env.KNOWLEDGE_KV) {
      skipped.push("KNOWLEDGE_KV");
    } else {
      for (const [key, value] of objects) {
        await env.KNOWLEDGE_KV.put(key, value);
        written.push(key);
      }
    }
  } else {
    if (!env.MEDIA) {
      skipped.push("MEDIA");
    } else {
      for (const [key, value] of objects) {
        await env.MEDIA.put(key, value, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
        written.push(key);
      }
    }
    // A bundle that outgrew KV must not leave a stale copy behind: the loader
    // reads KV first, so an old, small copy would silently win over the new R2
    // one after the knowledge grew past the inline threshold.
    if (env.KNOWLEDGE_KV) {
      for (const key of mirrored) {
        if (written.includes(key)) continue;
        try {
          await env.KNOWLEDGE_KV.delete(key);
        } catch {
          // A failed delete is not fatal: the mode is recorded in the bundle's
          // size, and the next sync retries the cleanup.
        }
      }
    }
  }

  return { target, mode, written, bytes, skipped };
}

export interface SyncIndexOptions {
  /** Label stored with every chunk; defaults to `knowledge.txt`. */
  source?: string;
  /** Resolved ongkir policy (from `loadOngkirPolicy`) used for `catalog_products`. */
  policy?: OngkirPolicy | null;
  /** Epoch ms written to `updated_at`. */
  at?: number;
  log?: Logger;
}

export interface SyncIndexResult {
  source: string;
  chunks: number;
  catalogProducts: number;
  fts: boolean;
}

/**
 * Rebuilds `knowledge_chunks` (and therefore FTS5) and `catalog_products` from
 * one knowledge text.
 *
 * The delete-then-insert pair is deliberate: chunk ordinals shift when a product
 * is inserted in the middle of the export, so an upsert by ordinal would leave
 * orphaned chunks behind and retrieval would quote a product that no longer
 * exists. FTS5 is external-content over `knowledge_chunks`, so the delete
 * triggers keep the index in step without a second copy of the text.
 */
export async function syncKnowledgeIndex(
  db: D1Database,
  knowledge: string,
  options: SyncIndexOptions = {},
): Promise<SyncIndexResult> {
  const source = options.source ?? "knowledge.txt";
  const at = options.at ?? Date.now();
  const chunks = chunkText(knowledge, { source });

  let fts = false;
  try {
    await ensureFtsSchema(db);
    fts = true;
  } catch (error) {
    // FTS5 is available on D1 today, but the work plan keeps an escape hatch for
    // an account without it: the chunks are still written, retrieval degrades to
    // in-memory scoring, and the caller sees `fts: false`.
    options.log?.error("knowledge_fts_unavailable", { error: String(error) });
  }

  await db.prepare("DELETE FROM knowledge_chunks WHERE source = ?").bind(source).run();

  const batchSize = 40;
  for (let i = 0; i < chunks.length; i += batchSize) {
    const slice = chunks.slice(i, i + batchSize);
    await db.batch(
      slice.map((chunk) =>
        db
          .prepare(
            `INSERT OR REPLACE INTO knowledge_chunks (source, ordinal, content, hash, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(chunk.source, chunk.ordinal, chunk.content, chunk.hash, at),
      ),
    );
  }

  const { products } = parseCatalog(knowledge);
  const resolved = resolveCatalog(products, options.policy ?? null);
  if (resolved.length > 0) {
    await db.batch(
      resolved.map((product) =>
        db
          .prepare(
            `INSERT INTO catalog_products (kode, nama, harga, ongkir_known, ongkir_included, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (kode) DO UPDATE SET
               nama = excluded.nama,
               harga = excluded.harga,
               ongkir_known = excluded.ongkir_known,
               ongkir_included = excluded.ongkir_included,
               updated_at = excluded.updated_at`,
          )
          .bind(
            product.kode,
            product.nama,
            product.harga,
            product.ongkirKnown ? 1 : 0,
            product.ongkirIncluded ? 1 : 0,
            at,
          ),
      ),
    );
  }

  return { source, chunks: chunks.length, catalogProducts: resolved.length, fts };
}

/** Reads one stored object, preferring KV exactly like `loadKnowledge` does. */
export async function readStored(
  env: Pick<Env, "KNOWLEDGE_KV" | "MEDIA">,
  key: string,
): Promise<{ text: string; source: "kv" | "r2" } | null> {
  if (env.KNOWLEDGE_KV) {
    try {
      const value = await env.KNOWLEDGE_KV.get(key, "text");
      if (typeof value === "string" && value !== "") return { text: value, source: "kv" };
    } catch {
      // Fall through to R2.
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
      // Reported as "missing" by the caller.
    }
  }
  return null;
}
