/**
 * Tools the model may call, and their execution.
 *
 * Three rules are enforced here rather than asked for in the prompt, because the
 * prompt is a request and these are guarantees:
 *
 *  - **Prices never come from the model.** `add_to_cart` accepts a code and a
 *    quantity; the price is read from the catalogue and stored by the service.
 *  - **Every code is validated against the catalogue** before it can reach the
 *    cart, so an invented product cannot be added.
 *  - **Every tool result is text guidance**, including failures. The model always
 *    has something to say, so it never has to invent an outcome.
 */
import type { Env, InstanceConfig } from "../../config";
import type { Logger } from "../../lib/logger";
import { findProduct, addItem, readCart, removeItem, cartToPrompt, cartToCustomer, limitsOf } from "../sales/cart.service";
import type { ResolvedProduct } from "../knowledge/catalog";
import type { OutboundMessage } from "../types";
import { formatRupiah } from "../utils/format";
import type { LlmToolDefinition } from "./llm";
import { describeProduct } from "./prompt";

export interface ToolContext {
  env: Pick<Env, "BOT_DB" | "MEDIA" | "R2_PUBLIC_BASE_URL">;
  config: InstanceConfig;
  chatJid: string;
  catalog: readonly ResolvedProduct[];
  now: Date;
  log: Logger;
}

export interface ToolOutcome {
  /** Always non-empty: the string handed back to the model as the tool result. */
  result: string;
  /** Messages the tool wants delivered to the customer, before the final text. */
  outbound: OutboundMessage[];
  /** True when the tool could not do its job. */
  failed: boolean;
}

/** R2 prefix for images uploaded by `pnpm run knowledge`. */
export const IMAGE_PREFIX = "knowledge/images/";

export const TOOL_DEFINITIONS: readonly LlmToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "send_image",
      description:
        "Kirim gambar produk atau brosur ke pelanggan. Gunakan nama berkas yang muncul di penanda [GAMBAR: nama - caption] pada prompt.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Nama berkas gambar, mis. produk_a.jpg" },
          caption: { type: "string", description: "Keterangan singkat yang dikirim bersama gambar" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_to_cart",
      description: "Tambahkan produk ke keranjang pelanggan. Harga diambil sistem dari katalog, bukan dari argumen.",
      parameters: {
        type: "object",
        properties: {
          kode: { type: "string", description: "Kode produk dari KATALOG, mis. 116964" },
          qty: { type: "integer", description: "Jumlah, minimal 1" },
        },
        required: ["kode", "qty"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "view_cart",
      description: "Lihat isi keranjang pelanggan beserta totalnya.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_from_cart",
      description: "Hapus produk dari keranjang, atau kurangi jumlahnya.",
      parameters: {
        type: "object",
        properties: {
          kode: { type: "string", description: "Kode atau nama produk yang ada di keranjang" },
          qty: { type: "integer", description: "Jumlah yang dikurangi; kosongkan untuk menghapus semuanya" },
        },
        required: ["kode"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_payment_link",
      description: "Buat link pembayaran untuk isi keranjang. Butuh nama dan alamat pengiriman pelanggan.",
      parameters: {
        type: "object",
        properties: {
          nama: { type: "string", description: "Nama penerima" },
          alamat: { type: "string", description: "Alamat pengiriman lengkap" },
        },
        required: ["nama", "alamat"],
      },
    },
  },
];

/** Parses the model's argument JSON, tolerating the malformed cases models emit. */
export function parseArguments(raw: string): Record<string, unknown> {
  if (raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asQty(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NaN;
}

/** Encodes bytes for wuzapi's base64 image field without Buffer (not in workerd). */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function sendImage(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> {
  const name = asString(args["name"]);
  const caption = asString(args["caption"]);
  if (name === "") {
    return { result: "send_image gagal: argumen 'name' kosong. Sebutkan nama berkas gambar.", outbound: [], failed: true };
  }

  const key = `${IMAGE_PREFIX}${name.replace(/^\/+/, "")}`;
  // A public bucket URL is far cheaper to send than base64, and wuzapi accepts
  // either, so prefer the URL when the deployment exposes one.
  const publicBase = (context.env.R2_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  if (publicBase !== "") {
    return {
      result: `Gambar ${name} dikirim. Lanjutkan menjawab pelanggan dengan singkat.`,
      outbound: [{ kind: "image", image: `${publicBase}/${key}`, caption }],
      failed: false,
    };
  }

  if (!context.env.MEDIA) {
    return {
      result: "send_image gagal: penyimpanan gambar tidak tersedia. Katakan dengan jujur gambarnya belum bisa dikirim.",
      outbound: [],
      failed: true,
    };
  }

  try {
    const object = await context.env.MEDIA.get(key);
    if (!object) {
      context.log.warn("tool_send_image_missing", { chatJid: context.chatJid, key });
      return {
        result:
          `Gambar "${name}" tidak ditemukan di penyimpanan. ` +
          "Katakan dengan jujur bahwa gambarnya belum bisa dikirim, lalu tawarkan deskripsi teks atau bantuan admin. " +
          "Jangan mengaku sudah mengirim gambar.",
        outbound: [],
        failed: true,
      };
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    return {
      result: `Gambar ${name} dikirim. Lanjutkan menjawab pelanggan dengan singkat.`,
      outbound: [
        {
          kind: "image",
          image: toBase64(bytes),
          caption,
          mimeType: object.httpMetadata?.contentType ?? "image/jpeg",
        },
      ],
      failed: false,
    };
  } catch (error) {
    context.log.error("tool_send_image_failed", { chatJid: context.chatJid, key, error: String(error) });
    return {
      result: "send_image gagal karena kesalahan penyimpanan. Katakan dengan jujur gambarnya belum bisa dikirim.",
      outbound: [],
      failed: true,
    };
  }
}

async function addToCart(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> {
  const db = context.env.BOT_DB;
  if (!db) return { result: "add_to_cart gagal: database tidak tersedia.", outbound: [], failed: true };

  const kode = asString(args["kode"]);
  const qty = asQty(args["qty"]);
  if (kode === "" || !Number.isFinite(qty)) {
    return { result: "add_to_cart gagal: butuh 'kode' dan 'qty' berupa angka.", outbound: [], failed: true };
  }

  const product = findProduct(context.catalog, kode);
  if (!product) {
    return {
      result: `Produk dengan kode "${kode}" tidak ada di katalog. Jangan mengarang produk; tawarkan pilihan yang ada.`,
      outbound: [],
      failed: true,
    };
  }

  const outcome = await addItem(db, {
    chatJid: context.chatJid,
    product,
    qty,
    at: context.now.getTime(),
    limits: limitsOf(context.config),
    catalog: context.catalog,
  });

  if (!outcome.ok) {
    return { result: `add_to_cart ditolak: ${outcome.error}. Keranjang sekarang:\n${cartToPrompt(outcome.view)}`, outbound: [], failed: true };
  }
  return {
    result: `${describeProduct(product)} ditambahkan. Keranjang sekarang:\n${cartToPrompt(outcome.view)}`,
    outbound: [],
    failed: false,
  };
}

async function viewCart(context: ToolContext): Promise<ToolOutcome> {
  const db = context.env.BOT_DB;
  if (!db) return { result: "view_cart gagal: database tidak tersedia.", outbound: [], failed: true };
  const view = await readCart(db, context.chatJid, context.catalog);
  return { result: `Isi keranjang:\n${cartToPrompt(view)}`, outbound: [], failed: false };
}

async function removeFromCart(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> {
  const db = context.env.BOT_DB;
  if (!db) return { result: "remove_from_cart gagal: database tidak tersedia.", outbound: [], failed: true };

  const kode = asString(args["kode"]);
  if (kode === "") return { result: "remove_from_cart gagal: argumen 'kode' kosong.", outbound: [], failed: true };
  const rawQty = args["qty"];
  const qty = rawQty === undefined || rawQty === null ? undefined : asQty(rawQty);
  if (qty !== undefined && !Number.isFinite(qty)) {
    return { result: "remove_from_cart gagal: 'qty' harus berupa angka.", outbound: [], failed: true };
  }

  const outcome = await removeItem(db, {
    chatJid: context.chatJid,
    kode,
    ...(qty === undefined ? {} : { qty }),
    at: context.now.getTime(),
    catalog: context.catalog,
  });
  if (!outcome.ok) {
    return { result: `remove_from_cart ditolak: ${outcome.error}.`, outbound: [], failed: true };
  }
  return { result: `${outcome.note}. Keranjang sekarang:\n${cartToPrompt(outcome.view)}`, outbound: [], failed: false };
}

/**
 * Checkout. Deliberately NOT implemented in FASE 3: it needs the Turso order
 * tables, the Sumopod adapter and the Telegram approval card (FASE 5). Returning
 * a clear "not yet" keeps the model honest instead of letting it promise a link.
 */
async function createPaymentLink(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> {
  const nama = asString(args["nama"]);
  const alamat = asString(args["alamat"]);
  if (nama === "" || alamat === "") {
    return { result: "create_payment_link gagal: butuh 'nama' dan 'alamat' pelanggan.", outbound: [], failed: true };
  }
  context.log.warn("tool_checkout_not_available", { chatJid: context.chatJid, reason: "FASE 5 belum dikerjakan" });
  return {
    result:
      "create_payment_link BELUM tersedia di tahap ini. Jangan menjanjikan link pembayaran. " +
      "Katakan bahwa pesanan akan diproses admin, lalu rangkum pesanan dan minta konfirmasi alamat.",
    outbound: [],
    failed: true,
  };
}

/** Executes one tool call. Never throws: a failure becomes text guidance. */
export async function executeTool(name: string, rawArguments: string, context: ToolContext): Promise<ToolOutcome> {
  const args = parseArguments(rawArguments);
  context.log.info("tool_call", { chatJid: context.chatJid, tool: name });

  try {
    switch (name) {
      case "send_image":
        return await sendImage(args, context);
      case "add_to_cart":
        return await addToCart(args, context);
      case "view_cart":
        return await viewCart(context);
      case "remove_from_cart":
        return await removeFromCart(args, context);
      case "create_payment_link":
        return await createPaymentLink(args, context);
      default:
        return { result: `Tool "${name}" tidak dikenal.`, outbound: [], failed: true };
    }
  } catch (error) {
    context.log.error("tool_crashed", { tool: name, error: String(error) });
    return { result: `Tool ${name} gagal karena kesalahan internal.`, outbound: [], failed: true };
  }
}

/** Customer-facing cart text, used by the agent when the model only says "lihat keranjang". */
export function renderCartForCustomer(view: Parameters<typeof cartToCustomer>[0]): string {
  return cartToCustomer(view, formatRupiah);
}
