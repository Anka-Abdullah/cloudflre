/**
 * The admin approval card: text, buttons, and the two parsers that make the
 * round trip safe.
 *
 * Everything here is pure text in / plain data out, so it can be unit tested
 * without Telegram and reused by the `/admin/orders/*` routes (which are the
 * fallback path when `TELEGRAM_ENABLED=false`).
 *
 * Two constraints decided the shapes below:
 *
 *  - **`callback_data` is limited to 64 bytes.** The order reference and the verb
 *    have to fit, so the format is `o:<kode>:<a|r|f>` — no JSON, no spaces.
 *  - **No `parse_mode` by default.** A customer name containing `_` or `*` would
 *    make `MarkdownV2` reject the whole message ("can't parse entities"), and a
 *    card that never arrives is worse than a card without bold text. Plain text is
 *    always accepted; the operator UI is a terminal-looking message on purpose.
 *
 * The fee is typed as a reply rather than chosen from buttons, because the admin
 * decides the amount — but it is still parsed into an integer number of rupiah
 * here (`parseFeeAmount`), never trusted as a string.
 */
import type { OrderItemRow, OrderRow } from "../payment/turso";
import { formatRupiah, formatWib } from "../utils/format";

export type CardAction = "approve" | "reject" | "fee";

const ACTION_CODES: Record<CardAction, string> = { approve: "a", reject: "r", fee: "f" };
const CODE_ACTIONS: Record<string, CardAction> = { a: "approve", r: "reject", f: "fee" };

export function callbackData(kodePesanan: string, action: CardAction): string {
  return `o:${kodePesanan}:${ACTION_CODES[action]}`;
}

/** Returns null for anything that is not one of our own buttons. */
export function parseCallbackData(data: string): { kodePesanan: string; action: CardAction } | null {
  const parts = data.split(":");
  if (parts.length !== 3) return null;
  const [prefix, kodePesanan, code] = parts as [string, string, string];
  if (prefix !== "o" || kodePesanan === "") return null;
  const action = CODE_ACTIONS[code];
  return action ? { kodePesanan, action } : null;
}

export interface CardInput {
  order: OrderRow;
  items: readonly OrderItemRow[];
  /** Customer's display name, when the pipeline knows it. */
  pushName?: string;
}

function itemLines(items: readonly OrderItemRow[]): string {
  if (items.length === 0) return "• (tidak ada item)";
  return items
    .map((item) => `• ${item.namaProduk} (${item.kode}) x${item.qty} @ ${formatRupiah(item.harga)} = ${formatRupiah(item.subtotal)}`)
    .join("\n");
}

/** What the admin reads before pressing a button. */
export function renderApprovalCard(input: CardInput): string {
  const { order, items } = input;
  const lines = [
    "PESANAN BARU — MENUNGGU PERSETUJUAN",
    "",
    `Kode pesanan : ${order.kodePesanan}`,
    `Referensi    : ${order.ref}`,
    `Pelanggan    : ${input.pushName && input.pushName !== "" ? input.pushName : "(tanpa nama)"}`,
    `Chat         : ${order.waChatJid}`,
    `Alamat       : ${order.alamatKirim}`,
    "",
    "Item:",
    itemLines(items),
    "",
    `Total produk : ${formatRupiah(order.totalHarga)}`,
    `Ongkir       : ${order.ongkirIncluded ? "sudah termasuk" : "belum termasuk — perlu keputusan admin"}`,
    `Biaya tambahan: ${formatRupiah(order.additionalFee)}`,
    `Grand total  : ${formatRupiah(order.grandTotal)}`,
    "",
    `Dibuat       : ${formatWib(new Date(order.createdAt))}`,
  ];
  return lines.join("\n");
}

export function approvalKeyboard(kodePesanan: string): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  return {
    inline_keyboard: [
      [
        { text: "✅ Terima", callback_data: callbackData(kodePesanan, "approve") },
        { text: "❌ Tolak", callback_data: callbackData(kodePesanan, "reject") },
      ],
      [{ text: "💰 Ubah Biaya", callback_data: callbackData(kodePesanan, "fee") }],
    ],
  };
}

/** The card after the admin decided; buttons are dropped so it cannot be pressed twice. */
export function renderDecidedCard(input: CardInput & { decision: "approved" | "rejected"; reason?: string }): string {
  const head =
    input.decision === "approved"
      ? "PESANAN DISETUJUI"
      : "PESANAN DITOLAK";
  const lines = [
    head,
    "",
    `Kode pesanan : ${input.order.kodePesanan}`,
    `Pelanggan    : ${input.order.waChatJid}`,
    `Grand total  : ${formatRupiah(input.order.grandTotal)}`,
  ];
  if (input.decision === "approved" && input.order.additionalFee > 0) {
    lines.push(`Biaya tambahan: ${formatRupiah(input.order.additionalFee)}`);
  }
  if (input.reason && input.reason !== "") lines.push(`Alasan       : ${input.reason}`);
  lines.push("", `Diputuskan   : ${formatWib(new Date())}`);
  return lines.join("\n");
}

/** Asked with `force_reply`, so the admin's answer arrives as a reply to this message. */
export function renderFeePrompt(order: OrderRow): string {
  return [
    `Ubah biaya untuk ${order.kodePesanan}`,
    "",
    `Total produk : ${formatRupiah(order.totalHarga)}`,
    `Biaya tambahan saat ini: ${formatRupiah(order.additionalFee)}`,
    `Grand total  : ${formatRupiah(order.grandTotal)}`,
    "",
    "Balas pesan ini dengan angka biaya tambahan (rupiah), mis. 25000.",
    "Kirim 0 untuk menghapus biaya tambahan.",
  ].join("\n");
}

/**
 * Parses the admin's fee reply into an integer number of rupiah.
 *
 * Accepts `25000`, `25.000`, `Rp 25.000`, `25,000` and `25000,00` — the shapes a
 * human actually types — and refuses anything else, so a typo cannot silently
 * become a wrong charge. Returns null rather than 0 so the caller can tell
 * "unreadable" from "no extra fee".
 */
export function parseFeeAmount(text: string): number | null {
  const cleaned = text.trim().replace(/^rp\.?\s*/i, "").replace(/\s/g, "");
  if (cleaned === "") return null;
  const normalised = cleaned.replace(/[.,](?=\d{3}\b)/g, "").replace(/,00$/, "").replace(/\.00$/, "");
  if (!/^\d+$/.test(normalised)) return null;
  const value = Number(normalised);
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000_000) return null;
  return Math.trunc(value);
}
