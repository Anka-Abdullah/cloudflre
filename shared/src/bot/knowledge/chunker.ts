/**
 * Splits knowledge.txt into retrievable chunks.
 *
 * Two things make this more than a `slice()` loop:
 *
 *  1. The catalogue is already structured — `#NN <nama>` blocks separated by
 *     `-----` rules. Splitting on those boundaries first keeps one product inside
 *     one chunk, which is what makes retrieval useful: a chunk that starts in the
 *     middle of a price list answers nothing. A fixed 1000-character window is
 *     only used for a block that is itself too long.
 *  2. The same chunks feed both retrieval modes: KV in-memory scoring and the D1
 *     FTS5 table. The FTS table is external-content (`content='knowledge_chunks'`),
 *     so a chunk written by the sync is exactly what bm25() ranks.
 *
 * `hash` is a content fingerprint, not a security hash: it exists so a sync can
 * skip rewriting chunks whose text did not change. FNV-1a is used because it is
 * synchronous — `crypto.subtle.digest` is async and would make chunking awkward
 * to use inside the SQL-building code path.
 */
export interface Chunk {
  /** Stable id: `${source}#${ordinal}`. */
  id: string;
  source: string;
  /** 0-based position inside the source. */
  ordinal: number;
  content: string;
  /** Fingerprint of `content`, 16 hex chars. */
  hash: string;
}

export interface ChunkOptions {
  /** Target chunk size in characters (work plan: 1000). */
  size?: number;
  /** Characters repeated between consecutive hard-split chunks (plan: 100). */
  overlap?: number;
  /** Source label stored with each chunk, e.g. "knowledge.txt". */
  source?: string;
}

export const DEFAULT_CHUNK_SIZE = 1_000;
export const DEFAULT_CHUNK_OVERLAP = 100;

/** FNV-1a 32-bit, twice with different offsets → 16 hex chars. */
export function contentHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a ^= code;
    a = Math.imul(a, 0x01000193) >>> 0;
    b = (b + code) >>> 0;
    b = Math.imul(b ^ (b >>> 13), 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/**
 * A "block" is a paragraph: text separated by one or more blank lines. The
 * catalogue's `-----` rules and `#NN` headers are therefore natural boundaries,
 * because the export puts a blank line after every product block.
 */
function toBlocks(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block !== "");
}

/** Hard-splits one oversized block, repeating `overlap` characters between cuts. */
function splitOversized(block: string, size: number, overlap: number): string[] {
  const parts: string[] = [];
  const step = Math.max(1, size - overlap);
  for (let start = 0; start < block.length; start += step) {
    const end = Math.min(block.length, start + size);
    parts.push(block.slice(start, end));
    if (end === block.length) break;
  }
  return parts;
}

export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const size = Math.max(50, options.size ?? DEFAULT_CHUNK_SIZE);
  const overlap = Math.max(0, Math.min(options.overlap ?? DEFAULT_CHUNK_OVERLAP, size - 1));
  const source = options.source ?? "knowledge.txt";

  const chunks: string[] = [];
  let pending: string[] = [];
  let pendingLength = 0;

  const flush = (): void => {
    if (pending.length === 0) return;
    chunks.push(pending.join("\n\n"));
    pending = [];
    pendingLength = 0;
  };

  for (const block of toBlocks(text)) {
    if (block.length > size) {
      // Finish the current chunk first so the oversized block starts clean.
      flush();
      for (const part of splitOversized(block, size, overlap)) chunks.push(part);
      continue;
    }
    const extra = pending.length === 0 ? block.length : block.length + 2; // "\n\n"
    if (pendingLength + extra > size) flush();
    pending.push(block);
    pendingLength += extra;
  }
  flush();

  return chunks.map((content, ordinal) => ({
    id: `${source}#${ordinal}`,
    source,
    ordinal,
    content,
    hash: contentHash(content),
  }));
}
