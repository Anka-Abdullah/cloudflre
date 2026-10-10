/**
 * Knowledge retrieval for the agent.
 *
 * Two modes, chosen by `resolveKnowledgeMode` (work plan Q8):
 *
 *   kv_inline   The whole knowledge fits in memory, so chunks are scored in the
 *               isolate. Cheap, no D1 round-trip, and correct for the current
 *               catalogue (73 KB total, well under the 1 MB threshold).
 *   r2_d1_fts   D1 FTS5 + bm25. Used once the knowledge outgrows the threshold.
 *
 * The two modes share the tokeniser and the chunker, so a query behaves the same
 * way in both and switching mode does not silently change the answers.
 *
 * The D1 path is written defensively on purpose. FTS5 is available on D1 today
 * (proven in shared/test/d1.test.ts), but the work plan's risk R3 is "a D1
 * account without FTS5", and an agent that throws because a virtual table is
 * missing would take the whole bot down. If the FTS query fails for any reason,
 * retrieval degrades to in-memory scoring and says so via `fallback: true`.
 */
import type { Env, InstanceConfig } from "../../config";
import { createLogger, type Logger } from "../../lib/logger";
import { chunkText, type Chunk } from "./chunker";
import type { KnowledgeBundle } from "./loader";

export interface KnowledgeHit {
  content: string;
  /** Higher is better in `kv_inline`; in `r2_d1_fts` this is the raw bm25 value. */
  score: number;
  source: string;
  ordinal: number;
}

export interface RetrievalResult {
  hits: KnowledgeHit[];
  mode: "kv_inline" | "r2_d1_fts";
  /** True when the configured mode was unavailable and another one was used. */
  fallback: boolean;
  /** Instruction handed to the model when nothing matched. */
  intro: string;
}

/**
 * Used when retrieval finds nothing. Saying so explicitly is what keeps the model
 * from inventing a product: an empty context looks the same as "no rules".
 */
export const NO_CONTEXT_INTRO =
  "Tidak ada potongan katalog yang cocok dengan pertanyaan ini. Jawab hanya berdasarkan aturan di system prompt; " +
  "jangan mengarang nama produk, harga, atau ketersediaan. Bila perlu, tawarkan bantuan admin.";

/** Indonesian and English filler that would otherwise match everything. */
const STOPWORDS = new Set([
  "dan", "atau", "yang", "untuk", "dengan", "dari", "pada", "ini", "itu", "ada", "apa", "apakah",
  "saya", "aku", "kak", "mas", "mbak", "bang", "nya", "kah", "lah", "juga", "bisa", "tidak",
  "gak", "ga", "nggak", "mau", "ingin", "tolong", "minta", "berapa", "di", "ke", "dong", "ya",
  "the", "and", "for", "you", "are", "with", "this", "that", "what", "how", "can", "please",
]);
// Deliberately NOT stopwords: "harga", "ongkir", "stok", "ukuran". They are common
// in a sales chat, but they are also exactly the words that locate a price,
// shipping or stock line — dropping them would make the most frequent customer
// questions unanswerable. Their idf weighting already keeps them from dominating.

/**
 * Query → search terms. Terms shorter than 3 characters are dropped (they match
 * noise), as are stopwords, but `harga` is kept even though it is common: it is
 * exactly the word that finds a price block.
 */
export function tokenize(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of query.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    terms.push(raw);
  }
  return terms;
}

/**
 * Scores one chunk against the query terms.
 *
 * Rarer terms weigh more (idf), and an exact phrase hit is worth more than the
 * same words scattered, because "castelli entrata" as a phrase is a product name
 * rather than two unrelated words. The result is divided by the square root of
 * the chunk length so that a long chunk does not win merely by containing more.
 */
export function scoreChunk(content: string, terms: readonly string[], documentFrequency: Map<string, number>, total: number): number {
  const haystack = content.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const occurrences = haystack.split(term).length - 1;
    if (occurrences === 0) continue;
    const df = documentFrequency.get(term) ?? 0;
    const idf = Math.log(1 + total / (1 + df));
    score += occurrences * (1 + idf);
  }
  if (score === 0) return 0;
  if (terms.length > 1 && haystack.includes(terms.join(" "))) score += 3;
  return score / Math.sqrt(Math.max(1, content.length));
}

interface ChunkCacheEntry {
  fingerprint: string;
  chunks: Chunk[];
}

let chunkCache: ChunkCacheEntry | null = null;

/** Chunks the bundle once per distinct knowledge text. */
export function chunksFor(bundle: KnowledgeBundle | null, source = "knowledge.txt"): Chunk[] {
  if (!bundle || bundle.knowledge === "") return [];
  const fingerprint = `${source}:${bundle.knowledge.length}:${bundle.sizes.knowledge}`;
  if (chunkCache && chunkCache.fingerprint === fingerprint) return chunkCache.chunks;
  const chunks = chunkText(bundle.knowledge, { source });
  chunkCache = { fingerprint, chunks };
  return chunks;
}

/** Test seam: forget the chunk cache. */
export function invalidateChunkCache(): void {
  chunkCache = null;
}

/**
 * Creates the FTS5 objects if they are missing.
 *
 * Called by the knowledge sync (authoritative) and defensively by the D1 search
 * path, so a number that never ran the sync still gets working retrieval. The
 * table is external-content over `knowledge_chunks`, which is what lets one
 * chunk written by the sync be ranked by bm25 without a second copy of the text.
 */
export async function ensureFtsSchema(db: D1Database): Promise<void> {
  await db.prepare(
    `CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
       content,
       content='knowledge_chunks',
       content_rowid='id',
       tokenize='unicode61 remove_diacritics 2'
     )`,
  ).run();
  await db.prepare(
    `CREATE TRIGGER IF NOT EXISTS knowledge_chunks_ai AFTER INSERT ON knowledge_chunks BEGIN
       INSERT INTO knowledge_fts(rowid, content) VALUES (new.id, new.content);
     END`,
  ).run();
  await db.prepare(
    `CREATE TRIGGER IF NOT EXISTS knowledge_chunks_ad AFTER DELETE ON knowledge_chunks BEGIN
       INSERT INTO knowledge_fts(knowledge_fts, rowid, content) VALUES('delete', old.id, old.content);
     END`,
  ).run();
  await db.prepare(
    `CREATE TRIGGER IF NOT EXISTS knowledge_chunks_au AFTER UPDATE ON knowledge_chunks BEGIN
       INSERT INTO knowledge_fts(knowledge_fts, rowid, content) VALUES('delete', old.id, old.content);
       INSERT INTO knowledge_fts(rowid, content) VALUES (new.id, new.content);
     END`,
  ).run();
}

/**
 * Builds the FTS5 MATCH expression.
 *
 * Every term is quoted, so a customer typing `NEAR(`, `*` or `"` cannot turn into
 * FTS5 syntax and error the query — which, before this guard, would have been a
 * user-triggerable outage on the retrieval path.
 */
export function buildMatchQuery(terms: readonly string[]): string {
  const safe = terms
    .map((term) => term.replace(/["*^:(){}[\]]/g, "").trim())
    .filter((term) => term !== "")
    .map((term) => `"${term}"`);
  return safe.join(" OR ");
}

/** In-memory scoring over already-chunked knowledge. */
export function searchInMemory(chunks: readonly Chunk[], query: string, topK: number): KnowledgeHit[] {
  const terms = tokenize(query);
  if (terms.length === 0 || chunks.length === 0) return [];

  const documentFrequency = new Map<string, number>();
  for (const term of terms) {
    let df = 0;
    for (const chunk of chunks) if (chunk.content.toLowerCase().includes(term)) df += 1;
    documentFrequency.set(term, df);
  }

  return chunks
    .map((chunk) => ({
      content: chunk.content,
      score: scoreChunk(chunk.content, terms, documentFrequency, chunks.length),
      source: chunk.source,
      ordinal: chunk.ordinal,
    }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

async function searchFts(db: D1Database, query: string, topK: number): Promise<KnowledgeHit[]> {
  const match = buildMatchQuery(tokenize(query));
  if (match === "") return [];

  const rows = await db
    .prepare(
      `SELECT k.content AS content, k.source AS source, k.ordinal AS ordinal, bm25(knowledge_fts) AS score
         FROM knowledge_fts
         JOIN knowledge_chunks k ON k.id = knowledge_fts.rowid
        WHERE knowledge_fts MATCH ?
        ORDER BY score
        LIMIT ?`,
    )
    .bind(match, topK)
    .all<{ content: string; source: string; ordinal: number; score: number }>();

  return rows.results.map((row) => ({
    content: row.content,
    score: row.score,
    source: row.source,
    ordinal: row.ordinal,
  }));
}

export interface RetrieveOptions {
  env: Pick<Env, "BOT_DB" | "KNOWLEDGE_KV" | "MEDIA">;
  config: InstanceConfig;
  bundle: KnowledgeBundle | null;
  query: string;
  log?: Logger;
}

/**
 * Retrieves the top-K knowledge chunks for one customer message.
 *
 * Never throws: a retrieval failure returns no hits plus `NO_CONTEXT_INTRO`, which
 * makes the model answer conservatively instead of confidently.
 */
export async function retrieve(options: RetrieveOptions): Promise<RetrievalResult> {
  const { env, config, bundle, query } = options;
  const log = options.log ?? createLogger({ slug: config.slug, handler: "knowledge" });
  const topK = config.bot.knowledgeTopK;
  const mode = bundle?.mode ?? "kv_inline";
  const chunks = chunksFor(bundle);

  if (query.trim() === "" || chunks.length === 0) {
    return { hits: [], mode, fallback: false, intro: NO_CONTEXT_INTRO };
  }

  if (mode === "r2_d1_fts" && env.BOT_DB) {
    try {
      await ensureFtsSchema(env.BOT_DB);
      const hits = await searchFts(env.BOT_DB, query, topK);
      log.info("knowledge_search", { mode, hits: hits.length, terms: tokenize(query).length });
      if (hits.length === 0) {
        // FTS found nothing: fall back to in-memory scoring so a chunk the
        // tokenizer split differently still has a chance to match.
        const relaxed = searchInMemory(chunks, query, topK);
        return { hits: relaxed, mode, fallback: relaxed.length > 0, intro: relaxed.length > 0 ? "" : NO_CONTEXT_INTRO };
      }
      return { hits, mode, fallback: false, intro: "" };
    } catch (error) {
      log.error("knowledge_fts_failed", { error: String(error), hint: "falling back to kv_inline scoring" });
      const hits = searchInMemory(chunks, query, topK);
      return { hits, mode: "kv_inline", fallback: true, intro: hits.length > 0 ? "" : NO_CONTEXT_INTRO };
    }
  }

  const hits = searchInMemory(chunks, query, topK);
  log.info("knowledge_search", { mode: "kv_inline", hits: hits.length, terms: tokenize(query).length });
  return { hits, mode: "kv_inline", fallback: false, intro: hits.length > 0 ? "" : NO_CONTEXT_INTRO };
}
