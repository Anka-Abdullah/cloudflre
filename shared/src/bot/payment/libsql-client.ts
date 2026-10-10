/**
 * The production `SqlClient`: Turso over HTTP with `@libsql/client/web`.
 *
 * `/web` is imported on purpose. The default entry (`@libsql/client`) picks the
 * Node build, which uses `node:net`/`node:fs` and cannot be bundled into a
 * Worker; the `/web` build is fetch-only, which is exactly the transport a Worker
 * has. The repository code never imports this file — it takes a `SqlClient` — so
 * the tests can run the same repositories against D1 without pulling the driver
 * into the test bundle.
 *
 * Lifecycle: one client per isolate, created lazily on first use. libSQL's HTTP
 * client is stateless per request, so there is nothing to reconnect; `close()`
 * exists only to satisfy the interface.
 */
import { createClient, type Client, type InStatement, type InValue } from "@libsql/client/web";
import { PaymentDbError, type SqlClient, type SqlResult, type SqlStatementInput, type SqlValue } from "./sql";

export interface TursoConnection {
  url: string;
  authToken: string;
}

/** True when both halves of the credential are present. */
export function tursoConfigured(connection: Partial<TursoConnection>): boolean {
  return typeof connection.url === "string" && connection.url.trim() !== "" && typeof connection.authToken === "string" && connection.authToken.trim() !== "";
}

function toStatement(input: SqlStatementInput): InStatement {
  if (typeof input === "string") return input;
  return { sql: input.sql, args: [...(input.args ?? [])] as InValue[] };
}

function toResult(result: { rows: Array<Record<string, unknown>>; rowsAffected: number; lastInsertRowid?: bigint }): SqlResult {
  return {
    rows: result.rows.map((row) => ({ ...row }) as Record<string, SqlValue>),
    rowsAffected: result.rowsAffected,
    lastInsertRowid: result.lastInsertRowid === undefined ? null : Number(result.lastInsertRowid),
  };
}

/** Wraps a libSQL client into the narrow `SqlClient` the repositories use. */
export function sqlClientFromLibsql(client: Client): SqlClient {
  return {
    async execute(statement) {
      try {
        return toResult(await client.execute(toStatement(statement)));
      } catch (error) {
        throw wrap(error, "execute");
      }
    },
    async batch(statements) {
      try {
        const results = await client.batch(statements.map(toStatement));
        return results.map(toResult);
      } catch (error) {
        throw wrap(error, "batch");
      }
    },
    close() {
      try {
        client.close();
      } catch {
        // Closing an HTTP client is a no-op; a failure here cannot affect the
        // request that already finished.
      }
    },
  };
}

/** Keeps the driver error type out of the call sites (see `sql.ts`). */
function wrap(error: unknown, operation: string): PaymentDbError {
  const detail = error instanceof Error ? error.message : String(error);
  const code = typeof (error as { code?: unknown })?.code === "string" ? String((error as { code: string }).code) : "";
  const mapped = code === "" ? detail : `${code}: ${detail}`;
  return new PaymentDbError({
    code: /AUTH|UNAUTHORIZED|401|403|SERVER_ERROR|NETWORK|FETCH|PROTOCOL|TIMEOUT|5\d\d/i.test(mapped)
      ? /AUTH|UNAUTHORIZED|401|403/i.test(mapped)
        ? "readonly"
        : "connection"
      : /CONSTRAINT|UNIQUE/i.test(mapped)
        ? "constraint"
        : "unknown",
    operation,
    message: mapped,
    detail,
    retryable: /SERVER_ERROR|NETWORK|FETCH|PROTOCOL|TIMEOUT|5\d\d|ECONN/i.test(mapped),
  });
}

export interface CreateTursoClientOptions extends TursoConnection {
  /** Request timeout in milliseconds; libSQL itself applies none. */
  timeoutMs?: number;
}

/**
 * Creates the HTTP client. Throws a structured `PaymentDbError` when the
 * configuration is incomplete, so a caller can decide between "degrade" and
 * "fail" without string-matching the driver.
 *
 * `intMode: "number"` is explicit: every integer in this schema (rupiah, epoch
 * milliseconds, row ids) is far below 2^53, and a `bigint` leaking into a JSON
 * response would be a serialisation error at the edge.
 */
export function createTursoSqlClient(options: CreateTursoClientOptions): SqlClient {
  if (!tursoConfigured(options)) {
    throw new PaymentDbError({
      code: "not_configured",
      operation: "connect",
      message: "TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must both be set",
      retryable: false,
    });
  }

  const timeoutMs = options.timeoutMs ?? 15_000;
  const client = createClient({
    url: options.url,
    authToken: options.authToken,
    intMode: "number",
    // A hung request would otherwise hold a queue message until the visibility
    // timeout; failing at 15 s lets the caller retry with a fresh attempt.
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      fetch(input as RequestInfo, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
  });
  return sqlClientFromLibsql(client);
}
