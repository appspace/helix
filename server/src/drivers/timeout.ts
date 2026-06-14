import { DriverError } from './interface.js';

/** Human-readable rendering of a timeout used in the surfaced error message. */
export function timeoutLabel(timeoutMs: number): string {
  if (timeoutMs >= 60_000 && timeoutMs % 60_000 === 0) return `${timeoutMs / 60_000}m`;
  if (timeoutMs >= 1000) return `${Math.round(timeoutMs / 1000)}s`;
  return `${timeoutMs}ms`;
}

/** The error surfaced to the client when a query is cancelled for exceeding its deadline. */
export function timeoutError(timeoutMs: number, cause?: unknown): DriverError {
  return new DriverError(
    `Query cancelled: exceeded the ${timeoutLabel(timeoutMs)} timeout.`,
    'transient',
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Race a query promise against a deadline. When the timer wins, `onTimeout` is
 * invoked — drivers use it to cancel the in-flight statement on the server
 * (MySQL `KILL QUERY`, Postgres `pg_cancel_backend`) — and the returned promise
 * rejects with a `transient` DriverError carrying the reason. A falsy or
 * non-positive `timeoutMs` disables the timeout and `work` is returned as-is.
 *
 * `Promise.race` keeps a rejection handler attached to `work`, so the statement's
 * eventual error (it settles shortly after `onTimeout` cancels it) is consumed
 * here and never surfaces as an unhandled rejection.
 */
export function withQueryTimeout<T>(
  work: Promise<T>,
  timeoutMs: number | undefined,
  onTimeout: () => void,
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return work;

  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout(); } catch { /* best-effort cancel — the timeout still surfaces */ }
      reject(timeoutError(timeoutMs));
    }, timeoutMs);
  });

  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}
