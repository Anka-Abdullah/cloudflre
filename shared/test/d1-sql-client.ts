/**
 * A `SqlClient` backed by D1, for tests.
 *
 * Why this exists: the order/payment repositories talk to Turso in production,
 * but the SQL they emit is ordinary SQLite — and D1 *is* SQLite, available inside
 * the Workers test runtime with no account, no network and no credentials. So the
 * tests run the real DDL and the real repository code against a real engine, and
 * the only untested part is the HTTP transport of `@libsql/client/web` (which
 * `scripts/turso-smoke.mjs` covers against a real database when one is
 * configured).
 *
 * It is deliberately a thin translation, not a simulator: the same SQL goes to
 * the same engine, so a passing test means the statement is valid, not that the
 * fake agreed with itself.
 */
import { toPaymentDbError, type SqlClient, type SqlResult, type SqlStatementInput, type SqlValue } from "../src/bot/payment/sql";

/** D1 accepts null, number, string, ArrayBuffer — not booleans or typed arrays. */
function toD1Value(value: SqlValue): string | number | null | ArrayBuffer {
  if (value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Uint8Array) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function normalise(statement: SqlStatementInput): { sql: string; args: SqlValue[] } {
  if (typeof statement === "string") return { sql: statement, args: [] };
  return { sql: statement.sql, args: [...(statement.args ?? [])] };
}

function fromD1(result: D1Result<unknown>): SqlResult {
  const rows = Array.isArray(result.results) ? (result.results as Array<Record<string, SqlValue>>) : [];
  return {
    rows,
    rowsAffected: result.meta?.changes ?? 0,
    lastInsertRowid: result.meta?.last_row_id === undefined ? null : Number(result.meta.last_row_id),
  };
}

/** `true` for statements whose result set matters (they must be run with `.all()`). */
function readsRows(sql: string): boolean {
  return /^\s*(select|with|pragma|explain|values)/i.test(sql);
}

export class D1SqlClient implements SqlClient {
  constructor(private readonly db: D1Database) {}

  async execute(statement: SqlStatementInput): Promise<SqlResult> {
    const { sql, args } = normalise(statement);
    try {
      const prepared = this.db.prepare(sql).bind(...args.map(toD1Value));
      if (readsRows(sql)) return fromD1(await prepared.all());
      return fromD1(await prepared.run());
    } catch (error) {
      // Same contract as the production driver: a failure is a structured
      // PaymentDbError, so a test can branch on `code` exactly like the worker.
      throw toPaymentDbError(error, "execute");
    }
  }

  /**
   * D1's own `batch` is a transaction (it rolls back as a unit), which is the
   * behaviour the repositories rely on for order + items and for the DDL sweep.
   */
  async batch(statements: readonly SqlStatementInput[]): Promise<SqlResult[]> {
    const normalised = statements.map(normalise);
    if (normalised.length === 0) return [];

    // DDL through `batch` is rejected by D1 ("not supported in batch"), so it is
    // executed one statement at a time. The schema statements are all
    // `IF NOT EXISTS`, which is what makes that safe.
    const ddl = normalised.filter((entry) => /^\s*(create|drop|alter)/i.test(entry.sql));
    const rest = normalised.filter((entry) => !/^\s*(create|drop|alter)/i.test(entry.sql));

    const results: SqlResult[] = [];
    try {
      for (const entry of ddl) {
        results.push(fromD1(await this.db.prepare(entry.sql).bind().run()));
      }
      if (rest.length > 0) {
        const prepared = rest.map((entry) => this.db.prepare(entry.sql).bind(...entry.args.map(toD1Value)));
        for (const result of await this.db.batch(prepared)) results.push(fromD1(result));
      }
    } catch (error) {
      throw toPaymentDbError(error, "batch");
    }
    return results;
  }

  close(): void {
    // Nothing to release: the binding is owned by the test runtime.
  }
}
