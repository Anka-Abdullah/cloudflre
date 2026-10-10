/**
 * Turso (libSQL) repositories for customers, orders, order items and payments.
 *
 * The design rule that shapes every function here: **a callback that arrives
 * twice is the normal case, not an exception.** Cloudflare Queues is
 * at-least-once, the payment gateway retries its webhook, and Telegram redelivers
 * updates. So:
 *
 *  - creation is `INSERT OR IGNORE` on a UNIQUE business key, and a collision
 *    means "resume", never "fail" (`createOrder` → `created: false`);
 *  - every status change is a conditional `UPDATE … WHERE status IN (…)`, which
 *    makes the second callback a no-op instead of a second transition
 *    (`transitionOrder` → `false`);
 *  - nothing throws a raw driver error: everything goes through
 *    `PaymentDbError` with a stable `{ code, retryable }` shape (`sql.ts`).
 *
 * Money is always an integer number of rupiah, taken from the catalogue by the
 * caller — never from a customer message and never from the model.
 */
import { asNullableText, asNumber, asText, PaymentDbError, sqlBatch, sqlOne, type SqlClient, type SqlValue } from "./sql";
import { ORDER_STATUS_INITIAL, TURSO_SCHEMA } from "./schema";

export type OrderStatus =
  | "creating"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "pending"
  | "paid"
  | "expired"
  | "failed"
  | "superseded";

export const ORDER_STATUSES: readonly OrderStatus[] = [
  "creating",
  "awaiting_approval",
  "approved",
  "rejected",
  "pending",
  "paid",
  "expired",
  "failed",
  "superseded",
];

/**
 * Allowed transitions (frozen in `docs/wuzip-bot-flow.txt` section 6):
 *
 *   creating → awaiting_approval → approved | rejected
 *   approved → pending
 *   pending → paid | expired | failed
 *   awaiting_approval | pending → superseded
 *
 * Anything else is refused by the handler rather than "fixed" silently. Note
 * that `rejected` and `paid` are terminal: an order that ends there never
 * changes status again, which is what makes the conditional UPDATE a complete
 * idempotency guard.
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  creating: ["awaiting_approval", "approved", "rejected", "failed", "superseded"],
  awaiting_approval: ["approved", "rejected", "expired", "failed", "superseded"],
  approved: ["pending", "failed", "superseded"],
  rejected: [],
  pending: ["paid", "expired", "failed", "superseded"],
  paid: [],
  expired: [],
  failed: [],
  superseded: [],
};

/** Statuses that mean "this order is still the active one for its chat". */
export const ORDER_ACTIVE_STATUSES: readonly OrderStatus[] = ["creating", "awaiting_approval", "approved", "pending"];

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === "string" && (ORDER_STATUSES as readonly string[]).includes(value);
}

export type PaymentStatus = "creating" | "awaiting_approval" | "pending" | "paid" | "expired" | "failed" | "cancelled";

const PAYMENT_STATUSES: readonly PaymentStatus[] = [
  "creating",
  "awaiting_approval",
  "pending",
  "paid",
  "expired",
  "failed",
  "cancelled",
];

export function isPaymentStatus(value: unknown): value is PaymentStatus {
  return typeof value === "string" && (PAYMENT_STATUSES as readonly string[]).includes(value);
}

export interface OrderRow {
  id: number;
  ref: string;
  clientRef: string;
  kodePesanan: string;
  waChatJid: string;
  customerId: number | null;
  alamatKirim: string;
  totalHarga: number;
  additionalFee: number;
  grandTotal: number;
  ongkirIncluded: boolean;
  status: OrderStatus;
  paymentUrl: string | null;
  expiresAt: number | null;
  paidAt: number | null;
  supersededBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrderItemRow {
  id: number;
  orderId: number;
  kode: string;
  namaProduk: string;
  harga: number;
  qty: number;
  subtotal: number;
}

export interface PaymentRow {
  id: number;
  orderId: number;
  kodeBayar: string;
  provider: string;
  providerRef: string | null;
  metode: string | null;
  url: string | null;
  jumlah: number;
  status: PaymentStatus;
  telegramMessageId: number | null;
  approvalStatus: string | null;
  approvalReason: string | null;
  rawJson: string | null;
  expiresAt: number | null;
  paidAt: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrderItemInput {
  kode: string;
  nama: string;
  /** Integer rupiah, copied from the D1 catalogue by the caller. */
  harga: number;
  qty: number;
}

/**
 * Creates the schema. Safe to run on every boot: every statement is
 * `IF NOT EXISTS`, so the cost is one round-trip per statement on a cold isolate
 * and nothing at all afterwards (`ensureTursoSchemaOnce` memoises it).
 */
export async function ensureTursoSchema(client: SqlClient): Promise<void> {
  await sqlBatch(client, "ensureSchema", TURSO_SCHEMA.map((sql) => ({ sql })));
}

let schemaReady = false;

/** Boot helper: applies the schema once per isolate. */
export async function ensureTursoSchemaOnce(client: SqlClient): Promise<void> {
  if (schemaReady) return;
  await ensureTursoSchema(client);
  schemaReady = true;
}

/** Test seam: forget that the schema was applied. */
export function resetSchemaCache(): void {
  schemaReady = false;
}

/** Column list shared by every `SELECT`, so the mapper and the query cannot drift. */
const ORDER_COLUMNS = `id, ref, client_ref, kode_pesanan, wa_chat_jid, customer_id, alamat_kirim,
   total_harga, additional_fee, grand_total, ongkir_included, status, payment_url,
   expires_at, paid_at, superseded_by, created_at, updated_at`;

const PAYMENT_COLUMNS = `id, order_id, kode_bayar, provider, provider_ref, metode, url, jumlah, status,
   telegram_message_id, approval_status, approval_reason, raw_json, expires_at, paid_at, created_at, updated_at`;

function mapOrder(row: Record<string, SqlValue>): OrderRow {
  const status = asText(row["status"], ORDER_STATUS_INITIAL);
  return {
    id: asNumber(row["id"]),
    ref: asText(row["ref"]),
    clientRef: asText(row["client_ref"]),
    kodePesanan: asText(row["kode_pesanan"]),
    waChatJid: asText(row["wa_chat_jid"]),
    customerId: row["customer_id"] === null || row["customer_id"] === undefined ? null : asNumber(row["customer_id"]),
    alamatKirim: asText(row["alamat_kirim"]),
    totalHarga: asNumber(row["total_harga"]),
    additionalFee: asNumber(row["additional_fee"]),
    grandTotal: asNumber(row["grand_total"]),
    ongkirIncluded: asNumber(row["ongkir_included"]) === 1,
    status: isOrderStatus(status) ? status : (ORDER_STATUS_INITIAL as OrderStatus),
    paymentUrl: asNullableText(row["payment_url"]),
    expiresAt: row["expires_at"] === null || row["expires_at"] === undefined ? null : asNumber(row["expires_at"]),
    paidAt: row["paid_at"] === null || row["paid_at"] === undefined ? null : asNumber(row["paid_at"]),
    supersededBy: asNullableText(row["superseded_by"]),
    createdAt: asText(row["created_at"]),
    updatedAt: asText(row["updated_at"]),
  };
}

function mapItem(row: Record<string, SqlValue>): OrderItemRow {
  return {
    id: asNumber(row["id"]),
    orderId: asNumber(row["order_id"]),
    kode: asText(row["kode"]),
    namaProduk: asText(row["nama_produk"]),
    harga: asNumber(row["harga"]),
    qty: asNumber(row["qty"]),
    subtotal: asNumber(row["subtotal"]),
  };
}

function mapPayment(row: Record<string, SqlValue>): PaymentRow {
  const status = asText(row["status"], "creating");
  return {
    id: asNumber(row["id"]),
    orderId: asNumber(row["order_id"]),
    kodeBayar: asText(row["kode_bayar"]),
    provider: asText(row["provider"]),
    providerRef: asNullableText(row["provider_ref"]),
    metode: asNullableText(row["metode"]),
    url: asNullableText(row["url"]),
    jumlah: asNumber(row["jumlah"]),
    status: isPaymentStatus(status) ? status : "creating",
    telegramMessageId:
      row["telegram_message_id"] === null || row["telegram_message_id"] === undefined
        ? null
        : asNumber(row["telegram_message_id"]),
    approvalStatus: asNullableText(row["approval_status"]),
    approvalReason: asNullableText(row["approval_reason"]),
    rawJson: asNullableText(row["raw_json"]),
    expiresAt: row["expires_at"] === null || row["expires_at"] === undefined ? null : asNumber(row["expires_at"]),
    paidAt: row["paid_at"] === null || row["paid_at"] === undefined ? null : asNumber(row["paid_at"]),
    createdAt: asText(row["created_at"]),
    updatedAt: asText(row["updated_at"]),
  };
}

/** Integer rupiah, never a float: a rounding error here is a wrong price. */
function money(value: number): number {
  if (!Number.isFinite(value)) throw new PaymentDbError({ code: "unknown", operation: "money", message: `invalid amount ${value}` });
  return Math.trunc(value);
}

function iso(at: number | Date): string {
  return (at instanceof Date ? at : new Date(at)).toISOString();
}

export interface UpsertCustomerInput {
  nama: string;
  noHp?: string | null;
  email?: string | null;
  alamat?: string | null;
  catatan?: string | null;
  at: number | Date;
}

/** Creates or refreshes a customer keyed by phone number. */
export async function upsertCustomer(
  client: SqlClient,
  input: UpsertCustomerInput,
): Promise<{ id: number; created: boolean }> {
  const timestamp = iso(input.at);
  if (input.noHp) {
    await sqlOne(
      client,
      "upsertCustomer",
      `INSERT INTO customers (nama, no_hp, email, alamat, catatan, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (no_hp) DO UPDATE SET
         nama = excluded.nama,
         email = COALESCE(excluded.email, customers.email),
         alamat = COALESCE(excluded.alamat, customers.alamat),
         catatan = COALESCE(excluded.catatan, customers.catatan),
         updated_at = excluded.updated_at`,
      [input.nama, input.noHp, input.email ?? null, input.alamat ?? null, input.catatan ?? null, timestamp, timestamp],
    );
    const row = await sqlOne(client, "upsertCustomer.select", "SELECT id FROM customers WHERE no_hp = ?", [input.noHp]);
    return { id: asNumber(row.rows[0]?.["id"]), created: false };
  }

  const inserted = await sqlOne(
    client,
    "upsertCustomer.insert",
    `INSERT INTO customers (nama, no_hp, email, alamat, catatan, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?, ?)`,
    [input.nama, input.email ?? null, input.alamat ?? null, input.catatan ?? null, timestamp, timestamp],
  );
  return { id: asNumber(inserted.lastInsertRowid), created: true };
}

export interface CreateOrderInput {
  ref: string;
  clientRef: string;
  kodePesanan: string;
  waChatJid: string;
  customerId?: number | null;
  alamatKirim: string;
  items: readonly OrderItemInput[];
  additionalFee?: number;
  ongkirIncluded: boolean;
  status?: OrderStatus;
  expiresAt?: number | null;
  at: number | Date;
}

export interface CreateOrderResult {
  /** False when an order with the same `clientRef` already existed (resume). */
  created: boolean;
  order: OrderRow;
  items: OrderItemRow[];
}

/**
 * Creates one order, or resumes the existing one for the same `clientRef`.
 *
 * `client_ref` is the idempotency key the tool computes from the chat and the
 * cart contents, so a model that calls `create_payment_link` twice — or a queue
 * retry — resumes the same order instead of charging twice.
 */
export async function createOrder(client: SqlClient, input: CreateOrderInput): Promise<CreateOrderResult> {
  const existing = await findOrderByClientRef(client, input.clientRef);
  if (existing) {
    await ensureOrderItems(client, existing.id, input.items);
    return { created: false, order: existing, items: await listOrderItems(client, existing.id) };
  }

  const timestamp = iso(input.at);
  const additionalFee = money(input.additionalFee ?? 0);
  const total = input.items.reduce((sum, item) => sum + money(item.harga) * Math.trunc(item.qty), 0);

  const inserted = await sqlOne(
    client,
    "createOrder",
    `INSERT OR IGNORE INTO orders
       (ref, client_ref, kode_pesanan, wa_chat_jid, customer_id, alamat_kirim,
        total_harga, additional_fee, grand_total, ongkir_included, status,
        expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.ref,
      input.clientRef,
      input.kodePesanan,
      input.waChatJid,
      input.customerId ?? null,
      input.alamatKirim,
      total,
      additionalFee,
      total + additionalFee,
      input.ongkirIncluded ? 1 : 0,
      input.status ?? ORDER_STATUS_INITIAL,
      input.expiresAt ?? null,
      timestamp,
      timestamp,
    ],
  );

  if (inserted.rowsAffected === 0) {
    // Lost a race with a concurrent checkout for the same client_ref.
    const raced = await findOrderByClientRef(client, input.clientRef);
    if (!raced) {
      throw new PaymentDbError({
        code: "unknown",
        operation: "createOrder",
        message: `order ${input.kodePesanan} was neither inserted nor found by client_ref`,
      });
    }
    await ensureOrderItems(client, raced.id, input.items);
    return { created: false, order: raced, items: await listOrderItems(client, raced.id) };
  }

  const order = await findOrderByClientRef(client, input.clientRef);
  if (!order) {
    throw new PaymentDbError({ code: "unknown", operation: "createOrder", message: "inserted order could not be read back" });
  }
  await ensureOrderItems(client, order.id, input.items);
  return { created: true, order, items: await listOrderItems(client, order.id) };
}

/**
 * Writes the items only when the order has none.
 *
 * This is the self-healing half of `createOrder`: a crash between the order
 * INSERT and the item batch would otherwise leave an order that can never be
 * paid for (grand_total computed, basket empty).
 */
export async function ensureOrderItems(
  client: SqlClient,
  orderId: number,
  items: readonly OrderItemInput[],
): Promise<number> {
  if (items.length === 0) return 0;
  const existing = await sqlOne(client, "ensureOrderItems.count", "SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?", [
    orderId,
  ]);
  if (asNumber(existing.rows[0]?.["n"]) > 0) return 0;

  await sqlBatch(
    client,
    "ensureOrderItems",
    items.map((item) => ({
      sql: `INSERT INTO order_items (order_id, kode, nama_produk, harga, qty, subtotal) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        orderId,
        item.kode,
        item.nama,
        money(item.harga),
        Math.trunc(item.qty),
        money(item.harga) * Math.trunc(item.qty),
      ] as SqlValue[],
    })),
  );
  return items.length;
}

export async function findOrderByClientRef(client: SqlClient, clientRef: string): Promise<OrderRow | null> {
  const result = await sqlOne(client, "findOrderByClientRef", `SELECT ${ORDER_COLUMNS} FROM orders WHERE client_ref = ?`, [
    clientRef,
  ]);
  const row = result.rows[0];
  return row ? mapOrder(row) : null;
}

export async function findOrderByKode(client: SqlClient, kodePesanan: string): Promise<OrderRow | null> {
  const result = await sqlOne(client, "findOrderByKode", `SELECT ${ORDER_COLUMNS} FROM orders WHERE kode_pesanan = ?`, [
    kodePesanan,
  ]);
  const row = result.rows[0];
  return row ? mapOrder(row) : null;
}

export async function findOrderByRef(client: SqlClient, ref: string): Promise<OrderRow | null> {
  const result = await sqlOne(client, "findOrderByRef", `SELECT ${ORDER_COLUMNS} FROM orders WHERE ref = ?`, [ref]);
  const row = result.rows[0];
  return row ? mapOrder(row) : null;
}

/** The newest order for a chat that is still in flight, if any. */
export async function findActiveOrderForChat(client: SqlClient, chatJid: string): Promise<OrderRow | null> {
  const placeholders = ORDER_ACTIVE_STATUSES.map(() => "?").join(", ");
  const result = await sqlOne(
    client,
    "findActiveOrderForChat",
    `SELECT ${ORDER_COLUMNS} FROM orders WHERE wa_chat_jid = ? AND status IN (${placeholders}) ORDER BY id DESC LIMIT 1`,
    [chatJid, ...ORDER_ACTIVE_STATUSES],
  );
  const row = result.rows[0];
  return row ? mapOrder(row) : null;
}

export async function listOrderItems(client: SqlClient, orderId: number): Promise<OrderItemRow[]> {
  const result = await sqlOne(
    client,
    "listOrderItems",
    `SELECT id, order_id, kode, nama_produk, harga, qty, subtotal FROM order_items WHERE order_id = ? ORDER BY id`,
    [orderId],
  );
  return result.rows.map(mapItem);
}

/** Fields a transition may write besides `status`. Whitelisted, never interpolated. */
const ORDER_UPDATABLE = {
  payment_url: "paymentUrl",
  additional_fee: "additionalFee",
  grand_total: "grandTotal",
  paid_at: "paidAt",
  expires_at: "expiresAt",
  superseded_by: "supersededBy",
  alamat_kirim: "alamatKirim",
  ongkir_included: "ongkirIncluded",
  customer_id: "customerId",
} as const;

export type OrderPatch = Partial<{
  paymentUrl: string | null;
  additionalFee: number;
  grandTotal: number;
  paidAt: number | null;
  expiresAt: number | null;
  supersededBy: string | null;
  alamatKirim: string;
  ongkirIncluded: boolean;
  customerId: number | null;
}>;

export interface TransitionOrderInput {
  kodePesanan: string;
  from: readonly OrderStatus[];
  to: OrderStatus;
  at: number | Date;
  patch?: OrderPatch;
}

/**
 * Conditional status change. Returns false when the row was not in one of the
 * `from` states — which is exactly what a duplicated callback looks like.
 *
 * The transition table is checked first so a programming mistake (or an attempt
 * to "fix" a rejected order) is refused loudly instead of silently accepted.
 */
export async function transitionOrder(client: SqlClient, input: TransitionOrderInput): Promise<boolean> {
  // The caller lists the statuses it is willing to move *from*; the row will be
  // in exactly one of them. So the guard asks "is this target reachable from any
  // of the accepted sources", not "from all of them" — the latter would reject a
  // legitimate `from: ["approved", "pending"] → pending` resume.
  if (!input.from.some((from) => canTransition(from, input.to))) {
    throw new PaymentDbError({
      code: "unknown",
      operation: "transitionOrder",
      message: `illegal transition ${input.from.join("|")} → ${input.to}`,
    });
  }

  const assignments: string[] = ["status = ?", "updated_at = ?"];
  const args: SqlValue[] = [input.to, iso(input.at)];

  for (const [column, key] of Object.entries(ORDER_UPDATABLE) as Array<[keyof typeof ORDER_UPDATABLE, keyof OrderPatch]>) {
    if (input.patch === undefined || !(key in input.patch)) continue;
    const value = input.patch[key];
    assignments.push(`${column} = ?`);
    if (typeof value === "boolean") args.push(value ? 1 : 0);
    else if (typeof value === "number") args.push(money(value));
    else args.push((value ?? null) as SqlValue);
  }

  const placeholders = input.from.map(() => "?").join(", ");
  const result = await sqlOne(
    client,
    "transitionOrder",
    `UPDATE orders SET ${assignments.join(", ")} WHERE kode_pesanan = ? AND status IN (${placeholders})`,
    [...args, input.kodePesanan, ...input.from],
  );
  return result.rowsAffected > 0;
}

/** Points an old order at the newer one that replaced it. */
export async function supersedeOrder(
  client: SqlClient,
  input: { kodePesanan: string; byKode: string; at: number | Date },
): Promise<boolean> {
  return await transitionOrder(client, {
    kodePesanan: input.kodePesanan,
    from: ["creating", "awaiting_approval", "approved", "pending"],
    to: "superseded",
    at: input.at,
    patch: { supersededBy: input.byKode },
  });
}

export interface AttachPaymentInput {
  orderId: number;
  kodeBayar: string;
  provider: string;
  providerRef?: string | null;
  metode?: string | null;
  url?: string | null;
  jumlah: number;
  status?: PaymentStatus;
  telegramMessageId?: number | null;
  approvalStatus?: string | null;
  approvalReason?: string | null;
  rawJson?: string | null;
  expiresAt?: number | null;
  at: number | Date;
}

/** Creates the payment row for an order, or returns the existing one (same `kode_bayar`). */
export async function attachPayment(
  client: SqlClient,
  input: AttachPaymentInput,
): Promise<{ created: boolean; payment: PaymentRow }> {
  const timestamp = iso(input.at);
  const inserted = await sqlOne(
    client,
    "attachPayment",
    `INSERT OR IGNORE INTO payments
       (order_id, kode_bayar, provider, provider_ref, metode, url, jumlah, status,
        telegram_message_id, approval_status, approval_reason, raw_json, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.orderId,
      input.kodeBayar,
      input.provider,
      input.providerRef ?? null,
      input.metode ?? null,
      input.url ?? null,
      money(input.jumlah),
      input.status ?? "creating",
      input.telegramMessageId ?? null,
      input.approvalStatus ?? null,
      input.approvalReason ?? null,
      input.rawJson ?? null,
      input.expiresAt ?? null,
      timestamp,
      timestamp,
    ],
  );

  const payment = await findPaymentByKodeBayar(client, input.kodeBayar);
  if (!payment) {
    throw new PaymentDbError({ code: "unknown", operation: "attachPayment", message: "payment row could not be read back" });
  }
  return { created: inserted.rowsAffected > 0, payment };
}

export async function findPaymentByKodeBayar(client: SqlClient, kodeBayar: string): Promise<PaymentRow | null> {
  const result = await sqlOne(
    client,
    "findPaymentByKodeBayar",
    `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE kode_bayar = ?`,
    [kodeBayar],
  );
  const row = result.rows[0];
  return row ? mapPayment(row) : null;
}

export async function listPaymentsForOrder(client: SqlClient, orderId: number): Promise<PaymentRow[]> {
  const result = await sqlOne(
    client,
    "listPaymentsForOrder",
    `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE order_id = ? ORDER BY id`,
    [orderId],
  );
  return result.rows.map(mapPayment);
}

/**
 * The one payment row an order works with.
 *
 * The flow keeps a single row per order — created when the approval card goes out
 * (so the card can be edited later) and reused when the link is issued — which is
 * what makes `kode_bayar` stable from the admin's screen to the customer's link.
 * A final row (`paid`) wins over a stale `awaiting_approval` one.
 */
export async function findPaymentForOrder(client: SqlClient, orderId: number): Promise<PaymentRow | null> {
  const result = await sqlOne(
    client,
    "findPaymentForOrder",
    `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE order_id = ?
      ORDER BY CASE status WHEN 'paid' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, id
      LIMIT 1`,
    [orderId],
  );
  const row = result.rows[0];
  return row ? mapPayment(row) : null;
}

export interface CustomerRow {
  id: number;
  nama: string;
  noHp: string | null;
  email: string | null;
  alamat: string | null;
  catatan: string | null;
}

export async function findCustomerById(client: SqlClient, id: number): Promise<CustomerRow | null> {
  const result = await sqlOne(
    client,
    "findCustomerById",
    "SELECT id, nama, no_hp, email, alamat, catatan FROM customers WHERE id = ?",
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: asNumber(row["id"]),
    nama: asText(row["nama"]),
    noHp: asNullableText(row["no_hp"]),
    email: asNullableText(row["email"]),
    alamat: asNullableText(row["alamat"]),
    catatan: asNullableText(row["catatan"]),
  };
}

const PAYMENT_UPDATABLE = {
  provider: "provider",
  jumlah: "jumlah",
  provider_ref: "providerRef",
  url: "url",
  metode: "metode",
  status: "status",
  telegram_message_id: "telegramMessageId",
  approval_status: "approvalStatus",
  approval_reason: "approvalReason",
  raw_json: "rawJson",
  paid_at: "paidAt",
  expires_at: "expiresAt",
} as const;

export type PaymentPatch = Partial<{
  provider: string;
  jumlah: number;
  providerRef: string | null;
  url: string | null;
  metode: string | null;
  status: PaymentStatus;
  telegramMessageId: number | null;
  approvalStatus: string | null;
  approvalReason: string | null;
  rawJson: string | null;
  paidAt: number | null;
  expiresAt: number | null;
}>;

export interface UpdatePaymentInput {
  kodeBayar: string;
  /** Statuses the row is allowed to be in; empty means "any". */
  from?: readonly PaymentStatus[];
  at: number | Date;
  patch: PaymentPatch;
}

/** Conditional payment update; false when the row was already in a final state. */
export async function updatePayment(client: SqlClient, input: UpdatePaymentInput): Promise<boolean> {
  const assignments: string[] = ["updated_at = ?"];
  const args: SqlValue[] = [iso(input.at)];

  for (const [column, key] of Object.entries(PAYMENT_UPDATABLE) as Array<[keyof typeof PAYMENT_UPDATABLE, keyof PaymentPatch]>) {
    if (!(key in input.patch)) continue;
    const value = input.patch[key];
    assignments.push(`${column} = ?`);
    if (typeof value === "number") args.push(money(value));
    else args.push((value ?? null) as SqlValue);
  }

  const where = ["kode_bayar = ?"];
  const whereArgs: SqlValue[] = [input.kodeBayar];
  if (input.from && input.from.length > 0) {
    where.push(`status IN (${input.from.map(() => "?").join(", ")})`);
    whereArgs.push(...input.from);
  }

  const result = await sqlOne(
    client,
    "updatePayment",
    `UPDATE payments SET ${assignments.join(", ")} WHERE ${where.join(" AND ")}`,
    [...args, ...whereArgs],
  );
  return result.rowsAffected > 0;
}

/** Orders that passed their deadline without being paid. */
export async function listOrdersDueForExpiry(
  client: SqlClient,
  input: { at: number; limit?: number },
): Promise<OrderRow[]> {
  const result = await sqlOne(
    client,
    "listOrdersDueForExpiry",
    `SELECT ${ORDER_COLUMNS} FROM orders
      WHERE status IN ('pending', 'awaiting_approval', 'approved')
        AND expires_at IS NOT NULL AND expires_at <= ?
      ORDER BY expires_at LIMIT ?`,
    [input.at, input.limit ?? 50],
  );
  return result.rows.map(mapOrder);
}

export async function listOrdersInStatus(
  client: SqlClient,
  statuses: readonly OrderStatus[],
  limit = 50,
): Promise<OrderRow[]> {
  if (statuses.length === 0) return [];
  const result = await sqlOne(
    client,
    "listOrdersInStatus",
    `SELECT ${ORDER_COLUMNS} FROM orders WHERE status IN (${statuses.map(() => "?").join(", ")}) ORDER BY id DESC LIMIT ?`,
    [...statuses, limit],
  );
  return result.rows.map(mapOrder);
}

/** Removes one order with its items and payments (smoke test cleanup, admin tooling). */
export async function deleteOrderCascade(client: SqlClient, kodePesanan: string): Promise<number> {
  const order = await findOrderByKode(client, kodePesanan);
  if (!order) return 0;
  await sqlBatch(client, "deleteOrderCascade", [
    { sql: "DELETE FROM payments WHERE order_id = ?", args: [order.id] },
    { sql: "DELETE FROM order_items WHERE order_id = ?", args: [order.id] },
    { sql: "DELETE FROM orders WHERE id = ?", args: [order.id] },
  ]);
  return 1;
}

/** Table names present in the database; used by the smoke script and /healthz. */
export async function listTables(client: SqlClient): Promise<string[]> {
  const result = await sqlOne(
    client,
    "listTables",
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  return result.rows.map((row) => asText(row["name"])).filter((name) => name !== "");
}
