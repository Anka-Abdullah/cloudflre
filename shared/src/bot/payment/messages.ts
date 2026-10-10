/**
 * Customer-facing texts for the checkout/payment flow.
 *
 * All of them live here, in one file, because these are the sentences a customer
 * reads about money. Keeping them out of the state machine means a wording change
 * cannot accidentally change a transition, and the tests can assert the text
 * without driving the whole flow.
 *
 * House rules these strings follow:
 *   - prices always through `formatRupiah` (never a raw number with a dot),
 *   - times always through `formatWib` (the customer is in WIB, the worker is not),
 *   - never promise something the worker cannot do (no "link sudah dikirim"
 *     before the gateway answered).
 */
import type { OrderItemRow, OrderRow } from "./turso";
import { formatRupiah, formatWib } from "../utils/format";

function itemLines(items: readonly OrderItemRow[]): string {
  return items
    .map((item) => `• ${item.namaProduk} x${item.qty} = ${formatRupiah(item.subtotal)}`)
    .join("\n");
}

function totals(order: OrderRow): string[] {
  const lines = [`Total produk: ${formatRupiah(order.totalHarga)}`];
  if (order.additionalFee > 0) lines.push(`Biaya tambahan: ${formatRupiah(order.additionalFee)}`);
  if (order.ongkirIncluded) lines.push("Ongkir: sudah termasuk");
  lines.push(`Total bayar: ${formatRupiah(order.grandTotal)}`);
  return lines;
}

/** Sent right after the order row exists, while the admin decides. */
export function awaitingApprovalMessage(order: OrderRow, items: readonly OrderItemRow[]): string {
  return [
    "Pesanan Kakak sudah kami catat.",
    "",
    `Kode pesanan: ${order.kodePesanan}`,
    itemLines(items),
    "",
    ...totals(order),
    "",
    "Pesanan ini perlu dikonfirmasi admin dulu (ongkir belum termasuk). Mohon tunggu sebentar ya, kami kabari lagi di chat ini.",
  ].join("\n");
}

/** Sent when the payment link is ready. */
export function paymentLinkMessage(
  order: OrderRow,
  items: readonly OrderItemRow[],
  payment: { url: string | null; expiresAt: number | null },
): string {
  const lines = [
    "Pesanan Kakak sudah disetujui.",
    "",
    `Kode pesanan: ${order.kodePesanan}`,
    itemLines(items),
    "",
    ...totals(order),
    "",
  ];
  if (payment.url) {
    lines.push("Silakan bayar melalui link berikut:", payment.url);
  } else {
    lines.push("Link pembayaran akan segera kami kirim.");
  }
  if (payment.expiresAt) lines.push("", `Link berlaku sampai ${formatWib(new Date(payment.expiresAt))}.`);
  return lines.join("\n");
}

export function rejectedMessage(order: OrderRow, reason: string): string {
  return [
    `Mohon maaf, pesanan ${order.kodePesanan} belum bisa kami proses.`,
    reason !== "" ? `Alasan: ${reason}` : "Silakan hubungi admin untuk informasi lebih lanjut.",
  ].join("\n");
}

export function paidMessage(order: OrderRow): string {
  return [
    "Pembayaran kami terima. Terima kasih! 🙏",
    "",
    `Kode pesanan: ${order.kodePesanan}`,
    `Total dibayar: ${formatRupiah(order.grandTotal)}`,
    order.paidAt ? `Waktu: ${formatWib(new Date(order.paidAt))}` : "",
    "",
    "Nota pembayaran kami lampirkan di pesan berikutnya.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function expiredMessage(order: OrderRow): string {
  return [
    `Link pembayaran untuk pesanan ${order.kodePesanan} sudah kedaluwarsa.`,
    "Kalau Kakak masih ingin melanjutkan, balas chat ini dan kami buatkan link baru.",
  ].join("\n");
}

export function failedMessage(order: OrderRow): string {
  return [
    `Pesanan ${order.kodePesanan} gagal diproses karena kendala teknis.`,
    "Admin kami akan menghubungi Kakak untuk menyelesaikannya.",
  ].join("\n");
}

/** Caption for the receipt document. */
export function notaCaption(order: OrderRow): string {
  return `Nota pembayaran ${order.kodePesanan} — ${formatRupiah(order.grandTotal)} (LUNAS)`;
}
