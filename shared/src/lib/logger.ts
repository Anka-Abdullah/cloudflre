/**
 * Structured logging: one JSON object per line so `wrangler tail`, Workers Logs
 * and Logpush can index fields without a parsing layer.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export function createLogger(scope: Record<string, unknown>, sink: (line: string) => void = console.log): Logger {
  const emit = (level: LogLevel, event: string, fields?: Record<string, unknown>): void => {
    sink(
      JSON.stringify({
        ts: new Date().toISOString(),
        level,
        event,
        ...scope,
        ...(fields ?? {}),
      }),
    );
  };
  return {
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  };
}
