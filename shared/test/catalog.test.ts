/**
 * Catalogue parser and ongkir-policy tests (work order FASE 3, step 1).
 *
 * The fixtures copy the *real* export byte-for-byte in the parts that matter,
 * including the detail that broke the first implementation: the colon is
 * right-aligned with spaces (`Harga          : Rp 1.400.000,00`). A parser that
 * only accepts `Harga :` silently reads every price as unparseable, which would
 * look like "the bot never quotes a price" rather than like a bug.
 */
import { describe, expect, it } from "vitest";
import {
  assignOngkirPolicy,
  parseCatalog,
  parseRupiah,
  resolveCatalog,
  summariseCatalog,
  type CatalogProduct,
  type OngkirPolicy,
} from "../src/bot/knowledge/catalog";

/** Shape of the real export, including the aligned colon and the empty SKU note. */
function block(
  ordinal: number,
  nama: string,
  fields: { templateId?: string; sku?: string; harga?: string; ongkir?: string } = {},
): string {
  const lines = [`#${String(ordinal).padStart(2, "0")}  ${nama}`, "-".repeat(80)];
  if (fields.sku !== undefined) lines.push(`  SKU/Code       : ${fields.sku}`);
  if (fields.templateId !== undefined) lines.push(`  Template ID    : ${fields.templateId}`);
  if (fields.harga !== undefined) lines.push(`  Harga          : ${fields.harga}`);
  if (fields.ongkir !== undefined) lines.push(`  Ongkir         : ${fields.ongkir}`);
  lines.push("  Mata Uang      : IDR", "");
  return lines.join("\n");
}

const EMPTY_SKU = "(tidak ada kode eksplisit di nama produk)";

describe("parseRupiah", () => {
  it.each([
    ["Rp 1.400.000,00", 1_400_000],
    ["Rp 1.899.000,00", 1_899_000],
    ["Rp 115.000", 115_000],
    ["Rp 5.880.000,00", 5_880_000],
    ["IDR 1.000", 1_000],
    ["rp1.000", 1_000],
    ["Rp 1.000,-", 1_000],
    ["  250000  ", 250_000],
    ["Rp 0", 0],
  ])("reads %s as %i", (raw, expected) => {
    expect(parseRupiah(raw)).toBe(expected);
  });

  it("truncates the decimal part instead of rounding through a float", () => {
    // Rupiah has no usable sub-unit here and all money in this project is an
    // integer, so ",99" must not become 1.
    expect(parseRupiah("Rp 1.400.000,99")).toBe(1_400_000);
    expect(Number.isSafeInteger(parseRupiah("Rp 1.400.000,99"))).toBe(true);
  });

  it.each([[""], ["   "], ["Rp"], ["gratis"], ["Rp 1,2,3"], ["Rp 1.4O0.000"]])(
    "returns null for %s so a bad price cannot become 0",
    (raw) => {
      expect(parseRupiah(raw)).toBeNull();
    },
  );
});

describe("parseCatalog", () => {
  it("reads the real block shape, including the aligned colon", () => {
    const text = block(3, "CASTELLI ENTRATA SHORT BLACK 010 SIZE XL (G 4520009)", {
      sku: "G 4520009",
      templateId: "116964",
      harga: "Rp 1.400.000,00",
    });

    const { products, skipped } = parseCatalog(text);
    expect(skipped).toEqual([]);
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({
      kode: "116964",
      nama: "CASTELLI ENTRATA SHORT BLACK 010 SIZE XL (G 4520009)",
      harga: 1_400_000,
      ordinal: 3,
      templateId: "116964",
      sku: "G 4520009",
      ongkirFromKnowledge: null,
    });
  });

  it("prefers Template ID, then Code/SKU, then the #NN header (Q26=A)", () => {
    const text = [
      block(1, "Punya Template", { templateId: "T-1", sku: "SKU-1", harga: "Rp 10.000" }),
      block(2, "Tanpa Template", { sku: "SKU-2", harga: "Rp 20.000" }),
      block(3, "Tanpa Keduanya", { harga: "Rp 30.000" }),
    ].join("\n");

    const { products } = parseCatalog(text);
    expect(products.map((product) => product.kode)).toEqual(["T-1", "SKU-2", "#03"]);
  });

  it("treats wuzapi's 'no explicit code' note as an empty SKU", () => {
    const text = block(1, "Tanpa Kode", { sku: EMPTY_SKU, templateId: "T-9", harga: "Rp 10.000" });
    const { products } = parseCatalog(text);
    expect(products[0]?.sku).toBe("");
    expect(products[0]?.kode).toBe("T-9");
  });

  it("never reads 'Harga coret' as the real price", () => {
    const text = [
      "#01  Diskon",
      "-".repeat(80),
      "  Harga coret    : Rp 2.000.000,00",
      "  Template ID    : T-1",
      "  Harga          : Rp 1.500.000,00",
    ].join("\n");

    const { products } = parseCatalog(text);
    expect(products[0]?.harga).toBe(1_500_000);
  });

  it("reads both ongkir wordings", () => {
    const text = [
      block(1, "Termasuk", { templateId: "T-1", harga: "Rp 10.000", ongkir: "termasuk" }),
      block(2, "Tidak Termasuk", { templateId: "T-2", harga: "Rp 10.000", ongkir: "tidak termasuk" }),
      block(3, "Absen", { templateId: "T-3", harga: "Rp 10.000" }),
    ].join("\n");

    const { products } = parseCatalog(text);
    expect(products.map((product) => product.ongkirFromKnowledge)).toEqual([true, false, null]);
  });

  it("leaves an unrecognised ongkir wording to the policy instead of guessing", () => {
    const text = block(1, "Aneh", { templateId: "T-1", harga: "Rp 10.000", ongkir: "tergantung kurir" });
    const { products } = parseCatalog(text);
    expect(products[0]?.ongkirFromKnowledge).toBeNull();
    expect(products[0]?.ongkirRaw).toBe("tergantung kurir");
  });

  it("skips a product whose price cannot be read, and reports it", () => {
    const text = [
      block(1, "Harga Rusak", { templateId: "T-1", harga: "hubungi admin" }),
      block(2, "Harga Baik", { templateId: "T-2", harga: "Rp 10.000" }),
    ].join("\n");

    const { products, skipped } = parseCatalog(text);
    expect(products.map((product) => product.kode)).toEqual(["T-2"]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain("Harga Rusak");
  });

  it("ignores navigation text before the first product header", () => {
    const text = [
      ">>> STRUKTUR SUBCATEGORY MEN <<<",
      "▼ APPAREL  →  https://example.test/category/252",
      "    • Running Shoes  →  https://example.test/category/244",
      block(1, "Produk Pertama", { templateId: "T-1", harga: "Rp 10.000" }),
    ].join("\n");

    const { products } = parseCatalog(text);
    expect(products).toHaveLength(1);
    expect(products[0]?.nama).toBe("Produk Pertama");
  });

  it("returns nothing for an empty or unrelated file", () => {
    expect(parseCatalog("").products).toEqual([]);
    expect(parseCatalog("tidak ada produk di sini").products).toEqual([]);
  });
});

describe("resolveCatalog — ongkir priority (Q25=A)", () => {
  const products: CatalogProduct[] = [
    {
      kode: "FROM-KNOWLEDGE",
      nama: "Punya baris Ongkir",
      harga: 10_000,
      ordinal: 1,
      templateId: "FROM-KNOWLEDGE",
      sku: "",
      ongkirFromKnowledge: true,
      ongkirRaw: "termasuk",
    },
    {
      kode: "FROM-POLICY",
      nama: "Hanya ada di policy",
      harga: 20_000,
      ordinal: 2,
      templateId: "FROM-POLICY",
      sku: "",
      ongkirFromKnowledge: null,
      ongkirRaw: null,
    },
    {
      kode: "UNLISTED",
      nama: "Tidak disebut di mana pun",
      harga: 30_000,
      ordinal: 3,
      templateId: "UNLISTED",
      sku: "",
      ongkirFromKnowledge: null,
      ongkirRaw: null,
    },
  ];

  it("falls back to admin review when there is no policy at all", () => {
    const resolved = resolveCatalog(products, null);
    expect(resolved.map((product) => product.ongkirIncluded)).toEqual([true, false, false]);
    expect(resolved.map((product) => product.ongkirSource)).toEqual(["knowledge", "default", "default"]);
    expect(resolved.map((product) => product.ongkirKnown)).toEqual([true, false, false]);
  });

  it("lets the knowledge line win over the policy file", () => {
    const policy: OngkirPolicy = { default: "admin", products: { "FROM-KNOWLEDGE": "excluded" } };
    const resolved = resolveCatalog(products, policy);
    expect(resolved[0]).toMatchObject({ ongkirIncluded: true, ongkirSource: "knowledge" });
  });

  it("uses the policy entry for a product the knowledge file does not decide", () => {
    const policy: OngkirPolicy = { default: "admin", products: { "FROM-POLICY": "included" } };
    const resolved = resolveCatalog(products, policy);
    expect(resolved[1]).toMatchObject({ ongkirIncluded: true, ongkirSource: "policy", ongkirKnown: true });
  });

  it("honours a non-admin policy default", () => {
    const resolved = resolveCatalog(products, { default: "included", products: {} });
    expect(resolved[2]).toMatchObject({ ongkirIncluded: true, ongkirSource: "default", ongkirKnown: false });
  });

  it("treats a malformed policy value as absent rather than trusting it", () => {
    const policy = { default: "admin", products: { UNLISTED: "mungkin" } } as unknown as OngkirPolicy;
    const resolved = resolveCatalog(products, policy);
    expect(resolved[2]).toMatchObject({ ongkirIncluded: false, ongkirSource: "default" });
  });

  it("summarises how much of the catalogue is actually decided", () => {
    const resolved = resolveCatalog(products, { default: "admin", products: { "FROM-POLICY": "included" } });
    expect(summariseCatalog(resolved)).toEqual({
      total: 3,
      included: 2,
      excluded: 1,
      admin: 1,
      bySource: { knowledge: 1, policy: 1, default: 1 },
    });
  });
});

describe("assignOngkirPolicy — sandbox determinism", () => {
  const products: CatalogProduct[] = Array.from({ length: 40 }, (_unused, index) => ({
    kode: `T-${String(index + 1).padStart(3, "0")}`,
    nama: `Produk ${index + 1}`,
    harga: 10_000 * (index + 1),
    ordinal: index + 1,
    templateId: `T-${String(index + 1).padStart(3, "0")}`,
    sku: "",
    ongkirFromKnowledge: null,
    ongkirRaw: null,
  }));

  it("produces byte-identical output for the same seed", () => {
    const first = assignOngkirPolicy(products, { ratio: 0.5, seed: 20261010 });
    const second = assignOngkirPolicy(products, { ratio: 0.5, seed: 20261010 });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("produces a different selection for a different seed", () => {
    const a = assignOngkirPolicy(products, { ratio: 0.5, seed: 20261010 });
    const b = assignOngkirPolicy(products, { ratio: 0.5, seed: 999 });
    expect(JSON.stringify(a.products)).not.toBe(JSON.stringify(b.products));
  });

  it("marks the requested fraction as included and leaves the rest to the default", () => {
    const policy = assignOngkirPolicy(products, { ratio: 0.5, seed: 1 });
    expect(Object.keys(policy.products)).toHaveLength(20);
    expect(Object.values(policy.products).every((value) => value === "included")).toBe(true);
    expect(policy.default).toBe("admin");
    // Products not listed are resolved through `default`, i.e. admin review.
    const resolved = resolveCatalog(products, policy);
    expect(summariseCatalog(resolved)).toMatchObject({ total: 40, included: 20, admin: 20 });
  });

  it("can also mark part of the remainder as excluded", () => {
    const policy = assignOngkirPolicy(products, { ratio: 0.5, excludedRatio: 0.5, seed: 7 });
    const values = Object.values(policy.products);
    expect(values.filter((value) => value === "included")).toHaveLength(20);
    expect(values.filter((value) => value === "excluded")).toHaveLength(10);
  });

  it("writes a stable, sorted key order so the file diffs cleanly", () => {
    const policy = assignOngkirPolicy(products, { ratio: 1, seed: 3 });
    const keys = Object.keys(policy.products);
    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
  });

  it("handles a ratio of 0 and 1 without inventing entries", () => {
    expect(Object.keys(assignOngkirPolicy(products, { ratio: 0, seed: 5 }).products)).toHaveLength(0);
    expect(Object.keys(assignOngkirPolicy(products, { ratio: 1, seed: 5 }).products)).toHaveLength(40);
  });
});
