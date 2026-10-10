/**
 * The narrow SQL seam between the order/payment repositories and whatever
 * database actually answers.
 *
 * Two implementations exist:
 *
 *   libsql-client.ts   @libsql/client/web — the production path (HTTP, no
 *                      Cloudflare binding, works from any Worker)
 *   tests              a D1-backed adapter, so the repository code and the DDL
 *                      are exercised by the real SQLite engine in workerd
 *
 * Keeping the interface this small is what makes the second implementation
 * possible: `execute` and `batch` are all the repositories use, and neither
 * returns anything a D1 adapter cannot produce.
 *
 * Errors are normalised into `PaymentDbError`. A raw `LibsqlError` carries
 * library-specific fields (`code`, `extendedCode`, `cause`) that no caller can
 * branch on without importing the driver, so the mapping happens here once and
 * the callers get a stable `{ code, retryable, operation }` shape instead.
 */

export type SqlValue = string | number | bigint | boolean | null | Uint8Array | Date;

export interface SqlStatement {
  sql: string;
  args?: readonly SqlValue[];
}

export type SqlStatementInput = string | SqlStatement;

export interface SqlResult {
  /** Rows as plain objects keyed by column name. */
  rows: Array<Record<string, SqlValue>>;
  rowsAffected: number;
  /** Undefined when the statement did not insert into a rowid table. */
  lastInsertRowid: number | null;
}

export interface SqlClient {
  execute(statement: SqlStatementInput): Promise<SqlResult>;
  /** Runs the statements in one implicit transaction when the driver supports it. */
  batch(statements: readonly SqlStatementInput[]): Promise<SqlResult[]>;
  close(): void;
}

export type PaymentDbErrorCode =
  | "not_configured"
  | "connection"
  | "constraint"
  | "readonly"
  | "syntax"
  | "unknown";

/** Stable shape every Turso failure is mapped onto. */
export class PaymentDbError extends Error {
  readonly code: PaymentDbErrorCode;
  readonly retryable: boolean;
  readonly operation: string;
  readonly detail: string;

  constructor(input: {
    code: PaymentDbErrorCode;
    operation: string;
    message: string;
    detail?: string;
    retryable?: boolean;
  }) {
    super(input.message);
    this.name = "PaymentDbError";
    this.code = input.code;
    this.operation = input.operation;
    this.detail = input.detail ?? "";
    this.retryable = input.retryable ?? (input.code === "connection");
  }

  /** Log-safe object: never contains credentials, only the shape of the failure. */
  toJSON(): Record<string, unknown> {
    return { code: this.code, operation: this.operation, retryable: this.retryable, message: this.message };
  }
}

/** Maps a driver error onto `PaymentDbError` without importing the driver type. */
export function toPaymentDbError(error: unknown, operation: string): PaymentDbError {
  const detail = describeError(error);
  const code = typeof (error as { code?: unknown })?.code === "string" ? String((error as { code: string }).code) : "";
  const extended =
    typeof (error as { extendedCode?: unknown })?.extendedCode === "string"
      ? String((error as { extendedCode: string }).extendedCode)
      : "";
  const text = `${code} ${extended} ${detail}`.toUpperCase();

  if (text.includes("CONSTRAINT") || text.includes("UNIQUE")) {
    return new PaymentDbError({ code: "constraint", operation, message: "unique constraint violated", detail, retryable: false });
  }
  if (text.includes("READONLY") || text.includes("AUTH") || text.includes("UNAUTHORIZED") || text.includes("401") || text.includes("403")) {
    return new PaymentDbError({
      code: "readonly",
      operation,
      message: "database rejected the credentials or the write",
      detail,
      retryable: false,
    });
  }
  if (text.includes("SYNTAX") || text.includes("NO SUCH TABLE") || text.includes("NO SUCH COLUMN")) {
    return new PaymentDbError({ code: "syntax", operation, message: "statement rejected by the database", detail, retryable: false });
  }
  if (
    text.includes("FETCH") ||
    text.includes("NETWORK") ||
    text.includes("TIMEOUT") ||
    text.includes("ECONN") ||
    text.includes("SERVER_ERROR") ||
    text.includes("PROTOCOL") ||
    text.includes("5")
  ) {
    return new PaymentDbError({ code: "connection", operation, message: "could not reach the database", detail, retryable: true });
  }
  return new PaymentDbError({ code: "unknown", operation, message: detail === "" ? "database failure" : detail, detail });
}

/** Message of any thrown value: `Error`, `{ message }`, or a bare string. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  const message = (error as { message?: unknown })?.message;
  if (typeof message === "string" && message !== "") return message;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/** Runs `operation` with a bounded retry for transient (connection) failures. */
export async function withTursoRetry<T>(
  operation: string,
  run: () => Promise<T>,
  options: { attempts?: number; sleep?: (ms: number) => Promise<void>; onRetry?: (error: PaymentDbError, attempt: number) => void } = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let last: PaymentDbError | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await run();
    } catch (error) {
      const mapped = error instanceof PaymentDbError ? error : toPaymentDbError(error, operation);
      last = mapped;
      if (!mapped.retryable || attempt === attempts) break;
      options.onRetry?.(mapped, attempt);
      await sleep(250 * 2 ** (attempt - 1));
    }
  }

  throw last ?? new PaymentDbError({ code: "unknown", operation, message: "database failure" });
}

/** Convenience: `execute` with arguments, error-mapped. */
export async function sqlOne(
  client: SqlClient,
  operation: string,
  sql: string,
  args: readonly SqlValue[] = [],
): Promise<SqlResult> {
  try {
    return await client.execute({ sql, args });
  } catch (error) {
    throw toPaymentDbError(error, operation);
  }
}

/** Convenience: `batch` with error mapping. */
export async function sqlBatch(
  client: SqlClient,
  operation: string,
  statements: readonly SqlStatement[],
): Promise<SqlResult[]> {
  try {
    return await client.batch(statements);
  } catch (error) {
    throw toPaymentDbError(error, operation);
  }
}

/** Normalises driver-specific values (bigint rowids, ArrayBuffer blobs). */
export function asNumber(value: SqlValue | undefined, fallback = 0): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

export function asText(value: SqlValue | undefined, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return fallback;
}

export function asNullableText(value: SqlValue | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = asText(value, "");
  return text === "" ? null : text;
}
