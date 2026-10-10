#!/usr/bin/env node
/**
 * `pnpm run smoke:turso -- --number <nomor>`
 *
 * Proves the Turso path end to end against a real database: connect, apply the
 * schema, insert a dummy order (customer + order + items + payment), read it
 * back, prove the conditional UPDATE is idempotent on a second call, then delete
 * the dummy and confirm the tables are empty again.
 *
 * Two modes:
 *
 *   credentials present   TURSO_DATABASE_URL + TURSO_AUTH_TOKEN (environment, or
 *                         the instance's .dev.vars with --local-secrets) → talks
 *                         to the real database over HTTP with
 *                         `@libsql/client/web`, the same driver and the same
 *                         transport the Worker uses.
 *   no credentials        applies the identical DDL and the identical statements
 *                         to a local SQLite file through Node's built-in
 *                         `node:sqlite`. That verifies the schema and every
 *                         statement without an account, which is what makes this
 *                         script useful before Turso is provisioned.
 *
 * The DDL is imported from `shared/src/bot/payment/schema.ts` in both modes, so
 * the schema exercised here is byte-for-byte the schema the Worker applies. The
 * repository-level behaviour (resume, transitions, error mapping) is covered by
 * `shared/test/payment-turso.test.ts` against the real SQLite engine.
 */
import { DatabaseSync } from "node:sqlite";
import { readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cloudflareRoot, parseNumberArg, stateDir } from "./lib.mjs";
import { TURSO_SCHEMA } from "../shared/src/bot/payment/schema.ts";

const LOCAL_DB = join(stateDir, "turso-smoke.db");

function flagValue(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : (argv[index + 1] ?? null);
}

function usage() {
  console.error("usage: pnpm run smoke:turso -- --number <nomor> [options]");
  console.error("  --url <libsql://…>   database URL (default $TURSO_DATABASE_URL)");
  console.error("  --token <token>      auth token (default $TURSO_AUTH_TOKEN)");
  console.error("  --local-secrets      read both from <nomor>/.dev.vars");
  console.error("  --keep               keep the local SQLite file (local mode only)");
}

/** Reads TURSO_* from the instance's .dev.vars without printing the values. */
async function readDevVars(instanceDir) {
  const content = await readFile(join(instanceDir, ".dev.vars"), "utf8");
  const pick = (name) => {
    const match = new RegExp(`^${name}=(.*)$`, "m").exec(content);
    return match ? match[1].trim() : "";
  };
  return { url: pick("TURSO_DATABASE_URL"), token: pick("TURSO_AUTH_TOKEN") };
}

/** A tiny adapter so both drivers expose execute/batch/close to the smoke run. */
function localClient(path) {
  const db = new DatabaseSync(path);
  const norm = (statement) =>
    typeof statement === "string" ? { sql: statement, args: [] } : { sql: statement.sql, args: statement.args ?? [] };

  return {
    label: `local sqlite (${path})`,
    async execute(statement) {
      const { sql, args } = norm(statement);
      const prepared = db.prepare(sql);
      const isRead = /^\s*(select|with|pragma|explain|values)/i.test(sql);
      const rows = isRead ? prepared.all(...args) : (prepared.run(...args), []);
      const rowsAffected = isRead ? 0 : Number(db.prepare("SELECT changes() AS n").get()?.n ?? 0);
      return { rows, rowsAffected, lastInsertRowid: null };
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await this.execute(statement));
      return results;
    },
    close() {
      db.close();
    },
  };
}

async function tursoClient(url, token) {
  const { createClient } = await import("@libsql/client/web");
  const client = createClient({ url, authToken: token, intMode: "number" });
  return {
    label: `turso (${url.replace(/\?.*$/, "")})`,
    async execute(statement) {
      const result = await client.execute(statement);
      return {
        rows: result.rows.map((row) => ({ ...row })),
        rowsAffected: result.rowsAffected,
        lastInsertRowid: result.lastInsertRowid === undefined ? null : Number(result.lastInsertRowid),
      };
    },
    async batch(statements) {
      const results = await client.batch(statements);
      return results.map((result) => ({
        rows: result.rows.map((row) => ({ ...row })),
        rowsAffected: result.rowsAffected,
        lastInsertRowid: result.lastInsertRowid === undefined ? null : Number(result.lastInsertRowid),
      }));
    },
    close() {
      client.close();
    },
  };
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function runSmoke(client) {
  const tag = `SMOKE-${Date.now().toString(36).toUpperCase()}`;
  const clientRef = `smoke|${tag}`;
  const kodePesanan = `INV-${tag}`;
  const kodeBayar = `PAY-${tag}`;
  const now = new Date();
  const iso = now.toISOString();

  console.log(`\n1. memastikan schema (${TURSO_SCHEMA.length} statement) …`);
  await client.batch(TURSO_SCHEMA.map((sql) => ({ sql })));
  const tables = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const names = tables.rows.map((row) => row.name);
  for (const expected of ["customers", "orders", "order_items", "payments"]) {
    check(names.includes(expected), `tabel ${expected} tidak ada setelah ensure schema`);
  }
  console.log(`   ok: ${names.join(", ")}`);

  console.log("\n2. menulis order dummy (customer + order + 2 item + payment) …");
  const customer = await client.execute({
    sql: `INSERT INTO customers (nama, no_hp, alamat, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    args: ["Smoke Test", `62${Date.now()}`, "Jl. Uji 1", iso, iso],
  });
  const customerId = Number(customer.lastInsertRowid ?? 0);

  const orderInsert = await client.execute({
    sql: `INSERT INTO orders
            (ref, client_ref, kode_pesanan, wa_chat_jid, customer_id, alamat_kirim,
             total_harga, additional_fee, grand_total, ongkir_included, status, expires_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 1, 'creating', ?, ?, ?)`,
    args: ["PAY-" + tag, clientRef, kodePesanan, "628000@s.whatsapp.net", customerId || null, "Jl. Uji 1", 1_475_000, 1_475_000, now.getTime() + 86_400_000, iso, iso],
  });
  check(orderInsert.rowsAffected === 1, `insert order gagal (rowsAffected=${orderInsert.rowsAffected})`);

  const order = await client.execute({ sql: "SELECT id, status FROM orders WHERE client_ref = ?", args: [clientRef] });
  const orderId = Number(order.rows[0]?.id ?? 0);
  check(orderId > 0, "order tidak bisa dibaca kembali setelah insert");

  await client.batch([
    {
      sql: `INSERT INTO order_items (order_id, kode, nama_produk, harga, qty, subtotal) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [orderId, "116964", "Castelli Entrata", 1_400_000, 1, 1_400_000],
    },
    {
      sql: `INSERT INTO order_items (order_id, kode, nama_produk, harga, qty, subtotal) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [orderId, "100370", "Kaos Polos", 75_000, 1, 75_000],
    },
    {
      sql: `INSERT INTO payments (order_id, kode_bayar, provider, url, jumlah, status, created_at, updated_at)
            VALUES (?, ?, 'mock', ?, ?, 'pending', ?, ?)`,
      args: [orderId, kodeBayar, `https://example.test/dry-run/${kodeBayar}`, 1_475_000, iso, iso],
    },
  ]);

  console.log("\n3. membaca kembali …");
  const read = await client.execute({
    sql: `SELECT o.kode_pesanan, o.status, o.grand_total,
                 (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS items,
                 (SELECT COUNT(*) FROM payments p WHERE p.order_id = o.id) AS payments
            FROM orders o WHERE o.client_ref = ?`,
    args: [clientRef],
  });
  const row = read.rows[0];
  check(row, "order dummy hilang setelah ditulis");
  check(Number(row.items) === 2, `jumlah item salah: ${row.items}`);
  check(Number(row.payments) === 1, `jumlah payment salah: ${row.payments}`);
  check(Number(row.grand_total) === 1_475_000, `grand_total salah: ${row.grand_total}`);
  console.log(`   ok: ${row.kode_pesanan} status=${row.status} total=${row.grand_total} items=${row.items} payments=${row.payments}`);

  console.log("\n4. membuktikan UPDATE kondisional idempoten (dua callback) …");
  const first = await client.execute({
    sql: `UPDATE orders SET status = 'awaiting_approval', updated_at = ? WHERE kode_pesanan = ? AND status IN ('creating')`,
    args: [iso, kodePesanan],
  });
  const second = await client.execute({
    sql: `UPDATE orders SET status = 'awaiting_approval', updated_at = ? WHERE kode_pesanan = ? AND status IN ('creating')`,
    args: [iso, kodePesanan],
  });
  check(first.rowsAffected === 1, "transisi pertama tidak mengubah baris");
  check(second.rowsAffected === 0, "callback kedua ikut mengubah baris (idempotensi bocor)");
  console.log("   ok: callback pertama 1 baris, callback kedua 0 baris");

  console.log("\n5. menghapus dummy …");
  await client.batch([
    { sql: "DELETE FROM payments WHERE order_id = ?", args: [orderId] },
    { sql: "DELETE FROM order_items WHERE order_id = ?", args: [orderId] },
    { sql: "DELETE FROM orders WHERE id = ?", args: [orderId] },
    ...(customerId > 0 ? [{ sql: "DELETE FROM customers WHERE id = ?", args: [customerId] }] : []),
  ]);

  const leftovers = await client.execute({ sql: "SELECT COUNT(*) AS n FROM orders WHERE client_ref = ?", args: [clientRef] });
  check(Number(leftovers.rows[0]?.n ?? 0) === 0, "order dummy masih ada setelah delete");
  console.log("   ok: dummy bersih");

  return { tag, kodePesanan, kodeBayar };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    usage();
    return;
  }

  const slug = argv.some((arg) => arg === "--number" || arg === "-n" || /^[0-9]{8,}$/.test(arg))
    ? parseNumberArg(argv)
    : null;
  const instanceDir = slug ? join(cloudflareRoot, slug) : null;
  const keep = argv.includes("--keep");

  let url = flagValue(argv, "--url") ?? process.env.TURSO_DATABASE_URL ?? "";
  let token = flagValue(argv, "--token") ?? process.env.TURSO_AUTH_TOKEN ?? "";

  if ((!url || !token) && instanceDir && existsSync(join(instanceDir, ".dev.vars"))) {
    const dev = await readDevVars(instanceDir);
    url = url || dev.url;
    token = token || dev.token;
  }

  const usable = url !== "" && token !== "" && !url.includes("your-db") && !token.startsWith("dev-");
  const client = usable ? await tursoClient(url, token) : localClient(LOCAL_DB);

  console.log(`turso smoke${slug ? ` (${slug})` : ""}`);
  console.log(`target : ${client.label}`);
  if (!usable) {
    console.log("catatan: TURSO_DATABASE_URL/TURSO_AUTH_TOKEN tidak diisi (atau masih placeholder),");
    console.log("         jadi DDL + seluruh statement dijalankan pada SQLite lokal lewat node:sqlite.");
    console.log("         Isi kredensial asli untuk menguji database sungguhan.");
  }

  try {
    const result = await runSmoke(client);
    console.log(`\nSMOKE OK (${result.kodePesanan})`);
  } finally {
    client.close();
    if (!usable && !keep) await rm(LOCAL_DB, { force: true });
  }
}

main().catch((error) => {
  console.error(`\nSMOKE GAGAL: ${error.message}`);
  process.exit(1);
});
