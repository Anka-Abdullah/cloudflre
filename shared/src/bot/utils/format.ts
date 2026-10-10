/**
 * Formatting helpers shared by the prompt, the tools and the receipt.
 *
 * Rupiah and WIB are the two formats this project must never get wrong: a wrong
 * price string confuses the customer, and a wrong time zone makes a payment
 * deadline meaningless. Both are implemented here once and unit-tested, rather
 * than being re-derived at each call site.
 */

const WIB_OFFSET_MINUTES = 7 * 60;

const HARI = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"] as const;
const BULAN = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
] as const;

/** Shifts a UTC instant into WIB (UTC+7) as a Date whose UTC fields are WIB. */
function toWib(date: Date): Date {
  return new Date(date.getTime() + WIB_OFFSET_MINUTES * 60_000);
}

/**
 * `1400000` → `"Rp 1.400.000"`.
 *
 * Integer rupiah only — no decimals, matching how the catalogue writes prices
 * (`Rp 1.400.000,00` → stored as `1400000`).
 */
export function formatRupiah(value: number): string {
  const rounded = Math.trunc(value);
  const sign = rounded < 0 ? "-" : "";
  const digits = String(Math.abs(rounded));
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ".";
    out += digits[i];
  }
  return `${sign}Rp ${out}`;
}

/** `"Senin, 10 Oktober 2026 17:05 WIB"` — the form the bot speaks to customers. */
export function formatWib(date: Date): string {
  const wib = toWib(date);
  const hari = HARI[wib.getUTCDay()] ?? "";
  const bulan = BULAN[wib.getUTCMonth()] ?? "";
  const jam = String(wib.getUTCHours()).padStart(2, "0");
  const menit = String(wib.getUTCMinutes()).padStart(2, "0");
  return `${hari}, ${wib.getUTCDate()} ${bulan} ${wib.getUTCFullYear()} ${jam}:${menit} WIB`;
}

/** `"2026-10-10 17:05 WIB"` — compact form for logs and receipts. */
export function formatWibShort(date: Date): string {
  const wib = toWib(date);
  const iso = wib.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} WIB`;
}

/** `PAY-20261010-A1B2C3` — order reference in WIB, not UTC. */
export function orderReference(date: Date, suffix: string): string {
  const wib = toWib(date);
  const ymd = wib.toISOString().slice(0, 10).replace(/-/g, "");
  return `PAY-${ymd}-${suffix.toUpperCase()}`;
}

/**
 * Trims text to a character budget on a word boundary, so a truncated catalogue
 * or history entry does not end mid-word and look like a typo to the model.
 */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
