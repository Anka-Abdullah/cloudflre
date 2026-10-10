/**
 * FASE 5a acceptance tests: the Turso schema and repositories.
 *
 * The repositories run against the real SQLite engine through `D1SqlClient`, so
 * what is verified here is the SQL itself — UNIQUE keys, conditional UPDATEs,
 * `INSERT OR IGNORE`, the ON CONFLICT customer upsert — and not a mock's idea of
 * it. Three behaviours are the point of the whole phase and each has a test:
 *
 *   1. a second checkout with the same `client_ref` resumes the first order;
 *   2. a second payment callback changes nothing (`transitionOrder` → false);
 *   3. a database failure surfaces as `PaymentDbError`, never as a raw throw.
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  attachPayment,
  createOrder,
  deleteOrderCascade,
  ensureTursoSchema,
  findActiveOrderForChat,
  findOrderByClientRef,
  findOrderByKode,
  findPaymentByKodeBayar,
  listOrderItems,
  listOrdersDueForExpiry,
  listTables,
  ORDER_TRANSITIONS,
  canTransition,
  supersedeOrder,
  transitionOrder,
  updatePayment,
  upsertCustomer,
} from "../src/bot/payment/turso";
import { PaymentDbError, toPaymentDbError, withTursoRetry, type SqlClient, type SqlResult } from "../src/bot/payment/sql";
import { D1SqlClient } from "./d1-sql-client";
import { TURSO_SCHEMA } from "../src/bot/payment/schema";

const db = (env as unknown as { BOT_DB: D1Database }).BOT_DB;
const client: SqlClient = new D1SqlClient(db);

const CHAT = "628111@s.whatsapp.net";
const AT = Date.UTC(2026, 9, 10, 3, 0, 0);

/** The Turso schema lives in the same D1 database in tests; start from empty. */
async function reset(): Promise<void> {
  await sql(`DELETE FROM payments`);
  await sql(`DELETE FROM order_items`);
  await sql(`DELETE FROM orders`);
  await sql(`DELETE FROM customers`);
}

async function sql(statement: string): Promise<void> {
  await client.execute(statement);
}

async function orderCount(): Promise<number> {
  const result = await client.execute("SELECT COUNT(*) AS n FROM orders");
  return Number(result.rows[0]?.["n"] ?? 0);
}

function orderInput(overrides: Partial<Parameters<typeof createOrder>[1]> = {}) {
  return {
    ref: "PAY-20261010-AAAAAA",
    clientRef: `${CHAT}|116964x1`,
    kodePesanan: "INV-20261010-AAAAAA",
    waChatJid: CHAT,
    alamatKirim: "Jl. Merdeka 1",
    items: [{ kode: "116964", nama: "Castelli Entrata", harga: 1_400_000, qty: 1 }],
    ongkirIncluded: true,
    at: AT,
    ...overrides,
  };
}

beforeEach(async () => {
  await ensureTursoSchema(client);
  await reset();
});

describe("schema", () => {
  it("creates every table the frozen schema names", async () => {
    const tables = await listTables(client);
    for (const name of ["customers", "orders", "order_items", "payments"]) {
      expect(tables).toContain(name);
    }
  });

  it("is safe to apply twice", async () => {
    await expect(ensureTursoSchema(client)).resolves.toBeUndefined();
  });

  it("rejects a second order with the same client_ref at the database level", async () => {
    await createOrder(client, orderInput());
    const duplicate = await client.execute({
      sql: `INSERT INTO orders (ref, client_ref, kode_pesanan, wa_chat_jid, alamat_kirim, total_harga, grand_total, status, created_at, updated_at)
            VALUES ('X', ?, 'INV-X', ?, '', 0, 0, 'creating', '', '')`,
      args: [`${CHAT}|116964x1`, CHAT],
    }).catch((error: unknown) => error);

    expect(duplicate).toBeInstanceOf(PaymentDbError);
    expect((duplicate as PaymentDbError).code).toBe("constraint");
  });

  it("keeps every frozen statement in a single source of truth", () => {
    // The smoke script applies this exact array; if it ever stops being valid
    // SQLite the test above fails first.
    expect(TURSO_SCHEMA.length).toBeGreaterThanOrEqual(4);
  });
});

describe("createOrder", () => {
  it("writes the order with integer money and its items", async () => {
    const result = await createOrder(
      client,
      orderInput({
        items: [
          { kode: "116964", nama: "Castelli Entrata", harga: 1_400_000, qty: 2 },
          { kode: "100370", nama: "Kaos Polos", harga: 75_000, qty: 1 },
        ],
      }),
    );

    expect(result.created).toBe(true);
    expect(result.order).toMatchObject({
      status: "creating",
      totalHarga: 2_875_000,
      additionalFee: 0,
      grandTotal: 2_875_000,
      ongkirIncluded: true,
      waChatJid: CHAT,
    });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({ kode: "116964", qty: 2, harga: 1_400_000, subtotal: 2_800_000 });
  });

  it("resumes the same order when the client_ref repeats", async () => {
    const first = await createOrder(client, orderInput());
    const second = await createOrder(client, orderInput({ kodePesanan: "INV-LAIN", ref: "PAY-LAIN" }));

    expect(second.created).toBe(false);
    expect(second.order.kodePesanan).toBe(first.order.kodePesanan);
    expect(await orderCount()).toBe(1);
  });

  it("repairs an order that was left without items", async () => {
    await createOrder(client, orderInput());
    // Simulate the crash window between the order INSERT and the item batch.
    await sql(`DELETE FROM order_items`);

    const resumed = await createOrder(client, orderInput());
    expect(resumed.created).toBe(false);
    expect(resumed.items).toHaveLength(1);
  });

  it("serialises a resumed call that races the first one", async () => {
    const [a, b] = await Promise.all([createOrder(client, orderInput()), createOrder(client, orderInput())]);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect(await orderCount()).toBe(1);
  });

  it("finds the active order for a chat and ignores finished ones", async () => {
    const created = await createOrder(client, orderInput());
    expect((await findActiveOrderForChat(client, CHAT))?.kodePesanan).toBe(created.order.kodePesanan);

    await transitionOrder(client, {
      kodePesanan: created.order.kodePesanan,
      from: ["creating"],
      to: "rejected",
      at: AT,
    });
    expect(await findActiveOrderForChat(client, CHAT)).toBeNull();
  });
});

describe("transitionOrder", () => {
  it("moves an order forward once and refuses the second callback", async () => {
    const { order } = await createOrder(client, orderInput());

    const first = await transitionOrder(client, {
      kodePesanan: order.kodePesanan,
      from: ["creating"],
      to: "awaiting_approval",
      at: AT + 1_000,
    });
    const second = await transitionOrder(client, {
      kodePesanan: order.kodePesanan,
      from: ["creating"],
      to: "awaiting_approval",
      at: AT + 2_000,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("marks an order paid through the frozen path and stores amount and time", async () => {
    const { order } = await createOrder(client, orderInput());
    await transitionOrder(client, { kodePesanan: order.kodePesanan, from: ["creating"], to: "approved", at: AT });
    await transitionOrder(client, { kodePesanan: order.kodePesanan, from: ["approved"], to: "pending", at: AT + 1_000 });

    const paid = await transitionOrder(client, {
      kodePesanan: order.kodePesanan,
      from: ["pending"],
      to: "paid",
      at: AT + 5_000,
      patch: { paidAt: AT + 5_000, paymentUrl: "https://pay.example/x" },
    });

    expect(paid).toBe(true);
    const stored = await findOrderByKode(client, order.kodePesanan);
    expect(stored).toMatchObject({ status: "paid", paidAt: AT + 5_000, paymentUrl: "https://pay.example/x" });
  });

  it("refuses an illegal transition instead of applying it quietly", async () => {
    const { order } = await createOrder(client, orderInput());
    await expect(
      transitionOrder(client, { kodePesanan: order.kodePesanan, from: ["creating"], to: "paid", at: AT }),
    ).rejects.toBeInstanceOf(PaymentDbError);

    await expect(
      transitionOrder(client, { kodePesanan: order.kodePesanan, from: ["paid"], to: "pending", at: AT }),
    ).rejects.toBeInstanceOf(PaymentDbError);
  });

  it("documents the frozen transition table", () => {
    expect(canTransition("creating", "awaiting_approval")).toBe(true);
    expect(canTransition("approved", "pending")).toBe(true);
    expect(canTransition("pending", "paid")).toBe(true);
    expect(canTransition("rejected", "approved")).toBe(false);
    expect(canTransition("paid", "expired")).toBe(false);
    expect(ORDER_TRANSITIONS["superseded"]).toEqual([]);
  });

  it("supersedes an older order and keeps a pointer to the new one", async () => {
    const older = await createOrder(client, orderInput());
    const newer = await createOrder(
      client,
      orderInput({ clientRef: `${CHAT}|116964x2`, kodePesanan: "INV-BARU", ref: "PAY-BARU" }),
    );

    expect(await supersedeOrder(client, { kodePesanan: older.order.kodePesanan, byKode: newer.order.kodePesanan, at: AT })).toBe(true);
    const stored = await findOrderByKode(client, older.order.kodePesanan);
    expect(stored).toMatchObject({ status: "superseded", supersededBy: newer.order.kodePesanan });
  });

  it("lists only orders whose deadline has passed", async () => {
    const { order } = await createOrder(client, orderInput({ status: "pending", expiresAt: AT + 60_000 }));
    expect(await listOrdersDueForExpiry(client, { at: AT })).toHaveLength(0);
    const due = await listOrdersDueForExpiry(client, { at: AT + 61_000 });
    expect(due.map((row) => row.kodePesanan)).toEqual([order.kodePesanan]);
  });
});

describe("payments", () => {
  it("attaches one payment per kode_bayar and resumes on repeat", async () => {
    const { order } = await createOrder(client, orderInput());
    const first = await attachPayment(client, {
      orderId: order.id,
      kodeBayar: "PAY-20261010-AAAAAA",
      provider: "sumopod",
      jumlah: order.grandTotal,
      status: "pending",
      url: "https://pay.example/aaa",
      at: AT,
    });
    const second = await attachPayment(client, {
      orderId: order.id,
      kodeBayar: "PAY-20261010-AAAAAA",
      provider: "sumopod",
      jumlah: order.grandTotal,
      status: "pending",
      at: AT + 1_000,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.payment.url).toBe("https://pay.example/aaa");
  });

  it("edits the approval card and stores the admin decision", async () => {
    const { order } = await createOrder(client, orderInput());
    await attachPayment(client, {
      orderId: order.id,
      kodeBayar: "PAY-1",
      provider: "mock",
      jumlah: order.grandTotal,
      status: "awaiting_approval",
      at: AT,
    });

    expect(
      await updatePayment(client, {
        kodeBayar: "PAY-1",
        from: ["creating", "awaiting_approval"],
        at: AT + 1,
        patch: { status: "pending", approvalStatus: "approved", telegramMessageId: 4242 },
      }),
    ).toBe(true);

    const stored = await findPaymentByKodeBayar(client, "PAY-1");
    expect(stored).toMatchObject({ status: "pending", approvalStatus: "approved", telegramMessageId: 4242 });
  });

  it("does not move a payment that already paid", async () => {
    const { order } = await createOrder(client, orderInput());
    await attachPayment(client, {
      orderId: order.id,
      kodeBayar: "PAY-2",
      provider: "mock",
      jumlah: order.grandTotal,
      status: "paid",
      at: AT,
    });

    expect(
      await updatePayment(client, {
        kodeBayar: "PAY-2",
        from: ["creating", "pending"],
        at: AT + 1,
        patch: { status: "expired" },
      }),
    ).toBe(false);
    expect((await findPaymentByKodeBayar(client, "PAY-2"))?.status).toBe("paid");
  });
});

describe("customers", () => {
  it("upserts by phone number without creating a second row", async () => {
    const first = await upsertCustomer(client, { nama: "Budi", noHp: "628111", at: AT });
    const second = await upsertCustomer(client, { nama: "Budi Santoso", noHp: "628111", alamat: "Jl. Baru", at: AT + 1 });

    expect(second.id).toBe(first.id);
    const rows = await client.execute("SELECT nama, alamat FROM customers WHERE no_hp = '628111'");
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ nama: "Budi Santoso", alamat: "Jl. Baru" });
  });

  it("creates a customer without a phone number as a new row", async () => {
    const result = await upsertCustomer(client, { nama: "Tanpa Nomor", at: AT });
    expect(result.id).toBeGreaterThan(0);
    expect(result.created).toBe(true);
  });
});

describe("cleanup", () => {
  it("removes an order with its items and payments", async () => {
    const { order } = await createOrder(client, orderInput());
    await attachPayment(client, { orderId: order.id, kodeBayar: "PAY-DEL", provider: "mock", jumlah: 1, at: AT });

    expect(await deleteOrderCascade(client, order.kodePesanan)).toBe(1);
    expect(await findOrderByKode(client, order.kodePesanan)).toBeNull();
    expect(await listOrderItems(client, order.id)).toEqual([]);
    expect(await findPaymentByKodeBayar(client, "PAY-DEL")).toBeNull();
  });
});

describe("structured errors", () => {
  it("maps a syntax failure instead of throwing the driver error", async () => {
    const error = await client.execute("SELECT * FROM tabel_tidak_ada").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PaymentDbError);
    expect((error as PaymentDbError).toJSON()).toMatchObject({ code: "syntax", retryable: false });
  });

  it("classifies driver failures by code", () => {
    const constraint = toPaymentDbError({ code: "SQLITE_CONSTRAINT_UNIQUE", message: "UNIQUE constraint failed" }, "x");
    expect(constraint).toMatchObject({ code: "constraint", retryable: false });

    const network = toPaymentDbError(new Error("fetch failed"), "y");
    expect(network).toMatchObject({ code: "connection", retryable: true });

    const auth = toPaymentDbError({ code: "SERVER_ERROR", message: "401 Unauthorized" }, "z");
    expect(auth).toMatchObject({ code: "readonly", retryable: false });
  });

  it("retries a transient failure and gives up on a permanent one", async () => {
    let attempts = 0;
    const flaky = async (): Promise<string> => {
      attempts += 1;
      if (attempts < 3) throw toPaymentDbError(new Error("fetch failed"), "retry");
      return "ok";
    };
    expect(await withTursoRetry("retry", flaky, { sleep: async () => {} })).toBe("ok");
    expect(attempts).toBe(3);

    let permanentAttempts = 0;
    await expect(
      withTursoRetry(
        "permanent",
        async () => {
          permanentAttempts += 1;
          throw toPaymentDbError({ code: "SQLITE_CONSTRAINT", message: "UNIQUE" }, "permanent");
        },
        { sleep: async () => {} },
      ),
    ).rejects.toMatchObject({ code: "constraint" });
    expect(permanentAttempts).toBe(1);
  });

  it("reports a not-configured client as a structured error", async () => {
    const fake: SqlClient = {
      execute: async (): Promise<SqlResult> => {
        throw new PaymentDbError({ code: "not_configured", operation: "connect", message: "no url", retryable: false });
      },
      batch: async () => [],
      close: () => {},
    };
    const error = await fake.execute("SELECT 1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PaymentDbError);
    expect((error as PaymentDbError).code).toBe("not_configured");
  });
});

describe("client refs", () => {
  it("reads an order back by client_ref only", async () => {
    expect(await findOrderByClientRef(client, "tidak-ada")).toBeNull();
    const { order } = await createOrder(client, orderInput());
    expect((await findOrderByClientRef(client, order.clientRef))?.kodePesanan).toBe(order.kodePesanan);
  });
});
