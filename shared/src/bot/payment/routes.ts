/**
 * `POST /payment/callback` and the dry-run payment page.
 *
 * `/payment/callback` is the gateway's door into the worker. It does three
 * things and nothing else:
 *
 *   1. verifies the HMAC signature over the **raw body** (with
 *      `PAYMENT_CALLBACK_SECRET`; an unset secret means every callback is
 *      refused, because "paid" is the state that ships goods),
 *   2. turns the payload into one frozen `payment.event` envelope, and
 *   3. enqueues it, answering 202.
 *
 * The order tables are never touched here. That is the whole point: Cloudflare
 * Queues is the single writer for payment state, so a webhook that arrives three
 * times produces three enqueues, one of which is new — the frozen delivery id
 * (`<order_ref>:<status>:<provider_ref|paid_at>`) makes the others duplicates.
 *
 * The dry-run page exists so the entire path *after* the gateway can be exercised
 * with no merchant account: `GET /dry-run/<kode_bayar>` shows the order and a
 * button, and the button enqueues exactly the same envelope a real callback would
 * produce — same statuses, same receipt, same outbox.
 */
import type { Env, InstanceConfig } from "../../config";
import { createLogger } from "../../lib/logger";
import { ENVELOPE_VERSION, type EnvelopeV1 } from "../../envelope";
import { createCheckoutContext, type CheckoutDeps } from "./checkout";
import { paymentDeliveryId, paymentEnvelope, type PaymentEventPayload } from "./events";
import { SumopodAdapter, parseGenericCallback, type CallbackStatus } from "./provider";
import { findOrderByKode, findPaymentByKodeBayar } from "./turso";
import { formatRupiah, formatWib } from "../utils/format";

export interface PaymentRouteDeps extends CheckoutDeps {
  /** Test seam: replaces `env.EVENTS.send`. */
  send?: (envelope: EnvelopeV1) => Promise<unknown>;
}

export interface PaymentRouteOptions {
  env: Env;
  config: InstanceConfig;
  deps?: PaymentRouteDeps;
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function html(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

async function sendEnvelope(
  options: PaymentRouteOptions,
  envelope: EnvelopeV1,
): Promise<{ ok: boolean; error: string }> {
  try {
    const send = options.deps?.send ?? ((value: EnvelopeV1) => options.env.EVENTS.send(value, { contentType: "json" }));
    await send(envelope);
    return { ok: true, error: "" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** `POST /payment/callback` */
export async function handlePaymentCallback(request: Request, options: PaymentRouteOptions): Promise<Response> {
  const { config } = options;
  const deps = options.deps ?? {};
  const log = deps.log ?? createLogger({ slug: config.slug, handler: "payment" });

  if (request.method !== "POST") return json(405, { error: "method not allowed" });

  const rawBody = await request.text();

  if (config.bot.paymentCallbackSecret === "") {
    log.error("payment_callback_misconfigured", { reason: "PAYMENT_CALLBACK_SECRET is empty" });
    return json(503, { error: "PAYMENT_CALLBACK_SECRET is not configured" });
  }

  // Verification uses the gateway adapter even in dry-run mode: the operator can
  // rehearse the real callback (signature and all) before flipping
  // PAYMENT_DRY_RUN=false, and a dry-run never depends on it.
  const verifier = new SumopodAdapter({
    apiBase: config.bot.paymentApiBase,
    apiKey: config.bot.paymentApiKey,
    callbackSecret: config.bot.paymentCallbackSecret,
    createPath: config.bot.paymentCreatePath,
    statusPath: config.bot.paymentStatusPath,
    ...(deps.log ? { log: deps.log } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });

  if (!(await verifier.verifyCallback(rawBody, request.headers))) {
    log.warn("payment_callback_unauthorized", { ip: request.headers.get("cf-connecting-ip"), bytes: rawBody.length });
    return json(401, { error: "invalid signature" });
  }

  const parsed = parseGenericCallback(rawBody);
  if (!parsed || parsed.status === "unknown") {
    log.warn("payment_callback_unreadable", { bytes: rawBody.length });
    return json(400, { error: "callback payload is not understood" });
  }

  const payload: PaymentEventPayload = {
    kodeBayar: parsed.kodeBayar,
    orderRef: parsed.orderRef,
    status: parsed.status,
    amount: parsed.amount,
    providerRef: parsed.providerRef,
    metode: parsed.metode,
    paidAt: parsed.paidAt,
    source: "gateway",
    raw: parsed.raw,
  };

  const envelope = paymentEnvelope(payload, { slug: config.slug, receivedAt: new Date() });
  const sent = await sendEnvelope(options, envelope);
  if (!sent.ok) {
    // 503 makes the gateway retry, which is exactly what we want when the queue
    // write failed: the event is not lost, it is postponed.
    log.error("payment_callback_enqueue_failed", { error: sent.error, orderRef: payload.orderRef });
    return json(503, { error: "could not enqueue the payment event" });
  }

  log.info("payment_callback_accepted", {
    deliveryId: envelope.deliveryId,
    orderRef: payload.orderRef,
    status: payload.status,
  });
  return json(202, { ok: true, deliveryId: envelope.deliveryId });
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:24px;background:#f6f7f9;color:#111}
main{max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.12)}
h1{font-size:20px;margin:0 0 16px}dl{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:0 0 16px}
dt{color:#555}dd{margin:0;text-align:right;font-variant-numeric:tabular-nums}
button{font:inherit;padding:12px 16px;border-radius:8px;border:0;background:#0b7a3b;color:#fff;width:100%;margin-top:8px;cursor:pointer}
button.secondary{background:#eee;color:#333}.muted{color:#666;font-size:13px}</style></head>
<body><main>${body}</main></body></html>`;
}

/** `GET /dry-run/<kode_bayar>` */
export async function handleDryRunPage(options: PaymentRouteOptions, kodeBayar: string): Promise<Response> {
  const context = createCheckoutContext({
    env: { BOT_DB: options.env.BOT_DB },
    config: options.config,
    deps: { ...(options.deps ?? {}) },
  });

  if (!context.sql) {
    return html(503, page("Dry run", "<h1>Database tidak tersedia</h1><p>TURSO_DATABASE_URL belum diisi.</p>"));
  }

  let payment;
  let order;
  try {
    payment = await findPaymentByKodeBayar(context.sql, kodeBayar);
    if (payment) order = await findOrderByKode(context.sql, kodeBayar.replace(/-P\d+$/, "").replace(/^PAY-/, "INV-"));
  } catch (error) {
    // A database that cannot be reached must not become a 500 stack trace on a
    // page a customer may be looking at.
    const detail = error instanceof Error ? error.message : String(error);
    context.log.error("dry_run_lookup_failed", { kodeBayar, error: detail });
    return html(503, page("Dry run", `<h1>Database sedang tidak bisa dihubungi</h1><p class="muted">${escapeHtml(detail)}</p>`));
  }
  if (!payment) {
    return html(404, page("Dry run", `<h1>Pembayaran ${escapeHtml(kodeBayar)} tidak ditemukan</h1>`));
  }

  const paid = payment.status === "paid";
  const body = [
    `<h1>Simulasi pembayaran</h1>`,
    "<dl>",
    `<dt>Kode bayar</dt><dd>${escapeHtml(payment.kodeBayar)}</dd>`,
    order ? `<dt>Kode pesanan</dt><dd>${escapeHtml(order.kodePesanan)}</dd>` : "",
    order ? `<dt>Status</dt><dd>${escapeHtml(order.status)}</dd>` : "",
    `<dt>Jumlah</dt><dd>${escapeHtml(formatRupiah(payment.jumlah))}</dd>`,
    order?.expiresAt ? `<dt>Berlaku sampai</dt><dd>${escapeHtml(formatWib(new Date(order.expiresAt)))}</dd>` : "",
    "</dl>",
    paid
      ? "<p><strong>Pembayaran ini sudah lunas.</strong></p>"
      : `<form method="post" action="/dry-run/${encodeURIComponent(kodeBayar)}/pay">
           <button type="submit" name="action" value="paid">Bayar sekarang (simulasi)</button>
           <button class="secondary" type="submit" name="action" value="expired">Tandai kedaluwarsa</button>
           <button class="secondary" type="submit" name="action" value="failed">Tandai gagal</button>
         </form>`,
    `<p class="muted">Halaman ini hanya ada saat PAYMENT_DRY_RUN=true. Tidak ada gateway yang dipanggil;
     tombol di atas mengirim event pembayaran yang sama seperti callback asli.</p>`,
  ]
    .filter((line) => line !== "")
    .join("\n");

  return html(200, page("Simulasi pembayaran", body));
}

/** `POST /dry-run/<kode_bayar>/pay` */
export async function handleDryRunAction(request: Request, options: PaymentRouteOptions, kodeBayar: string): Promise<Response> {
  const log = options.deps?.log ?? createLogger({ slug: options.config.slug, handler: "payment" });

  if (request.method !== "POST") return json(405, { error: "method not allowed" });
  if (!options.config.bot.paymentDryRun) {
    return json(403, { error: "dry-run is disabled (PAYMENT_DRY_RUN=false)" });
  }

  const form = await request.text();
  const params = new URLSearchParams(form);
  const action = (params.get("action") ?? "paid").toLowerCase();
  const status: CallbackStatus = action === "expired" ? "expired" : action === "failed" ? "failed" : "paid";

  const context = createCheckoutContext({
    env: { BOT_DB: options.env.BOT_DB },
    config: options.config,
    deps: { ...(options.deps ?? {}) },
  });
  if (!context.sql) return json(503, { error: "TURSO_DATABASE_URL is not configured" });

  const payment = await findPaymentByKodeBayar(context.sql, kodeBayar).catch((error: unknown) => {
    log.error("dry_run_lookup_failed", { kodeBayar, error: error instanceof Error ? error.message : String(error) });
    return null;
  });
  if (!payment) return json(404, { error: `pembayaran ${kodeBayar} tidak ditemukan` });

  const now = new Date();
  const payload: PaymentEventPayload = {
    kodeBayar: payment.kodeBayar,
    orderRef: null,
    status,
    amount: status === "paid" ? payment.jumlah : null,
    providerRef: `dry-run:${payment.kodeBayar}`,
    metode: payment.metode ?? "qris",
    paidAt: status === "paid" ? now.getTime() : null,
    source: "dry-run",
  };
  const envelope = paymentEnvelope(payload, {
    slug: options.config.slug,
    receivedAt: now,
    // Stable per (payment, status): pressing the button twice enqueues the same
    // delivery id, so the consumer sees a duplicate instead of paying twice.
    deliveryId: `${payment.kodeBayar}:${status}:dry-run`,
  });

  const sent = await sendEnvelope(options, envelope);
  if (!sent.ok) {
    log.error("dry_run_enqueue_failed", { kodeBayar, error: sent.error });
    return json(503, { error: "could not enqueue the payment event" });
  }

  log.info("dry_run_payment_event", { kodeBayar, status, deliveryId: envelope.deliveryId });
  return html(
    200,
    page(
      "Simulasi pembayaran",
      `<h1>${
        status === "paid" ? "Pembayaran diterima" : status === "expired" ? "Ditandai kedaluwarsa" : "Ditandai gagal"
      }</h1>
       <p>Event <code>${escapeHtml(status)}</code> untuk <code>${escapeHtml(kodeBayar)}</code> sudah masuk antrean.</p>
       <p class="muted">Nota dan pesan konfirmasi dikirim oleh consumer; cek log worker atau chat pelanggan.</p>`,
    ),
  );
}

/**
 * A tiny self-check used by `/healthz` and the E2E script: is the callback
 * configuration complete enough to accept a real webhook?
 */
export async function callbackReadiness(options: PaymentRouteOptions): Promise<{
  ready: boolean;
  secretConfigured: boolean;
  dryRun: boolean;
  provider: string;
  version: number;
}> {
  return {
    ready: options.config.bot.paymentCallbackSecret !== "" && options.config.bot.publicBaseUrl !== "",
    secretConfigured: options.config.bot.paymentCallbackSecret !== "",
    dryRun: options.config.bot.paymentDryRun,
    provider: options.config.bot.paymentProvider,
    version: ENVELOPE_VERSION,
  };
}

/** Exported for tests: the frozen idempotency key of a dry-run event. */
export { paymentDeliveryId };
