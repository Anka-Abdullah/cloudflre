/**
 * Test seams used by more than one test file.
 *
 * The interesting one is `withFetchStub`. Worker code builds its own clients from
 * `env` (WuzAPI, Telegram, the payment gateway), so a test that goes through
 * `SELF.fetch` cannot inject anything by hand. Routing every outbound call
 * through `globalThis.fetch` (see `worker-entry.ts`) gives tests exactly one
 * place to intercept, without any production code knowing about tests.
 */
import type { WorkerDeps } from "../src/worker";

export type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** The string form of whatever the caller passed as the first `fetch` argument. */
export function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

interface StubHolder {
  __WUZIP_FETCH_STUB__?: FetchStub;
}

/** Installs a stub; returns a function that restores the previous one. */
export function setFetchStub(stub: FetchStub | null): () => void {
  const holder = globalThis as unknown as StubHolder;
  const previous = holder.__WUZIP_FETCH_STUB__;
  if (stub === null) delete holder.__WUZIP_FETCH_STUB__;
  else holder.__WUZIP_FETCH_STUB__ = stub;
  return () => {
    if (previous === undefined) delete holder.__WUZIP_FETCH_STUB__;
    else holder.__WUZIP_FETCH_STUB__ = previous;
  };
}

/** Runs `body` with `stub` installed, restoring the previous stub afterwards. */
export async function withFetchStub(stub: FetchStub, body: () => Promise<void>): Promise<void> {
  const restore = setFetchStub(stub);
  try {
    await body();
  } finally {
    restore();
  }
}

export interface JsonStubResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * Builds a fetch stub from a route table. Paths are matched by suffix, which is
 * enough for the handful of endpoints the worker calls and keeps the tests
 * readable.
 */
export function stubRoutes(routes: Record<string, JsonStubResponse | ((init?: RequestInit) => JsonStubResponse)>): {
  stub: FetchStub;
  calls: Array<{ url: string; body: unknown }>;
} {
  const calls: Array<{ url: string; body: unknown }> = [];
  const stub: FetchStub = async (input, init) => {
    const url = requestUrl(input);
    let parsed: unknown = null;
    if (typeof init?.body === "string" && init.body !== "") {
      try {
        parsed = JSON.parse(init.body) as unknown;
      } catch {
        parsed = init.body;
      }
    }
    calls.push({ url, body: parsed });

    const match = Object.entries(routes).find(([path]) => url.endsWith(path) || url.includes(path));
    if (!match) return new Response(JSON.stringify({ error: `no stub for ${url}` }), { status: 404 });

    const spec = typeof match[1] === "function" ? match[1](init) : match[1];
    return new Response(typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body ?? {}), {
      status: spec.status ?? 200,
      headers: { "content-type": "application/json", ...(spec.headers ?? {}) },
    });
  };
  return { stub, calls };
}

/** The deps a test worker should be created with. */
export function testWorkerDeps(): WorkerDeps {
  return {
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const stub = (globalThis as unknown as StubHolder).__WUZIP_FETCH_STUB__;
      if (stub) return await stub(input, init);
      return await fetch(input as RequestInfo, init);
    }) as typeof fetch,
  };
}
