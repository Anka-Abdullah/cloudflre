/**
 * The receipt ("nota") — a PDF built with `pdf-lib`, with a plain-text fallback.
 *
 * Rules taken from the frozen format (`docs/wuzip-bot-architecture.txt` section
 * 6j): title "NOTA PEMBAYARAN", receipt number (`PAY…`) and order code (`INV…`),
 * payment time in WIB, customer name/WA/address, a Produk | Qty | Harga | Subtotal
 * table, subtotal + additional fee + "Ongkir: sudah termasuk" when it applies,
 * the total, the payment method, "Dibayar <WIB>", and "Status: LUNAS".
 *
 * Two failure modes are handled here rather than by the caller:
 *
 *  - **Encoding.** The standard PDF fonts are WinAnsi, so an emoji or a typographic
 *    dash in a customer name would make `drawText` throw. Every string goes
 *    through `sanitise()` first.
 *  - **Any render failure.** `buildNotaDocument` falls back to a text document, so
 *    a customer who paid always receives *something* — a receipt they can read
 *    beats a stack trace.
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { OrderItemRow, OrderRow } from "../payment/turso";
import type { OutboundMessage } from "../types";
import { formatRupiah, formatWib } from "../utils/format";

export interface NotaInput {
  order: OrderRow;
  items: readonly OrderItemRow[];
  customer?: { nama?: string | null; noHp?: string | null; alamat?: string | null } | null;
  /** Overrides the order's `paid_at` (used by tests). */
  paidAt?: Date;
  /** Shop name for the header; empty prints no header line. */
  businessName?: string;
}

/** Receipt number shown to the customer, derived from the order reference. */
export function notaNumber(order: Pick<OrderRow, "ref">): string {
  return order.ref.replace(/^PAY-/, "NOTA-");
}

export function notaFileName(order: Pick<OrderRow, "ref">): string {
  return `Nota-${order.ref}.pdf`;
}

const REPLACEMENTS: Array<[RegExp, string]> = [
  [/[\u2018\u2019\u201A\u201B]/g, "'"],
  [/[\u201C\u201D\u201E]/g, '"'],
  [/[\u2013\u2014\u2015]/g, "-"],
  [/[\u2022\u25CF\u25AA]/g, "-"],
  [/[\u2026]/g, "..."],
  [/[\u00A0\u2007\u202F]/g, " "],
  [/[\u00B7]/g, "-"],
];

/**
 * Makes a string safe for the standard PDF fonts: ASCII plus the Latin-1 range
 * WinAnsi actually encodes. Emoji and other astral characters are dropped, not
 * turned into "?" — a missing emoji is invisible, a row of question marks is not.
 */
export function sanitise(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REPLACEMENTS) out = out.replace(pattern, replacement);
  out = out.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "");
  out = out.replace(/[^\x09\x0A\x0D\x20-\x7E\u00A1-\u00FF]/g, "");
  return out;
}

function money(value: number): string {
  // `formatRupiah` already avoids decimals; sanitising here keeps the PDF safe
  // even if a caller passes something unexpected.
  return sanitise(formatRupiah(value));
}

/** The plain-text receipt: the fallback, and the body of the log line. */
export function renderNotaText(input: NotaInput): string {
  const { order, items } = input;
  const paidAt = input.paidAt ?? (order.paidAt ? new Date(order.paidAt) : new Date());
  const lines: string[] = [];
  if (input.businessName) lines.push(input.businessName, "");
  lines.push(
    "NOTA PEMBAYARAN",
    `Nomor nota   : ${notaNumber(order)}`,
    `Kode pesanan : ${order.kodePesanan}`,
    `Tanggal      : ${formatWib(paidAt)}`,
    "",
    `Nama         : ${input.customer?.nama ?? "-"}`,
    `WhatsApp     : ${input.customer?.noHp ?? order.waChatJid}`,
    `Alamat       : ${input.customer?.alamat ?? order.alamatKirim}`,
    "",
    "Produk | Qty | Harga | Subtotal",
  );
  for (const item of items) {
    lines.push(`${item.namaProduk} | ${item.qty} | ${formatRupiah(item.harga)} | ${formatRupiah(item.subtotal)}`);
  }
  lines.push(
    "",
    `Subtotal     : ${formatRupiah(order.totalHarga)}`,
  );
  if (order.additionalFee > 0) lines.push(`Biaya tambahan: ${formatRupiah(order.additionalFee)}`);
  if (order.ongkirIncluded) lines.push("Ongkir       : sudah termasuk");
  lines.push(
    `Total        : ${formatRupiah(order.grandTotal)}`,
    "",
    "Metode       : QRIS",
    `Dibayar      : ${formatWib(paidAt)}`,
    "Status       : LUNAS",
    "",
    "Terima kasih telah berbelanja.",
  );
  return lines.join("\n");
}

/** Renders the receipt PDF. Throws only if pdf-lib itself fails. */
export async function renderNotaPdf(input: NotaInput): Promise<Uint8Array> {
  const { order, items } = input;
  const paidAt = input.paidAt ?? (order.paidAt ? new Date(order.paidAt) : new Date());

  const pdf = await PDFDocument.create();
  pdf.setTitle(sanitise(`Nota ${order.kodePesanan}`));
  pdf.setSubject("Nota pembayaran");
  pdf.setCreator("wuzip-bot");
  pdf.setCreationDate(paidAt);

  let page = pdf.addPage([595.28, 841.89]); // A4 in points
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const margin = 48;
  let y = 841.89 - margin;
  const black = rgb(0.1, 0.1, 0.1);

  const write = (text: string, options: { size?: number; bold?: boolean; gap?: number } = {}): void => {
    const size = options.size ?? 10;
    page.drawText(sanitise(text), {
      x: margin,
      y,
      size,
      font: options.bold ? bold : font,
      color: black,
    });
    y -= size + (options.gap ?? 4);
  };

  const right = (label: string, value: string, options: { bold?: boolean } = {}): void => {
    const size = 10;
    const valueText = sanitise(value);
    const width = (options.bold ? bold : font).widthOfTextAtSize(valueText, size);
    page.drawText(sanitise(label), { x: margin, y, size, font, color: black });
    page.drawText(valueText, { x: 595.28 - margin - width, y, size, font: options.bold ? bold : font, color: black });
    y -= size + 4;
  };

  if (input.businessName) {
    write(input.businessName, { size: 12, bold: true, gap: 10 });
  }
  write("NOTA PEMBAYARAN", { size: 18, bold: true, gap: 10 });
  write(`Nomor nota    : ${notaNumber(order)}`);
  write(`Kode pesanan  : ${order.kodePesanan}`);
  write(`Tanggal       : ${formatWib(paidAt)}`, { gap: 12 });

  write("Pelanggan", { bold: true, gap: 6 });
  write(`Nama          : ${input.customer?.nama ?? "-"}`);
  write(`WhatsApp      : ${input.customer?.noHp ?? order.waChatJid}`);
  write(`Alamat        : ${input.customer?.alamat ?? order.alamatKirim}`, { gap: 14 });

  write("Rincian", { bold: true, gap: 6 });
  const columns = { qty: 300, harga: 390, subtotal: 500 };
  page.drawText("Produk", { x: margin, y, size: 10, font: bold, color: black });
  page.drawText("Qty", { x: columns.qty, y, size: 10, font: bold, color: black });
  page.drawText("Harga", { x: columns.harga, y, size: 10, font: bold, color: black });
  page.drawText("Subtotal", { x: columns.subtotal, y, size: 10, font: bold, color: black });
  y -= 14;

  for (const item of items) {
    const name = sanitise(item.namaProduk).slice(0, 42);
    page.drawText(name, { x: margin, y, size: 10, font, color: black });
    page.drawText(String(item.qty), { x: columns.qty, y, size: 10, font, color: black });
    page.drawText(money(item.harga), { x: columns.harga, y, size: 10, font, color: black });
    page.drawText(money(item.subtotal), { x: columns.subtotal, y, size: 10, font, color: black });
    y -= 14;
    if (y < 160) {
      // A long basket must not overflow the page silently: the totals would be
      // cut off, and a receipt without a total is not a receipt.
      page = pdf.addPage([595.28, 841.89]);
      y = 841.89 - margin;
    }
  }

  y -= 6;
  right("Subtotal", formatRupiah(order.totalHarga));
  if (order.additionalFee > 0) right("Biaya tambahan", formatRupiah(order.additionalFee));
  if (order.ongkirIncluded) right("Ongkir", "sudah termasuk");
  y -= 4;
  right("Total", formatRupiah(order.grandTotal), { bold: true });

  y -= 10;
  write(`Metode        : ${order.paymentUrl ? "QRIS" : "QRIS"}`);
  write(`Dibayar       : ${formatWib(paidAt)}`);
  write("Status        : LUNAS", { bold: true, gap: 16 });
  write("Terima kasih telah berbelanja.");

  return await pdf.save({ useObjectStreams: false });
}

function safeFileName(order: Partial<OrderRow>): string {
  try {
    return notaFileName(order as OrderRow).replace(/\.pdf$/, ".txt");
  } catch {
    return "Nota.txt";
  }
}

/** `renderNotaText` that cannot throw, whatever the order object looks like. */
function safeNotaText(input: NotaInput): string {
  try {
    return renderNotaText(input);
  } catch {
    const kode = typeof input.order?.kodePesanan === "string" ? input.order.kodePesanan : "(tanpa kode)";
    const total = typeof input.order?.grandTotal === "number" ? formatRupiah(input.order.grandTotal) : "-";
    return ["NOTA PEMBAYARAN", `Kode pesanan : ${kode}`, `Total        : ${total}`, "Status       : LUNAS"].join("\n");
  }
}

/** base64 without Node's Buffer (not available in workerd). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export interface NotaDocument {
  message: OutboundMessage;
  /** `pdf` when the renderer worked, `text` when it fell back. */
  kind: "pdf" | "text";
  bytes: number;
}

/**
 * Builds the outbound document for a paid order, falling back to text.
 *
 * The fallback is not a cosmetic nicety: the receipt is the customer's proof of
 * payment, so "the PDF library threw" must never mean silence.
 */
export async function buildNotaDocument(input: NotaInput, caption: string): Promise<NotaDocument> {
  try {
    const bytes = await renderNotaPdf(input);
    return {
      kind: "pdf",
      bytes: bytes.byteLength,
      message: {
        kind: "document",
        document: bytesToBase64(bytes),
        fileName: notaFileName(input.order),
        caption,
        mimeType: "application/pdf",
      },
    };
  } catch (error) {
    // The fallback must not be able to fail: it is the customer's proof of
    // payment, and the renderer already failed once. So each step degrades:
    // full text → minimal text → a single line.
    const text = safeNotaText(input);
    void error;
    return {
      kind: "text",
      bytes: text.length,
      message: {
        kind: "document",
        document: bytesToBase64(new TextEncoder().encode(text)),
        fileName: safeFileName(input.order),
        caption,
        mimeType: "text/plain; charset=utf-8",
      },
    };
  }
}
