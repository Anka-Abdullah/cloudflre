/**
 * Retry backoff for the queue consumer.
 *
 * Cloudflare Queues retries a message until `max_retries` is reached and then
 * routes it to the dead-letter queue, so the worker only decides *when* the next
 * attempt happens. Jitter avoids a thundering herd when a downstream outage
 * fails a whole batch at once.
 */
export interface BackoffOptions {
  baseSeconds: number;
  maxSeconds: number;
  /** Injectable randomness so tests get deterministic delays. */
  random?: () => number;
}

export function retryDelaySeconds(attempts: number, options: BackoffOptions): number {
  const { baseSeconds, maxSeconds, random = Math.random } = options;
  const safeAttempts = Math.max(1, Math.min(attempts, 20));
  const exponential = baseSeconds * 2 ** (safeAttempts - 1);
  const capped = Math.min(exponential, maxSeconds);
  const jitter = Math.floor(random() * baseSeconds);
  return Math.max(1, Math.min(capped + jitter, 86_400));
}
