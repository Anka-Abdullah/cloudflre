#!/usr/bin/env node
/**
 * `pnpm run mock:turso [-- --port 8899 --db <file>]`
 *
 * A local stand-in for Turso: an HTTP server that speaks the libSQL "hrana"
 * pipeline protocol on top of a real SQLite file (Node's built-in `node:sqlite`).
 *
 * Why it exists: the whole payment path (`@libsql/client/web` → Turso) is a
 * network dependency, and the work order forbids waiting for credentials. With
 * this server, `TURSO_DATABASE_URL=http://127.0.0.1:8899` makes the Worker talk to
 * a real database — real SQL, real transactions, real UNIQUE constraints — so
 * checkout, approval, payment and the receipt can be exercised end to end before
 * a Turso account exists.
 *
 * It is a development/E2E tool, not a Turso replacement: no replication, no auth
 * (any bearer token is accepted), no cursors, no WebSocket streams, and it binds
 * to 127.0.0.1 only.
 *
 * Endpoints:
 *   POST /v2/pipeline        the protocol the driver speaks
 *   GET  /__health           { ok, tables, path }
 *   POST /__reset            drop every table (fresh state for a test run)
 *   GET  /__rows?sql=…       run one SELECT and print JSON (debugging/E2E asserts)
 */
import { DatabaseSync } from "node:sqlite";
import http from "node:http";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

function flagValue(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : (argv[index + 1] ?? fallback);
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.error("usage: node scripts/mock-turso.mjs [--port 8899] [--db .wrangler/turso/mock.db] [--quiet]");
  process.exit(0);
}

const port = Number(flagValue(argv, "--port", "8899"));
const dbPath = resolve(flagValue(argv, "--db", ".wrangler/turso/mock.db"));
const quiet = argv.includes("--quiet");

mkdirSync(dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);

/** hrana value → JS value (what node:sqlite accepts as a bound parameter). */
function fromProto(value) {
  if (value === null || value === undefined) return null;
  switch (value.type) {
    case "null":
      return null;
    case "integer":
      return Number(value.value);
    case "float":
      return Number(value.value);
    case "text":
      return String(value.value);
    case "blob":
      return Buffer.from(String(value.value), "base64");
    default:
      throw new Error(`unsupported hrana value type ${JSON.stringify(value.type)}`);
  }
}

/** JS value → hrana value. */
function toProto(value) {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "bigint") return { type: "integer", value: value.toString() };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { type: "integer", value: String(value) } : { type: "float", value };
  }
  if (typeof value === "boolean") return { type: "integer", value: value ? "1" : "0" };
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return { type: "blob", value: Buffer.from(value).toString("base64") };
  }
  return { type: "text", value: String(value) };
}

function isReadStatement(sql) {
  return /^\s*(select|with|pragma|explain|values|insert|update|delete)/i.test(sql) === false
    ? false
    : /^\s*(select|with|pragma|explain|values)/i.test(sql);
}

/** Runs one prepared statement and returns the hrana `StmtResult`. */
function runStatement(stmt, { wantRows }) {
  const sql = stmt.sql;
  const args = [...(stmt.args ?? []).map(fromProto), ...namedArgs(stmt.named_args)];
  const prepared = db.prepare(sql);

  if (wantRows !== false && isReadStatement(sql)) {
    const rows = prepared.all(...args);
    const names = rows.length > 0 ? Object.keys(rows[0]) : columnNames(prepared);
    return {
      cols: names.map((name) => ({ name, decltype: null })),
      rows: rows.map((row) => names.map((name) => toProto(row[name]))),
      affected_row_count: 0,
      last_insert_rowid: null,
    };
  }

  const info = prepared.run(...args);
  return {
    cols: [],
    rows: [],
    affected_row_count: Number(info.changes ?? 0),
    last_insert_rowid: info.lastInsertRowid === undefined ? null : String(info.lastInsertRowid),
  };
}

function namedArgs(named) {
  return (named ?? []).map((entry) => fromProto(entry.value));
}

/** Best-effort column names for a SELECT that returned no rows. */
function columnNames(prepared) {
  try {
    const row = prepared.all();
    return row.length > 0 ? Object.keys(row[0]) : [];
  } catch {
    return [];
  }
}

function errorProto(error) {
  return { message: error instanceof Error ? error.message : String(error), code: null };
}

/** Evaluates a batch step condition against the results so far. */
function conditionMet(condition, results, errors) {
  if (!condition) return true;
  if (condition.type === "ok") return errors[condition.step] === null && results[condition.step] !== undefined;
  if (condition.type === "error") return errors[condition.step] !== null;
  if (condition.type === "not") return !conditionMet(condition.cond, results, errors);
  if (condition.type === "and") return condition.conds.every((cond) => conditionMet(cond, results, errors));
  if (condition.type === "or") return condition.conds.some((cond) => conditionMet(cond, results, errors));
  return true;
}

/** Statement registry for `store_sql` + `batch`. */
const storedSql = new Map();

function handleRequest(request) {
  switch (request.type) {
    case "execute": {
      const result = runStatement(request.stmt, { wantRows: request.stmt.want_rows });
      return { type: "ok", response: { type: "execute", result } };
    }
    case "batch": {
      const steps = request.batch.steps ?? [];
      const results = [];
      const errors = [];
      for (let index = 0; index < steps.length; index++) {
        const step = steps[index];
        if (!conditionMet(step.condition, results, errors)) {
          results.push(null);
          errors.push(null);
          continue;
        }
        try {
          const stmt = step.stmt.sql_id === undefined ? step.stmt : { ...step.stmt, sql: storedSql.get(step.stmt.sql_id) ?? "" };
          results.push(runStatement(stmt, { wantRows: stmt.want_rows }));
          errors.push(null);
        } catch (error) {
          results.push(null);
          errors.push(errorProto(error));
        }
      }
      return { type: "ok", response: { type: "batch", result: { step_results: results, step_errors: errors } } };
    }
    case "store_sql": {
      storedSql.set(request.sql_id, request.sql);
      return { type: "ok", response: { type: "store_sql" } };
    }
    case "close_sql": {
      storedSql.delete(request.sql_id);
      return { type: "ok", response: { type: "close_sql" } };
    }
    case "close":
      return { type: "ok", response: { type: "close" } };
    case "describe": {
      // Only used for parameter metadata; answering "no params" is enough here.
      return { type: "ok", response: { type: "describe", result: { params: [], cols: [], is_explain: false, is_readonly: true } } };
    }
    case "sequence": {
      return { type: "ok", response: { type: "sequence" } };
    }
    default:
      return { type: "error", error: { message: `unsupported request type ${JSON.stringify(request.type)}`, code: null } };
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

  if (url.pathname === "/__health") {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row.name);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: dbPath, tables }));
    return;
  }

  if (url.pathname === "/__reset") {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => row.name);
    db.exec("PRAGMA foreign_keys = OFF");
    for (const table of tables) db.exec(`DROP TABLE IF EXISTS "${table}"`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, dropped: tables.length }));
    return;
  }

  if (url.pathname === "/__rows") {
    const sql = url.searchParams.get("sql") ?? "";
    try {
      const rows = db.prepare(sql).all();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, rows }));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(error) }));
    }
    return;
  }

  if (req.method !== "POST" || url.pathname !== "/v2/pipeline") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: `not found: ${req.method} ${url.pathname}` }));
    return;
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: `invalid json: ${String(error)}` }));
      return;
    }

    const requests = parsed.requests ?? [];
    const results = requests.map((request) => {
      try {
        const result = handleRequest(request);
        if (!quiet && request.type === "execute") {
          process.stdout.write(`[mock-turso] ${String(request.stmt?.sql ?? "").slice(0, 100).replace(/\s+/g, " ")}\n`);
        }
        return result;
      } catch (error) {
        return { type: "error", error: errorProto(error) };
      }
    });

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ results }));
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`[mock-turso] listening on http://127.0.0.1:${port} (db ${dbPath})\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
