/**
 * Katalog parser for the *real* knowledge.txt format.
 *
 * The work plan (Q9) described the catalogue as "blok Produk/Harga/Ongkir". The
 * actual export in the reference project does not look like that, so this file
 * parses what is really there (verified against 70 products):
 *
 *   #03  CASTELLI ENTRATA SHORT BLACK 010 SIZE XL (G 4520009)
 *   ------------------------------------------------------------------
 *     Brand          : CASTELLI
 *     SKU/Code       : G 4520009
 *     Template ID    : 116964
 *     Variant ID     : 124120
 *     Harga          : Rp 1.400.000,00
 *     Mata Uang      : IDR
 *     Kategori       : Men (men-239)
 *     Image URL      : https://...
 *     Image Filename : ...
 *     Product URL    : https://...
 *
 * Three consequences that shape the code:
 *
 *  1. There is no `Produk:` label — the name is the text after `#NN  ` on the
 *     header line, and the header's ordinal is the last-resort identifier.
 *  2. `SKU/Code` is frequently empty (the export writes
 *     "(tidak ada kode eksplisit di nama produk)"), so the product key cannot
 *     depend on it. `kode = Template ID || Code/SKU || #NN` (work order Q26=A).
 *  3. There is no `Ongkir:` line in today's catalogue at all, so the ongkir
 *     decision falls through to the policy file and then to the safe default
 *     (`admin`). See `resolveCatalog`.
 *
 * This module deliberately has NO imports: `scripts/assign-ongkir.mjs` imports it
 * directly through Node's TypeScript support, so the product-key rule exists in
 * exactly one place instead of being re-implemented in the script.
 */

export type OngkirDecision = "included" | "excluded" | "admin";

/** One `#NN` block, before the ongkir decision is resolved. */
export interface CatalogProduct {
  /** Template ID, else Code/SKU, else `#NN`. Stable across syncs (Q26=A). */
  kode: string;
  nama: string;
  /** Integer rupiah. Never a float, never the model's guess. */
  harga: number;
  /** 1-based header ordinal (`#03` → 3). */
  ordinal: number;
  templateId: string;
  sku: string;
  /** true/false from an explicit `Ongkir:` line; null when the line is absent. */
  ongkirFromKnowledge: boolean | null;
  /** Raw `Ongkir:` value, kept for logging when it is neither of the two known values. */
  ongkirRaw: string | null;
}

export type OngkirSource = "knowledge" | "policy" | "default";

export interface ResolvedProduct extends CatalogProduct {
  /** True when the decision came from an explicit source, not the safety default. */
  ongkirKnown: boolean;
  /** true → the worker may create the payment link without an admin; false → admin review. */
  ongkirIncluded: boolean;
  ongkirSource: OngkirSource;
}

export interface OngkirPolicy {
  version?: number;
  default?: OngkirDecision;
  products?: Record<string, OngkirDecision>;
}

const SKU_PLACEHOLDER = /^\(.*tidak ada kode.*\)$/i;

function isDecision(value: unknown): value is OngkirDecision {
  return value === "included" || value === "excluded" || value === "admin";
}

/**
 * Parses an Indonesian rupiah amount into an integer, without ever going through
 * a float: `"Rp 1.400.000,00"` → `1400000`.
 *
 * Dots are thousands separators and the comma starts the decimals, which rupiah
 * cannot express in practice, so the decimal part is truncated rather than
 * rounded (money in this project is always an integer, see the Turso rules).
 * Returns null when the value cannot be understood, so a malformed price is
 * visible instead of becoming 0.
 */
export function parseRupiah(raw: string): number | null {
  let text = raw.trim();
  if (text === "") return null;

  // Currency prefix, in any of the shapes the export uses: "Rp", "Rp.", "IDR".
  text = text.replace(/^(rp\.?|idr)\s*/i, "");
  // Spaces (including non-breaking) and the ",-" suffix some exports use.
  text = text.replace(/[\s\u00a0]/g, "").replace(/,-$/, "");
  if (text === "") return null;

  const negative = text.startsWith("-");
  if (negative) text = text.slice(1);

  // Decimals: keep the integer part only. A second comma means the value is not
  // a plain amount (e.g. "1,2,3"), which is treated as unparseable.
  const comma = text.indexOf(",");
  if (comma !== -1) {
    if (text.indexOf(",", comma + 1) !== -1) return null;
    text = text.slice(0, comma);
  }

  text = text.replace(/\./g, "");
  if (!/^[0-9]+$/.test(text)) return null;

  const value = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(value)) return null;
  return negative ? -value : value;
}

/** `"SKU/Code : (tidak ada kode eksplisit di nama produk)"` means "no code". */
function cleanSku(raw: string): string {
  const value = raw.trim();
  if (value === "" || SKU_PLACEHOLDER.test(value)) return "";
  return value;
}

/**
 * Reads one `key : value` line.
 *
 * The export right-aligns the colon with spaces (`Harga          : Rp …`), so the
 * separator has to allow arbitrary whitespace. Only whitespace may sit between
 * the key and the colon, which is what keeps `Harga coret :` from being read as
 * `Harga` — a distinction that would otherwise put a struck-through price into
 * the catalogue as if it were the real one.
 */
function fieldValue(line: string, key: string): string | null {
  const trimmed = line.trim();
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}\\s*:\\s*(.*)$`, "i").exec(trimmed);
  return match?.[1] === undefined ? null : match[1].trim();
}

/**
 * Parses every `#NN` block in knowledge.txt.
 *
 * Lines before the first header are ignored (the file starts with a category
 * structure listing, which is navigation, not catalogue). A block with an
 * unparseable price is skipped and reported in `skipped`, because a product the
 * bot cannot price correctly must not be quotable.
 */
export function parseCatalog(text: string): { products: CatalogProduct[]; skipped: string[] } {
  const products: CatalogProduct[] = [];
  const skipped: string[] = [];

  const lines = text.split(/\r?\n/);
  let current: {
    ordinal: number;
    nama: string;
    templateId: string;
    sku: string;
    harga: number | null;
    ongkir: boolean | null;
    ongkirRaw: string | null;
  } | null = null;

  const flush = (): void => {
    if (!current) return;
    const block = current;
    current = null;
    if (block.harga === null) {
      skipped.push(`#${String(block.ordinal).padStart(2, "0")} ${block.nama} (harga tidak terbaca)`);
      return;
    }
    const kode = block.templateId !== "" ? block.templateId : block.sku !== "" ? block.sku : `#${String(block.ordinal).padStart(2, "0")}`;
    products.push({
      kode,
      nama: block.nama,
      harga: block.harga,
      ordinal: block.ordinal,
      templateId: block.templateId,
      sku: block.sku,
      ongkirFromKnowledge: block.ongkir,
      ongkirRaw: block.ongkirRaw,
    });
  };

  for (const line of lines) {
    const header = /^#(\d+)\s+(.+?)\s*$/.exec(line);
    if (header?.[1] && header[2]) {
      flush();
      current = {
        ordinal: Number.parseInt(header[1], 10),
        nama: header[2],
        templateId: "",
        sku: "",
        harga: null,
        ongkir: null,
        ongkirRaw: null,
      };
      continue;
    }
    if (!current) continue;

    const templateId = fieldValue(line, "Template ID");
    if (templateId !== null) {
      current.templateId = templateId;
      continue;
    }
    const sku = fieldValue(line, "SKU/Code");
    if (sku !== null) {
      current.sku = cleanSku(sku);
      continue;
    }
    const harga = fieldValue(line, "Harga");
    if (harga !== null) {
      current.harga = parseRupiah(harga);
      continue;
    }
    const ongkir = fieldValue(line, "Ongkir");
    if (ongkir !== null) {
      current.ongkirRaw = ongkir;
      const normalised = ongkir.toLowerCase();
      if (normalised.includes("tidak termasuk")) current.ongkir = false;
      else if (normalised.includes("termasuk")) current.ongkir = true;
      else current.ongkir = null; // unknown wording → fall through to the policy
      continue;
    }
  }
  flush();

  return { products, skipped };
}

/** True when a policy value is one this project understands. */
export function isOngkirDecision(value: unknown): value is OngkirDecision {
  return isDecision(value);
}

/**
 * Decides `ongkir_included` for every product, in the order the work order fixed
 * (Q25=A):
 *
 *   1. the explicit `Ongkir:` line in knowledge.txt,
 *   2. `products[kode]` in this number's ongkir-policy.json,
 *   3. `default` from the policy file, else `admin`.
 *
 * Step 3 is deliberately the safe answer: with no information at all the order
 * goes to admin review instead of producing a payment link nobody checked.
 * `ongkir_known` records whether the answer came from 1 or 2, so the operator can
 * see how much of the catalogue is actually decided.
 */
export function resolveCatalog(products: readonly CatalogProduct[], policy: OngkirPolicy | null): ResolvedProduct[] {
  const policyDefault: OngkirDecision = isDecision(policy?.default) ? policy.default : "admin";

  return products.map((product) => {
    const fromPolicy = policy?.products?.[product.kode];
    let decision: OngkirDecision;
    let source: OngkirSource;

    if (product.ongkirFromKnowledge !== null) {
      decision = product.ongkirFromKnowledge ? "included" : "excluded";
      source = "knowledge";
    } else if (isDecision(fromPolicy)) {
      decision = fromPolicy;
      source = "policy";
    } else {
      decision = policyDefault;
      source = "default";
    }

    return {
      ...product,
      ongkirKnown: source !== "default",
      ongkirIncluded: decision === "included",
      ongkirSource: source,
    };
  });
}

/** Summary for logs: how many products were decided, and by which source. */
export function summariseCatalog(products: readonly ResolvedProduct[]): {
  total: number;
  included: number;
  excluded: number;
  admin: number;
  bySource: Record<OngkirSource, number>;
} {
  const bySource: Record<OngkirSource, number> = { knowledge: 0, policy: 0, default: 0 };
  let included = 0;
  let admin = 0;
  for (const product of products) {
    bySource[product.ongkirSource] += 1;
    if (product.ongkirIncluded) included += 1;
    else admin += 1;
  }
  return { total: products.length, included, excluded: admin, admin, bySource };
}

// ---------------------------------------------------------------------------
// Sandbox policy generation (used by scripts/assign-ongkir.mjs).
//
// Lives here rather than in the script so the seeding rule is unit-tested in the
// same suite as the parser it depends on, and so "the same seed gives the same
// policy" is an asserted property instead of a hope.
// ---------------------------------------------------------------------------

export interface AssignOptions {
  /** Fraction of products marked `included` (branch A: automatic link). */
  ratio: number;
  /** Fraction of the remainder marked `excluded` explicitly. */
  excludedRatio?: number;
  seed: number;
  /** Value written as the policy default; untouched products follow it. */
  defaultDecision?: OngkirDecision;
}

export interface AssignedPolicy {
  version: number;
  default: OngkirDecision;
  products: Record<string, OngkirDecision>;
}

/**
 * mulberry32. Chosen over `Math.random` because it is seeded: the same seed
 * produces byte-identical output on every machine and Node version, which is what
 * makes a sandbox finding reproducible.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates driven by the seeded generator. */
function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const a = copy[i];
    const b = copy[j];
    if (a === undefined || b === undefined) continue;
    copy[i] = b;
    copy[j] = a;
  }
  return copy;
}

/**
 * Picks which products are marked `included` / `excluded` for a sandbox.
 *
 * Only the chosen products are written; everything else follows `default`, so an
 * unlisted product keeps the safe admin-review behaviour. Keys are sorted so the
 * generated JSON is stable and diffable.
 */
export function assignOngkirPolicy(products: readonly CatalogProduct[], options: AssignOptions): AssignedPolicy {
  const ratio = Math.min(1, Math.max(0, options.ratio));
  const excludedRatio = Math.min(1, Math.max(0, options.excludedRatio ?? 0));
  const fallback: OngkirDecision = isDecision(options.defaultDecision) ? options.defaultDecision : "admin";

  const random = mulberry32(options.seed);
  const shuffled = shuffle(products, random);
  const includeCount = Math.round(shuffled.length * ratio);
  const rest = shuffled.slice(includeCount);
  const excludeCount = Math.round(rest.length * excludedRatio);

  const chosen: Record<string, OngkirDecision> = {};
  for (const product of shuffled.slice(0, includeCount)) chosen[product.kode] = "included";
  for (const product of rest.slice(0, excludeCount)) chosen[product.kode] = "excluded";

  const sorted = Object.keys(chosen).sort((a, b) => a.localeCompare(b));
  const entries: Record<string, OngkirDecision> = {};
  for (const key of sorted) {
    const value = chosen[key];
    if (value !== undefined) entries[key] = value;
  }

  return { version: 1, default: fallback, products: entries };
}
