/**
 * Cart state for one chat.
 *
 * The rule that shapes this file: **the price never comes from the caller**. Both
 * `addItem` and `updateItem` look the price up in the catalogue and store that
 * value; a `harga` argument is not accepted from the model at all (work order:
 * "harga tidak pernah dari argumen LLM"). A model that hallucinates a discount
 * therefore cannot change what the customer is charged.
 *
 * Limits (`BOT_MAX_ITEMS`, `BOT_MAX_ITEM_QTY`) are enforced here rather than in
 * the tool, so the DB and the tool agree on what a valid cart is.
 */
import type { InstanceConfig } from "../../config";
import type { ResolvedProduct } from "../knowledge/catalog";

export interface CartLine {
  kode: string;
  nama: string;
  qty: number;
  /** Integer rupiah, always read from the catalogue. */
  unitPrice: number;
  subtotal: number;
}

export interface CartView {
  chatJid: string;
  status: "active" | "converted" | "expired";
  lines: CartLine[];
  total: number;
  itemCount: number;
}

export type CartOutcome =
  | { ok: true; view: CartView; note: string }
  | { ok: false; error: string; view: CartView };

export async function readCart(db: D1Database, chatJid: string, catalog: readonly ResolvedProduct[]): Promise<CartView> {
  const cart = await db
    .prepare("SELECT status FROM carts WHERE chat_jid = ?")
    .bind(chatJid)
    .first<{ status: string }>();
  const rows = await db
    .prepare("SELECT kode, qty, unit_price FROM cart_items WHERE chat_jid = ? ORDER BY updated_at, kode")
    .bind(chatJid)
    .all<{ kode: string; qty: number; unit_price: number }>();

  const byCode = new Map(catalog.map((product) => [product.kode, product]));
  const lines: CartLine[] = rows.results.map((row) => ({
    kode: row.kode,
    // Prefer the catalogue's current name; fall back to the code if the product
    // has since left the catalogue (the line is kept so the customer sees it).
    nama: byCode.get(row.kode)?.nama ?? row.kode,
    qty: row.qty,
    unitPrice: row.unit_price,
    subtotal: row.qty * row.unit_price,
  }));

  return {
    chatJid,
    status: (cart?.status as CartView["status"] | undefined) ?? "active",
    lines,
    total: lines.reduce((sum, line) => sum + line.subtotal, 0),
    itemCount: lines.length,
  };
}

/** Finds a catalogue entry by exact code, or by a case-insensitive name match. */
export function findProduct(catalog: readonly ResolvedProduct[], query: string): ResolvedProduct | null {
  const needle = query.trim().toLowerCase();
  if (needle === "") return null;
  const exact = catalog.find((product) => product.kode.toLowerCase() === needle);
  if (exact) return exact;
  const byName = catalog.find((product) => product.nama.toLowerCase() === needle);
  if (byName) return byName;
  // Last resort: a unique name fragment, so "castelli entrata" finds the product
  // without letting an ambiguous fragment pick a random one.
  const partial = catalog.filter((product) => product.nama.toLowerCase().includes(needle));
  return partial.length === 1 ? (partial[0] ?? null) : null;
}

export interface CartLimits {
  maxItems: number;
  maxItemQty: number;
}

export function limitsOf(config: InstanceConfig): CartLimits {
  return { maxItems: config.bot.maxItems, maxItemQty: config.bot.maxItemQty };
}

/** Adds `qty` of one product, or increases the existing line. */
export async function addItem(
  db: D1Database,
  input: { chatJid: string; product: ResolvedProduct; qty: number; at: number; limits: CartLimits; catalog: readonly ResolvedProduct[] },
): Promise<CartOutcome> {
  const { chatJid, product, at, limits } = input;
  const qty = Math.trunc(input.qty);
  const before = await readCart(db, chatJid, input.catalog);

  if (!Number.isFinite(qty) || qty <= 0) {
    return { ok: false, error: "qty harus lebih dari 0", view: before };
  }
  if (qty > limits.maxItemQty) {
    return { ok: false, error: `maksimal ${limits.maxItemQty} pcs per produk`, view: before };
  }

  const existing = before.lines.find((line) => line.kode === product.kode);
  const nextQty = (existing?.qty ?? 0) + qty;
  if (nextQty > limits.maxItemQty) {
    return { ok: false, error: `total ${product.nama} melebihi ${limits.maxItemQty} pcs`, view: before };
  }
  if (!existing && before.lines.length >= limits.maxItems) {
    return { ok: false, error: `keranjang sudah berisi ${limits.maxItems} produk`, view: before };
  }

  await db.batch([
    db
      .prepare(
        `INSERT INTO carts (chat_jid, status, total, updated_at) VALUES (?, 'active', 0, ?)
         ON CONFLICT (chat_jid) DO UPDATE SET status = 'active', updated_at = excluded.updated_at`,
      )
      .bind(chatJid, at),
    db
      .prepare(
        `INSERT INTO cart_items (chat_jid, kode, qty, unit_price, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (chat_jid, kode) DO UPDATE SET
           qty = excluded.qty,
           unit_price = excluded.unit_price,
           updated_at = excluded.updated_at`,
      )
      // unit_price comes from the catalogue, never from the caller.
      .bind(chatJid, product.kode, nextQty, product.harga, at),
  ]);

  const view = await readCart(db, chatJid, input.catalog);
  await db.prepare("UPDATE carts SET total = ?, updated_at = ? WHERE chat_jid = ?").bind(view.total, at, chatJid).run();
  return { ok: true, view, note: `${product.nama} x${qty} ditambahkan` };
}

/** Removes a line, or reduces it when `qty` is given. */
export async function removeItem(
  db: D1Database,
  input: { chatJid: string; kode: string; qty?: number; at: number; catalog: readonly ResolvedProduct[] },
): Promise<CartOutcome> {
  const { chatJid, kode, at } = input;
  const before = await readCart(db, chatJid, input.catalog);
  const line = before.lines.find((entry) => entry.kode.toLowerCase() === kode.trim().toLowerCase() || entry.nama.toLowerCase() === kode.trim().toLowerCase());
  if (!line) return { ok: false, error: `${kode} tidak ada di keranjang`, view: before };

  const reduceBy = input.qty === undefined ? line.qty : Math.trunc(input.qty);
  if (!Number.isFinite(reduceBy) || reduceBy <= 0) {
    return { ok: false, error: "qty harus lebih dari 0", view: before };
  }

  const remaining = line.qty - reduceBy;
  if (remaining > 0) {
    await db
      .prepare("UPDATE cart_items SET qty = ?, updated_at = ? WHERE chat_jid = ? AND kode = ?")
      .bind(remaining, at, chatJid, line.kode)
      .run();
  } else {
    await db.prepare("DELETE FROM cart_items WHERE chat_jid = ? AND kode = ?").bind(chatJid, line.kode).run();
  }

  const view = await readCart(db, chatJid, input.catalog);
  await db.prepare("UPDATE carts SET total = ?, updated_at = ? WHERE chat_jid = ?").bind(view.total, at, chatJid).run();
  return {
    ok: true,
    view,
    note: remaining > 0 ? `${line.nama} dikurangi menjadi ${remaining}` : `${line.nama} dihapus dari keranjang`,
  };
}

export async function clearCart(db: D1Database, chatJid: string, at: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM cart_items WHERE chat_jid = ?").bind(chatJid),
    db.prepare("UPDATE carts SET status = 'converted', total = 0, updated_at = ? WHERE chat_jid = ?").bind(at, chatJid),
  ]);
}

/** Cart as plain text for the prompt: compact, and no formatting the model must undo. */
export function cartToPrompt(view: CartView): string {
  if (view.lines.length === 0) return "(keranjang kosong)";
  const lines = view.lines.map(
    (line) => `- ${line.nama} (${line.kode}) x${line.qty} @ ${line.unitPrice} = ${line.subtotal}`,
  );
  lines.push(`Total: ${view.total}`);
  return lines.join("\n");
}

/** Cart as the customer reads it: rupiah formatted, ready to send as-is. */
export function cartToCustomer(view: CartView, formatRupiah: (value: number) => string): string {
  if (view.lines.length === 0) return "Keranjang masih kosong.";
  const lines = view.lines.map(
    (line) => `• ${line.nama}\n   ${line.qty} x ${formatRupiah(line.unitPrice)} = ${formatRupiah(line.subtotal)}`,
  );
  lines.push(`\nTotal: ${formatRupiah(view.total)}`);
  return lines.join("\n");
}
