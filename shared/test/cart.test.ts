/**
 * Cart service and sales-tool tests against the real D1 binding.
 *
 * The guarantee under test is the one that costs money if it breaks: **the price
 * is never taken from the caller**. `add_to_cart` accepts a code and a quantity,
 * and the stored `unit_price` must equal the catalogue's price even if the model
 * asked for something else. There is no code path that accepts a price argument,
 * and these tests exist so one cannot be added quietly.
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Env } from "../src/config";
import { parseCatalog, resolveCatalog, type ResolvedProduct } from "../src/bot/knowledge/catalog";
import { addItem, cartToPrompt, findProduct, limitsOf, readCart, removeItem } from "../src/bot/sales/cart.service";
import { executeTool } from "../src/bot/agent/tools";
import { formatRupiah } from "../src/bot/utils/format";
import { createLogger } from "../src/lib/logger";

const bindings = env as unknown as { BOT_DB: D1Database; MEDIA: R2Bucket; R2_PUBLIC_BASE_URL?: string };
const db = bindings.BOT_DB;
const config = loadConfig(env as unknown as Env);
const quiet = createLogger({ handler: "test" }, () => {});
const CHAT = "628111@s.whatsapp.net";

/** Two real-shaped catalogue products, one with ongkir decided and one without. */
const KNOWLEDGE = [
  "#01  CASTELLI ENTRATA SHORT BLACK 010 SIZE XL (G 4520009)",
  "  SKU/Code       : G 4520009",
  "  Template ID    : 116964",
  "  Harga          : Rp 1.400.000,00",
  "",
  "#02  Kaos Polos Cotton Combed 30s",
  "  SKU/Code       : (tidak ada kode eksplisit di nama produk)",
  "  Template ID    : 100370",
  "  Harga          : Rp 75.000,00",
  "  Ongkir         : termasuk",
].join("\n");

const catalog: ResolvedProduct[] = resolveCatalog(parseCatalog(KNOWLEDGE).products, { default: "admin", products: {} });
const limits = limitsOf(config);

/** Finds a product by code, exactly as the tool layer does. */
function product(kode: string): ResolvedProduct {
  const found = catalog.find((entry) => entry.kode === kode);
  if (!found) throw new Error(`fixture product ${kode} missing`);
  return found;
}

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM cart_items"),
    db.prepare("DELETE FROM carts"),
  ]);
});

describe("catalogue fixture", () => {
  it("parses both products with integer prices and the ongkir decision", () => {
    expect(catalog).toHaveLength(2);
    expect(product("116964").harga).toBe(1_400_000);
    expect(product("100370").harga).toBe(75_000);
    // The explicit "Ongkir: termasuk" line wins over the admin default.
    expect(product("100370").ongkirIncluded).toBe(true);
    expect(product("100370").ongkirSource).toBe("knowledge");
    // No line and no policy entry → admin review.
    expect(product("116964").ongkirIncluded).toBe(false);
    expect(product("116964").ongkirSource).toBe("default");
  });
});

describe("findProduct", () => {
  it("matches by code, by exact name and by a unique fragment", () => {
    expect(findProduct(catalog, "116964")?.kode).toBe("116964");
    expect(findProduct(catalog, "Kaos Polos Cotton Combed 30s")?.kode).toBe("100370");
    expect(findProduct(catalog, "castelli")?.kode).toBe("116964");
  });

  it("refuses an ambiguous fragment rather than picking one at random", () => {
    // Both products contain "o", so a fragment matching both must return null.
    expect(findProduct(catalog, "o")).toBeNull();
  });

  it("returns null for an invented product", () => {
    expect(findProduct(catalog, "999999")).toBeNull();
  });
});

describe("addItem", () => {
  it("adds a line priced from the catalogue", async () => {
    const outcome = await addItem(db, {
      chatJid: CHAT,
      product: product("116964"),
      qty: 2,
      at: 1_000,
      limits,
      catalog,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.view.lines).toEqual([
      { kode: "116964", nama: product("116964").nama, qty: 2, unitPrice: 1_400_000, subtotal: 2_800_000 },
    ]);
    expect(outcome.view.total).toBe(2_800_000);
  });

  it("increases the quantity of an existing line instead of duplicating it", async () => {
    await addItem(db, { chatJid: CHAT, product: product("100370"), qty: 1, at: 1, limits, catalog });
    const second = await addItem(db, { chatJid: CHAT, product: product("100370"), qty: 3, at: 2, limits, catalog });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.view.lines).toHaveLength(1);
    expect(second.view.lines[0]?.qty).toBe(4);
    expect(second.view.total).toBe(300_000);
  });

  it("keeps carts isolated per chat", async () => {
    await addItem(db, { chatJid: CHAT, product: product("100370"), qty: 1, at: 1, limits, catalog });
    const other = await readCart(db, "628222@s.whatsapp.net", catalog);
    expect(other.lines).toEqual([]);
    expect(other.total).toBe(0);
  });

  it("rejects a non-positive quantity", async () => {
    const outcome = await addItem(db, { chatJid: CHAT, product: product("100370"), qty: 0, at: 1, limits, catalog });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("lebih dari 0");
  });

  it("enforces BOT_MAX_ITEM_QTY across successive adds", async () => {
    const capped = { maxItems: limits.maxItems, maxItemQty: 3 };
    expect((await addItem(db, { chatJid: CHAT, product: product("100370"), qty: 2, at: 1, limits: capped, catalog })).ok).toBe(true);
    const over = await addItem(db, { chatJid: CHAT, product: product("100370"), qty: 2, at: 2, limits: capped, catalog });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toContain("melebihi 3 pcs");
  });

  it("enforces BOT_MAX_ITEMS distinctly from quantity", async () => {
    const capped = { maxItems: 1, maxItemQty: 99 };
    await addItem(db, { chatJid: CHAT, product: product("100370"), qty: 1, at: 1, limits: capped, catalog });
    const over = await addItem(db, { chatJid: CHAT, product: product("116964"), qty: 1, at: 2, limits: capped, catalog });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toContain("1 produk");
  });
});

describe("removeItem", () => {
  it("reduces a line and then removes it", async () => {
    await addItem(db, { chatJid: CHAT, product: product("100370"), qty: 5, at: 1, limits, catalog });

    const reduced = await removeItem(db, { chatJid: CHAT, kode: "100370", qty: 2, at: 2, catalog });
    expect(reduced.ok).toBe(true);
    if (reduced.ok) expect(reduced.view.lines[0]?.qty).toBe(3);

    const removed = await removeItem(db, { chatJid: CHAT, kode: "100370", at: 3, catalog });
    expect(removed.ok).toBe(true);
    if (removed.ok) {
      expect(removed.view.lines).toEqual([]);
      expect(removed.view.total).toBe(0);
    }
  });

  it("reports a product that is not in the cart", async () => {
    const outcome = await removeItem(db, { chatJid: CHAT, kode: "116964", at: 1, catalog });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("tidak ada di keranjang");
  });
});

describe("cartToPrompt", () => {
  it("renders integers, not formatted rupiah, for the model", async () => {
    await addItem(db, { chatJid: CHAT, product: product("116964"), qty: 1, at: 1, limits, catalog });
    const view = await readCart(db, CHAT, catalog);
    const text = cartToPrompt(view);
    expect(text).toContain("1400000");
    expect(text).toContain("Total: 1400000");
    // The customer-facing string is the formatted one; the model gets raw numbers
    // so it cannot misread a thousands separator.
    expect(formatRupiah(view.total)).toBe("Rp 1.400.000");
  });
});

describe("executeTool", () => {
  const toolContext = {
    env: bindings,
    config,
    chatJid: CHAT,
    catalog,
    now: new Date("2026-10-10T10:00:00Z"),
    log: quiet,
  };

  it("adds to the cart from a code and a quantity only", async () => {
    const outcome = await executeTool("add_to_cart", '{"kode":"116964","qty":1}', toolContext);
    expect(outcome.failed).toBe(false);
    expect(outcome.result).toContain("1400000");

    const view = await readCart(db, CHAT, catalog);
    expect(view.total).toBe(1_400_000);
  });

  it("ignores a price the model tries to supply", async () => {
    // The model is not given a price argument, and one must not take effect.
    const outcome = await executeTool("add_to_cart", '{"kode":"116964","qty":1,"harga":1}', toolContext);
    expect(outcome.failed).toBe(false);
    const view = await readCart(db, CHAT, catalog);
    expect(view.lines[0]?.unitPrice).toBe(1_400_000);
    expect(view.total).toBe(1_400_000);
  });

  it("refuses an invented product code", async () => {
    const outcome = await executeTool("add_to_cart", '{"kode":"TIDAK-ADA","qty":1}', toolContext);
    expect(outcome.failed).toBe(true);
    expect(outcome.result).toContain("tidak ada di katalog");
    expect((await readCart(db, CHAT, catalog)).lines).toEqual([]);
  });

  it("reports malformed arguments as guidance instead of throwing", async () => {
    const outcome = await executeTool("add_to_cart", "{bukan json", toolContext);
    expect(outcome.failed).toBe(true);
    expect(outcome.result).toContain("butuh");
  });

  it("answers view_cart and remove_from_cart", async () => {
    await executeTool("add_to_cart", '{"kode":"100370","qty":2}', toolContext);

    const viewed = await executeTool("view_cart", "{}", toolContext);
    expect(viewed.result).toContain("150000");

    const removed = await executeTool("remove_from_cart", '{"kode":"100370"}', toolContext);
    expect(removed.failed).toBe(false);
    expect((await readCart(db, CHAT, catalog)).lines).toEqual([]);
  });

  it("tells the model that checkout is not available yet, so it cannot promise a link", async () => {
    const outcome = await executeTool("create_payment_link", '{"nama":"Budi","alamat":"Jl. Merdeka 1"}', toolContext);
    expect(outcome.failed).toBe(true);
    expect(outcome.result).toContain("BELUM tersedia");
    expect(outcome.result).toContain("Jangan menjanjikan link");
  });

  it("refuses checkout without a name and address", async () => {
    const outcome = await executeTool("create_payment_link", '{"nama":"Budi"}', toolContext);
    expect(outcome.failed).toBe(true);
    expect(outcome.result).toContain("alamat");
  });

  it("reports a missing image honestly instead of claiming it was sent", async () => {
    const outcome = await executeTool("send_image", '{"name":"tidak-ada.jpg"}', toolContext);
    expect(outcome.failed).toBe(true);
    expect(outcome.outbound).toEqual([]);
    expect(outcome.result).toContain("tidak ditemukan");
    expect(outcome.result).toContain("Jangan mengaku sudah mengirim");
  });

  it("sends a real image from R2 as base64 with its content type", async () => {
    // A 1x1 PNG, so the assertion is about the plumbing rather than the pixels.
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await bindings.MEDIA.put("knowledge/images/uji.png", png, { httpMetadata: { contentType: "image/png" } });

    const outcome = await executeTool("send_image", '{"name":"uji.png","caption":"Foto uji"}', toolContext);
    expect(outcome.failed).toBe(false);
    expect(outcome.outbound).toHaveLength(1);
    const image = outcome.outbound[0];
    expect(image?.kind).toBe("image");
    if (image?.kind === "image") {
      expect(image.caption).toBe("Foto uji");
      expect(image.mimeType).toBe("image/png");
      expect(image.image).toBe(btoa(String.fromCharCode(...png)));
    }
  });

  it("reports an unknown tool name", async () => {
    const outcome = await executeTool("hapus_dunia", "{}", toolContext);
    expect(outcome.failed).toBe(true);
    expect(outcome.result).toContain("tidak dikenal");
  });
});
