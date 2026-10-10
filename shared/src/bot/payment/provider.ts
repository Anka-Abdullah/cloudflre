/**
 * Payment providers behind one interface.
 *
 * Three implementations, and the reason each exists:
 *
 *   DryRunProvider   `PAYMENT_DRY_RUN=true` (the default). Builds
 *                    `{PUBLIC_BASE_URL}/dry-run/<kode_bayar>` and never calls a
 *                    gateway, so the whole checkout → approval → paid → receipt
 *                    path is testable end to end without a merchant account.
 *   MockProvider     tests: records calls, can fail on purpose, never touches the
 *                    network. Lets a test assert "the gateway was called exactly
 *                    once" without a stub server.
 *   SumopodAdapter   the real gateway. Present and wired, but **not used while
 *                    `PAYMENT_DRY_RUN=true`** and not verified against the live
 *                    API (no key yet) — its endpoint paths are configuration
 *                    (`PAYMENT_CREATE_PATH`, `PAYMENT_STATUS_PATH`) precisely so
 *                    the first live test does not need a code change.
 *
 * The callback side is separated from the create side on purpose: a signature
 * check that fails must not be able to create anything, and `verifyCallback` is
 * the only place the shared secret is used.
 */
import type { Logger } from "../../lib/logger";
import { hmacSha256Hex, timingSafeEqualString } from "../../lib/hmac";

export interface PaymentCustomer {
  nama: string;
  noHp?: string | null;
  email?: string | null;
}

export interface PaymentLinkInput {
  kodeBayar: string;
  orderRef: string;
  kodePesanan: string;
  /** Integer rupiah. */
  amount: number;
  description: string;
  customer: PaymentCustomer;
  expiresAt: number;
  callbackUrl: string;
}

export type PaymentLinkResult =
  | { ok: true; url: string; providerRef: string; metode: string; raw: unknown }
  | { ok: false; error: string; permanent: boolean };

export type CallbackStatus = "paid" | "expired" | "failed" | "unknown";

export interface PaymentCallbackPayload {
  /** Which payment row this is about; `null` when the payload did not say. */
  kodeBayar: string | null;
  orderRef: string | null;
  status: CallbackStatus;
  /** Integer rupiah when the gateway said how much was paid. */
  amount: number | null;
  providerRef: string | null;
  metode: string | null;
  /** Epoch ms when the gateway said it was paid. */
  paidAt: number | null;
  raw: unknown;
}

export interface PaymentStatusResult {
  ok: boolean;
  status: CallbackStatus;
  amount?: number | null;
  providerRef?: string | null;
  metode?: string | null;
  paidAt?: number | null;
  raw?: unknown;
  error: string;
}

export interface QueryStatusInput {
  kodeBayar: string;
  providerRef: string | null;
}

export interface PaymentProvider {
  readonly name: string;
  readonly dryRun: boolean;
  createLink(input: PaymentLinkInput): Promise<PaymentLinkResult>;
  /** True when the request really came from the gateway. */
  verifyCallback(rawBody: string, headers: Headers): Promise<boolean>;
  parseCallback(rawBody: string): PaymentCallbackPayload | null;
  /**
   * Asks the gateway what actually happened to a payment. Used by the
   * reconciliation cron to catch a callback that never arrived; a provider
   * without a status API answers `status: "unknown"` and the job leaves the
   * order alone.
   */
  queryStatus(input: QueryStatusInput): Promise<PaymentStatusResult>;
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

/**
 * The dry-run provider: no network, deterministic URL, and the URL points at a
 * page served by this same Worker (see `payment/dry-run.ts`).
 */
export class DryRunProvider implements PaymentProvider {
  readonly name = "dry-run";
  readonly dryRun = true;

  constructor(private readonly publicBaseUrl: string) {}

  async createLink(input: PaymentLinkInput): Promise<PaymentLinkResult> {
    const base = this.publicBaseUrl.replace(/\/+$/, "");
    const url = base === "" ? `/dry-run/${input.kodeBayar}` : `${base}/dry-run/${input.kodeBayar}`;
    return { ok: true, url, providerRef: `dryrun-${input.kodeBayar}`, metode: "qris", raw: { dryRun: true, url } };
  }

  async verifyCallback(): Promise<boolean> {
    // The dry-run page does not call back over HTTP: it enqueues a payment.event
    // itself (it is the same Worker), so there is no signature to verify.
    return false;
  }

  parseCallback(rawBody: string): PaymentCallbackPayload | null {
    return parseGenericCallback(rawBody);
  }

  async queryStatus(): Promise<PaymentStatusResult> {
    // A dry-run payment is settled by the page, never by a gateway, so there is
    // nothing to reconcile.
    return { ok: false, status: "unknown", error: "dry-run tidak punya status gateway" };
  }
}

// ---------------------------------------------------------------------------
// Mock (tests)
// ---------------------------------------------------------------------------

export interface MockProviderOptions {
  /** Fixed URL prefix; the kode_bayar is appended. */
  urlPrefix?: string;
  failWith?: { error: string; permanent: boolean };
  /** Test seam: observe the calls the worker made. */
  onCall?: (input: PaymentLinkInput) => void;
  /** What `queryStatus` should answer; omitted means "unknown". */
  status?: Partial<PaymentStatusResult>;
  /** Test seam: observe the status queries. */
  onQuery?: (input: QueryStatusInput) => void;
}

export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock";
  readonly dryRun = false;
  readonly calls: PaymentLinkInput[] = [];
  readonly callbacks: string[] = [];

  constructor(private readonly options: MockProviderOptions = {}) {}

  async createLink(input: PaymentLinkInput): Promise<PaymentLinkResult> {
    this.calls.push(input);
    this.options.onCall?.(input);
    if (this.options.failWith) return { ok: false, ...this.options.failWith };
    const prefix = (this.options.urlPrefix ?? "https://mock-pay.test/checkout").replace(/\/+$/, "");
    return {
      ok: true,
      url: `${prefix}/${input.kodeBayar}`,
      providerRef: `mock-${input.kodeBayar}`,
      metode: "qris",
      raw: { mock: true, amount: input.amount },
    };
  }

  async verifyCallback(rawBody: string): Promise<boolean> {
    this.callbacks.push(rawBody);
    return true;
  }

  parseCallback(rawBody: string): PaymentCallbackPayload | null {
    return parseGenericCallback(rawBody);
  }

  async queryStatus(input: QueryStatusInput): Promise<PaymentStatusResult> {
    this.options.onQuery?.(input);
    return { ok: true, status: "unknown", error: "", ...this.options.status };
  }
}

// ---------------------------------------------------------------------------
// Sumopod
// ---------------------------------------------------------------------------

export interface SumopodOptions {
  apiBase: string;
  apiKey: string;
  callbackSecret: string;
  createPath: string;
  statusPath: string;
  timeoutMs?: number;
  log?: Logger;
  fetchImpl?: typeof fetch;
}

/** Header names providers use for the callback signature, checked in order. */
const SIGNATURE_HEADERS = ["x-callback-signature", "x-signature", "x-sumopod-signature", "x-payment-signature"];

export class SumopodAdapter implements PaymentProvider {
  readonly name = "sumopod";
  readonly dryRun = false;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SumopodOptions) {
    this.fetchImpl = (options.fetchImpl ?? fetch).bind(globalThis);
  }

  async createLink(input: PaymentLinkInput): Promise<PaymentLinkResult> {
    if (this.options.apiBase === "" || this.options.apiKey === "") {
      return { ok: false, error: "PAYMENT_API_BASE / PAYMENT_API_KEY belum diisi", permanent: true };
    }

    const url = `${this.options.apiBase}${this.options.createPath}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          reference: input.orderRef,
          kode_bayar: input.kodeBayar,
          amount: input.amount,
          description: input.description,
          callback_url: input.callbackUrl,
          expires_at: new Date(input.expiresAt).toISOString(),
          customer: {
            nama: input.customer.nama,
            no_hp: input.customer.noHp ?? null,
            email: input.customer.email ?? null,
          },
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), permanent: false };
    }

    const text = await response.text().catch(() => "");
    let payload: unknown = null;
    try {
      payload = text === "" ? null : JSON.parse(text);
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const message = extractError(payload) ?? `HTTP ${response.status}`;
      return { ok: false, error: message, permanent: response.status < 500 && response.status !== 429 };
    }

    const data = unwrapData(payload);
    const link = firstString(data, ["payment_url", "url", "checkout_url", "link", "redirect_url"]);
    const providerRef = firstString(data, ["id", "payment_id", "reference", "provider_ref", "trx_id"]);
    if (!link) return { ok: false, error: "gateway tidak mengembalikan URL pembayaran", permanent: true };

    return {
      ok: true,
      url: link,
      providerRef: providerRef ?? input.kodeBayar,
      metode: firstString(data, ["metode", "method", "payment_method"]) ?? "qris",
      raw: payload,
    };
  }

  /**
   * HMAC-SHA256 of the raw body, hex, compared in constant time.
   *
   * The secret is required: with `PAYMENT_CALLBACK_SECRET` empty the worker must
   * refuse the callback rather than accept an unsigned one, because "paid" is the
   * state that ships goods.
   */
  async verifyCallback(rawBody: string, headers: Headers): Promise<boolean> {
    if (this.options.callbackSecret === "") return false;

    let signature: string | null = null;
    for (const name of SIGNATURE_HEADERS) {
      const value = headers.get(name);
      if (value) {
        signature = value.trim();
        break;
      }
    }
    if (!signature) {
      // Some gateways put the signature in the JSON body instead.
      const parsed = safeParse(rawBody);
      const fromBody = firstString(parsed, ["signature", "sign", "hmac"]);
      if (!fromBody) return false;
      signature = fromBody;
    }

    const encoder = new TextEncoder();
    const expected = await hmacSha256Hex(encoder.encode(this.options.callbackSecret), encoder.encode(rawBody));
    const normalised = signature.replace(/^sha256=/i, "").trim().toLowerCase();
    return await timingSafeEqualString(normalised, expected);
  }

  parseCallback(rawBody: string): PaymentCallbackPayload | null {
    return parseGenericCallback(rawBody);
  }

  /**
   * `GET {apiBase}{statusPath}` with `{ref}` replaced by the provider reference.
   *
   * The path template is configuration on purpose: the sandbox and the live API
   * are not guaranteed to agree, and the first live test must be a config change
   * rather than a code change. An unreadable answer is `unknown`, never a guess.
   */
  async queryStatus(input: QueryStatusInput): Promise<PaymentStatusResult> {
    if (this.options.apiBase === "" || this.options.apiKey === "") {
      return { ok: false, status: "unknown", error: "PAYMENT_API_BASE / PAYMENT_API_KEY belum diisi" };
    }
    const reference = input.providerRef ?? input.kodeBayar;
    const path = this.options.statusPath.replace("{ref}", encodeURIComponent(reference));
    const url = `${this.options.apiBase}${path.startsWith("/") ? path : `/${path}`}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${this.options.apiKey}`, accept: "application/json" },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
      });
    } catch (error) {
      return { ok: false, status: "unknown", error: error instanceof Error ? error.message : String(error) };
    }

    const text = await response.text().catch(() => "");
    const payload = safeParse(text);
    if (!response.ok) {
      return { ok: false, status: "unknown", error: extractError(payload) ?? `HTTP ${response.status}` };
    }

    const parsed = parseGenericCallback(text);
    if (!parsed) return { ok: false, status: "unknown", error: "status payload tidak terbaca" };
    return {
      ok: true,
      status: parsed.status,
      amount: parsed.amount,
      providerRef: parsed.providerRef ?? reference,
      metode: parsed.metode,
      paidAt: parsed.paidAt,
      raw: payload,
      error: "",
    };
  }
}

// ---------------------------------------------------------------------------
// Shared parsing helpers
// ---------------------------------------------------------------------------

/** Payment statuses gateways use, mapped onto our four values. */
const STATUS_MAP: Record<string, CallbackStatus> = {
  paid: "paid",
  success: "paid",
  succeeded: "paid",
  settled: "paid",
  completed: "paid",
  capture: "paid",
  lunas: "paid",
  expired: "expired",
  expire: "expired",
  kadaluarsa: "expired",
  failed: "failed",
  failure: "failed",
  deny: "failed",
  denied: "failed",
  cancel: "failed",
  cancelled: "failed",
  canceled: "failed",
  refund: "failed",
};

export function normaliseStatus(value: unknown): CallbackStatus {
  if (typeof value !== "string") return "unknown";
  return STATUS_MAP[value.trim().toLowerCase()] ?? "unknown";
}

function safeParse(text: string): unknown {
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function unwrapData(payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null) return {};
  const record = payload as Record<string, unknown>;
  const data = record["data"];
  if (typeof data === "object" && data !== null && !Array.isArray(data)) return data as Record<string, unknown>;
  return record;
}

function firstString(source: unknown, keys: readonly string[]): string | null {
  if (typeof source !== "object" || source === null) return null;
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

function firstNumber(source: unknown, keys: readonly string[]): number | null {
  if (typeof source !== "object" || source === null) return null;
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  }
  return null;
}

function extractError(payload: unknown): string | null {
  const data = unwrapData(payload);
  return (
    firstString(data, ["error", "message", "description", "error_message"]) ??
    firstString(payload, ["error", "message", "description"])
  );
}

/** Timestamps: epoch seconds, epoch milliseconds or an ISO string. */
function normaliseTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? Math.trunc(value * 1000) : Math.trunc(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && /^\d+$/.test(value.trim())) return normaliseTimestamp(numeric);
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Reads the fields a payment callback is allowed to set, whatever the gateway
 * calls them. Anything unrecognised stays `null`/`unknown` rather than being
 * guessed — an amount we cannot read must not become "the order is paid".
 */
export function parseGenericCallback(rawBody: string): PaymentCallbackPayload | null {
  const parsed = safeParse(rawBody);
  if (parsed === null) return null;
  const data = unwrapData(parsed);

  return {
    kodeBayar: firstString(data, ["kode_bayar", "kodeBayar", "external_id", "merchant_ref", "order_id", "reference"]),
    orderRef: firstString(data, ["order_ref", "orderRef", "ref"]),
    status: normaliseStatus(firstString(data, ["status", "transaction_status", "payment_status", "state"])),
    amount: firstNumber(data, ["amount", "jumlah", "total", "gross_amount", "paid_amount", "nominal"]),
    providerRef: firstString(data, ["provider_ref", "providerRef", "payment_id", "id", "trx_id", "transaction_id"]),
    metode: firstString(data, ["metode", "method", "payment_method", "payment_type", "channel"]),
    paidAt: normaliseTimestamp(
      (data as Record<string, unknown>)["paid_at"] ??
        (data as Record<string, unknown>)["paidAt"] ??
        (data as Record<string, unknown>)["settlement_time"] ??
        (data as Record<string, unknown>)["transaction_time"],
    ),
    raw: parsed,
  };
}

export interface CreateProviderOptions {
  dryRun: boolean;
  publicBaseUrl: string;
  provider: string;
  apiBase: string;
  apiKey: string;
  callbackSecret: string;
  createPath: string;
  statusPath: string;
  log?: Logger;
  fetchImpl?: typeof fetch;
}

/** Picks the provider from configuration. Dry run always wins. */
export function createPaymentProvider(options: CreateProviderOptions): PaymentProvider {
  if (options.dryRun) return new DryRunProvider(options.publicBaseUrl);
  if (options.provider === "sumopod") {
    return new SumopodAdapter({
      apiBase: options.apiBase,
      apiKey: options.apiKey,
      callbackSecret: options.callbackSecret,
      createPath: options.createPath,
      statusPath: options.statusPath,
      ...(options.log ? { log: options.log } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }
  return new DryRunProvider(options.publicBaseUrl);
}
