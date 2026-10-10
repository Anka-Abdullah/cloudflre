/**
 * Knowledge loader / chunker / retrieval tests (work order FASE 3, step 3).
 *
 * The D1 FTS5 cases run against the real BOT_DB binding with the real FTS5
 * virtual table, because "bm25 ranks the right chunk" is exactly the kind of
 * claim that a mock would happily confirm and production would not.
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Env } from "../src/config";
import { chunkText, contentHash, DEFAULT_CHUNK_SIZE, type Chunk } from "../src/bot/knowledge/chunker";
import {
  KNOWLEDGE_KEYS,
  invalidateKnowledgeCache,
  loadKnowledge,
  loadOngkirPolicy,
  resolveKnowledgeMode,
} from "../src/bot/knowledge/loader";
import {
  NO_CONTEXT_INTRO,
  buildMatchQuery,
  chunksFor,
  ensureFtsSchema,
  invalidateChunkCache,
  retrieve,
  scoreChunk,
  searchInMemory,
  tokenize,
} from "../src/bot/knowledge/search";

const bindings = env as unknown as {
  BOT_DB: D1Database;
  KNOWLEDGE_KV: KVNamespace;
  MEDIA: R2Bucket;
};
const db = bindings.BOT_DB;
const config = loadConfig(env as unknown as Env);

beforeEach(async () => {
  invalidateKnowledgeCache();
  invalidateChunkCache();
  await db.batch([
    db.prepare("DELETE FROM knowledge_chunks"),
    db.prepare("DROP TRIGGER IF EXISTS knowledge_chunks_ai"),
    db.prepare("DROP TRIGGER IF EXISTS knowledge_chunks_ad"),
    db.prepare("DROP TRIGGER IF EXISTS knowledge_chunks_au"),
    db.prepare("DROP TABLE IF EXISTS knowledge_fts"),
  ]);
  // KV and R2 are real too; clear every key this file writes, or a later test
  // sees the previous test's knowledge and its "nothing uploaded" case fails.
  await bindings.KNOWLEDGE_KV.delete(KNOWLEDGE_KEYS.prompt);
  await bindings.KNOWLEDGE_KV.delete(KNOWLEDGE_KEYS.knowledge);
  await bindings.KNOWLEDGE_KV.delete(KNOWLEDGE_KEYS.ongkirPolicy);
  await bindings.MEDIA.delete(KNOWLEDGE_KEYS.prompt);
  await bindings.MEDIA.delete(KNOWLEDGE_KEYS.knowledge);
  await bindings.MEDIA.delete(KNOWLEDGE_KEYS.ongkirPolicy);
});

// ---------------------------------------------------------------------------
// chunker
// ---------------------------------------------------------------------------

describe("chunkText", () => {
  it("never exceeds the requested size for ordinary paragraphs", () => {
    const text = Array.from({ length: 40 }, (_unused, i) => `Paragraf ${i} ${"kata ".repeat(40)}`).join("\n\n");
    const chunks = chunkText(text, { size: 1_000, overlap: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.content.length).toBeLessThanOrEqual(1_000);
  });

  it("keeps a product block in one chunk instead of cutting it in half", () => {
    const block = [
      "#03  CASTELLI ENTRATA SHORT BLACK 010 SIZE XL (G 4520009)",
      "-".repeat(60),
      "  Template ID    : 116964",
      "  Harga          : Rp 1.400.000,00",
    ].join("\n");
    const chunks = chunkText(`${block}\n\n${block}\n\n${block}`, { size: 1_000 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content.split("#03")).toHaveLength(4);
  });

  it("hard-splits a block that is larger than the chunk size, with overlap", () => {
    const huge = "x".repeat(2_500);
    const chunks = chunkText(huge, { size: 1_000, overlap: 100 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) expect(chunk.content.length).toBeLessThanOrEqual(1_000);
    // 1000 - 100 = 900 characters of forward progress per chunk.
    expect(chunks[1]?.content.slice(0, 100)).toBe(chunks[0]?.content.slice(900));
  });

  it("packs small blocks together instead of emitting one chunk each", () => {
    // Packing is the point: a chunk should use its whole budget so retrieval
    // returns context, not fragments.
    const chunks = chunkText("satu\n\ndua\n\ntiga");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe("satu\n\ndua\n\ntiga");
  });

  it("numbers chunks from zero and gives each a stable id and hash", () => {
    // Blocks of 400 characters: two fit in the 1000-character budget, so five of
    // them produce three chunks.
    const text = Array.from({ length: 5 }, (_unused, i) => `blok-${i} ${"kata ".repeat(79)}`).join("\n\n");
    const chunks = chunkText(text);
    expect(chunks.length).toBe(3);
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual([0, 1, 2]);
    expect(chunks.map((chunk) => chunk.id)).toEqual(["knowledge.txt#0", "knowledge.txt#1", "knowledge.txt#2"]);
    // Same input, same hashes: this is what lets a sync skip unchanged chunks.
    expect(chunkText(text).map((chunk) => chunk.hash)).toEqual(chunks.map((chunk) => chunk.hash));
  });

  it("changes the hash when the text changes", () => {
    expect(contentHash("harga lama")).not.toBe(contentHash("harga baru"));
    expect(contentHash("harga lama")).toBe(contentHash("harga lama"));
  });

  it("returns nothing for empty or whitespace-only input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n  \n")).toEqual([]);
  });

  it("uses the documented 1000/100 defaults", () => {
    expect(DEFAULT_CHUNK_SIZE).toBe(1_000);
    const chunks = chunkText("y".repeat(1_050), {});
    expect(chunks[0]?.content.length).toBe(1_000);
    expect(chunks[1]?.content.slice(0, 100)).toBe(chunks[0]?.content.slice(900));
  });
});

// ---------------------------------------------------------------------------
// search primitives
// ---------------------------------------------------------------------------

describe("tokenize", () => {
  it("drops stopwords and very short tokens, and de-duplicates", () => {
    // "harga" survives on purpose: it is the term that locates a price block.
    expect(tokenize("Berapa harga kaos polos di toko anda?")).toEqual(["harga", "kaos", "polos", "toko", "anda"]);
    expect(tokenize("kaos kaos KAOS")).toEqual(["kaos"]);
  });

  it("keeps 'harga' even though it is common, because it finds price blocks", () => {
    expect(tokenize("harga")).toEqual(["harga"]);
  });

  it("returns nothing for punctuation-only input", () => {
    expect(tokenize("??? !!")).toEqual([]);
  });
});

describe("scoreChunk", () => {
  it("weighs a rare term above a common one", () => {
    const terms = ["castelli", "sepatu"];
    const documentFrequency = new Map([
      ["castelli", 1],
      ["sepatu", 40],
    ]);
    const rare = scoreChunk("castelli entrata", terms, documentFrequency, 40);
    const common = scoreChunk("sepatu", terms, documentFrequency, 40);
    expect(rare).toBeGreaterThan(common);
  });

  it("rewards an exact phrase over the same words apart", () => {
    const terms = ["castelli", "entrata"];
    const df = new Map([
      ["castelli", 1],
      ["entrata", 1],
    ]);
    const phrase = scoreChunk("castelli entrata short", terms, df, 10);
    const apart = scoreChunk("castelli ... entrata", terms, df, 10);
    expect(phrase).toBeGreaterThan(apart);
  });

  it("scores zero when nothing matches", () => {
    expect(scoreChunk("kaos polos", ["jaket"], new Map([["jaket", 0]]), 10)).toBe(0);
  });
});

describe("buildMatchQuery", () => {
  it("quotes every term so customer text cannot become FTS5 syntax", () => {
    expect(buildMatchQuery(["kaos", "polos"])).toBe('"kaos" OR "polos"');
  });

  it("neutralises operator characters that would otherwise error the query", () => {
    const query = buildMatchQuery(["near(", "*", 'kutip"', "a:b"]);
    expect(query).not.toMatch(/[()*:]/);
    expect(query).toContain('"near"');
  });

  it("returns an empty string when there is nothing searchable", () => {
    expect(buildMatchQuery([])).toBe("");
    expect(buildMatchQuery(["*", "()"])).toBe("");
  });
});

describe("searchInMemory", () => {
  // Explicit chunks, so these cases test the scorer rather than the packer.
  const chunks: Chunk[] = [
    "#01  Kaos Polos Cotton Combed 30s\n\n  Harga : Rp 75.000,00",
    "#02  Jaket Hoodie Fleece\n\n  Harga : Rp 250.000,00",
    "#03  Sepatu Running Pro\n\n  Harga : Rp 1.250.000,00",
  ].map((content, ordinal) => ({
    id: `knowledge.txt#${ordinal}`,
    source: "knowledge.txt",
    ordinal,
    content,
    hash: contentHash(content),
  }));

  it("returns the best match first", () => {
    const hits = searchInMemory(chunks, "jaket hoodie", 3);
    expect(hits[0]?.content).toContain("Jaket Hoodie");
  });

  it("respects topK", () => {
    expect(searchInMemory(chunks, "harga", 2)).toHaveLength(2);
  });

  it("returns nothing when no term matches", () => {
    expect(searchInMemory(chunks, "helm motor", 5)).toEqual([]);
  });

  it("returns nothing for an empty query", () => {
    expect(searchInMemory(chunks, "", 5)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// loader
// ---------------------------------------------------------------------------

describe("resolveKnowledgeMode", () => {
  it("honours an explicit mode regardless of size", () => {
    expect(resolveKnowledgeMode("kv_inline", 10_000_000, 1_000)).toBe("kv_inline");
    expect(resolveKnowledgeMode("r2_d1_fts", 10, 1_000)).toBe("r2_d1_fts");
  });

  it("auto picks kv_inline while the knowledge fits, and fts beyond it", () => {
    expect(resolveKnowledgeMode("auto", 1_000, 1_000)).toBe("kv_inline");
    expect(resolveKnowledgeMode("auto", 1_001, 1_000)).toBe("r2_d1_fts");
  });
});

describe("loadKnowledge", () => {
  it("reads prompt and knowledge from KV and reports the resolved mode", async () => {
    await bindings.KNOWLEDGE_KV.put(KNOWLEDGE_KEYS.prompt, "PROMPT RAHASIA");
    await bindings.KNOWLEDGE_KV.put(KNOWLEDGE_KEYS.knowledge, "KATALOG");

    const bundle = await loadKnowledge({ env: bindings, config });
    expect(bundle).not.toBeNull();
    expect(bundle?.prompt).toBe("PROMPT RAHASIA");
    expect(bundle?.knowledge).toBe("KATALOG");
    expect(bundle?.source).toBe("kv");
    // The real catalogue (73 KB) resolves to kv_inline; this tiny one must too.
    expect(bundle?.mode).toBe("kv_inline");
  });

  it("falls back to R2 when KV has nothing", async () => {
    await bindings.MEDIA.put(KNOWLEDGE_KEYS.knowledge, "KATALOG DARI R2");
    const bundle = await loadKnowledge({ env: bindings, config, useCache: false });
    expect(bundle?.knowledge).toBe("KATALOG DARI R2");
    expect(bundle?.source).toBe("r2");
  });

  it("returns null (and does not throw) when nothing is uploaded", async () => {
    const bundle = await loadKnowledge({ env: bindings, config, useCache: false });
    expect(bundle).toBeNull();
  });

  it("serves a cached bundle inside the TTL and drops it after invalidation", async () => {
    await bindings.KNOWLEDGE_KV.put(KNOWLEDGE_KEYS.knowledge, "VERSI SATU");
    const first = await loadKnowledge({ env: bindings, config });
    expect(first?.knowledge).toBe("VERSI SATU");

    await bindings.KNOWLEDGE_KV.put(KNOWLEDGE_KEYS.knowledge, "VERSI DUA");
    const cached = await loadKnowledge({ env: bindings, config });
    expect(cached?.knowledge).toBe("VERSI SATU");

    invalidateKnowledgeCache();
    const fresh = await loadKnowledge({ env: bindings, config });
    expect(fresh?.knowledge).toBe("VERSI DUA");
  });
});

describe("loadOngkirPolicy", () => {
  it("parses the policy JSON and tolerates a malformed one", async () => {
    await bindings.KNOWLEDGE_KV.put(KNOWLEDGE_KEYS.ongkirPolicy, '{"default":"admin","products":{"T1":"included"}}');
    expect(await loadOngkirPolicy(bindings)).toEqual({ default: "admin", products: { T1: "included" } });

    await bindings.KNOWLEDGE_KV.put(KNOWLEDGE_KEYS.ongkirPolicy, "{bukan json");
    expect(await loadOngkirPolicy(bindings)).toBeNull();
  });

  it("returns null when no policy is uploaded", async () => {
    expect(await loadOngkirPolicy(bindings)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// retrieve — both modes, including the real FTS5 path
// ---------------------------------------------------------------------------

const CATALOGUE = [
  "#01  Kaos Polos Cotton Combed 30s",
  "  Template ID    : 1001",
  "  Harga          : Rp 75.000,00",
  "",
  "#02  Jaket Hoodie Fleece",
  "  Template ID    : 1002",
  "  Harga          : Rp 250.000,00",
  "",
  "#03  Sepatu Running Pro",
  "  Template ID    : 1003",
  "  Harga          : Rp 1.250.000,00",
].join("\n");

async function seedChunks(): Promise<void> {
  await ensureFtsSchema(db);
  const chunks = chunkText(CATALOGUE, { source: "knowledge.txt" });
  for (const chunk of chunks) {
    await db
      .prepare(
        `INSERT INTO knowledge_chunks (source, ordinal, content, hash, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (source, ordinal) DO UPDATE SET content = excluded.content, hash = excluded.hash`,
      )
      .bind(chunk.source, chunk.ordinal, chunk.content, chunk.hash, 1)
      .run();
  }
}

describe("retrieve — kv_inline", () => {
  const bundle = {
    prompt: "P",
    knowledge: CATALOGUE,
    source: "kv" as const,
    bytes: CATALOGUE.length,
    mode: "kv_inline" as const,
    sizes: { prompt: 1, knowledge: CATALOGUE.length },
  };

  it("returns the matching catalogue chunks", async () => {
    const result = await retrieve({ env: bindings, config, bundle, query: "ada jaket hoodie?" });
    expect(result.mode).toBe("kv_inline");
    expect(result.fallback).toBe(false);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]?.content).toContain("Jaket Hoodie");
    expect(result.intro).toBe("");
  });

  it("hands the model an explicit no-context instruction when nothing matches", async () => {
    const result = await retrieve({ env: bindings, config, bundle, query: "helm motor" });
    expect(result.hits).toEqual([]);
    expect(result.intro).toBe(NO_CONTEXT_INTRO);
  });

  it("returns no hits and no crash when there is no knowledge at all", async () => {
    const result = await retrieve({ env: bindings, config, bundle: null, query: "jaket" });
    expect(result.hits).toEqual([]);
    expect(result.intro).toBe(NO_CONTEXT_INTRO);
  });

  it("caches the chunking across calls", () => {
    const first = chunksFor(bundle, "knowledge.txt");
    const second = chunksFor(bundle, "knowledge.txt");
    expect(second).toBe(first);
  });
});

describe("retrieve — r2_d1_fts (real FTS5 + bm25)", () => {
  const ftsConfig = { ...config, bot: { ...config.bot, knowledgeMode: "r2_d1_fts" as const } };
  const bundle = {
    prompt: "P",
    knowledge: CATALOGUE,
    source: "kv" as const,
    bytes: CATALOGUE.length,
    mode: "r2_d1_fts" as const,
    sizes: { prompt: 1, knowledge: CATALOGUE.length },
  };

  it("creates the virtual table and its triggers when missing", async () => {
    await ensureFtsSchema(db);
    const tables = await db
      .prepare("SELECT name FROM sqlite_master WHERE name LIKE 'knowledge_fts%' ORDER BY name")
      .all<{ name: string }>();
    expect(tables.results.map((row) => row.name)).toContain("knowledge_fts");
  });

  it("ranks the right chunk with bm25", async () => {
    await seedChunks();
    const result = await retrieve({ env: bindings, config: ftsConfig, bundle, query: "sepatu running" });
    expect(result.mode).toBe("r2_d1_fts");
    expect(result.hits[0]?.content).toContain("Sepatu Running");
    // bm25 returns a negative score where better matches are more negative.
    expect(result.hits[0]?.score).toBeLessThan(0);
  });

  it("respects KNOWLEDGE_TOP_K", async () => {
    await seedChunks();
    const limited = { ...ftsConfig, bot: { ...ftsConfig.bot, knowledgeTopK: 1 } };
    const result = await retrieve({ env: bindings, config: limited, bundle, query: "harga" });
    expect(result.hits).toHaveLength(1);
  });

  it("degrades to in-memory scoring instead of throwing when D1 fails", async () => {
    const broken = {
      BOT_DB: {
        prepare() {
          throw new Error("D1_ERROR: no such table: knowledge_fts");
        },
      } as unknown as D1Database,
      KNOWLEDGE_KV: bindings.KNOWLEDGE_KV,
      MEDIA: bindings.MEDIA,
    };

    const result = await retrieve({ env: broken, config: ftsConfig, bundle, query: "jaket hoodie" });
    expect(result.fallback).toBe(true);
    expect(result.mode).toBe("kv_inline");
    expect(result.hits[0]?.content).toContain("Jaket Hoodie");
  });

  it("does not let a customer's FTS operators break the query", async () => {
    await seedChunks();
    const result = await retrieve({ env: bindings, config: ftsConfig, bundle, query: 'jaket NEAR( "hoodie"' });
    expect(result.mode).toBe("r2_d1_fts");
    expect(result.hits.length).toBeGreaterThan(0);
  });
});
