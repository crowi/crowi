import { TIMEOUT_ABORT_REASON } from './fetch-timeout';

/**
 * Classify a thrown error as a *connection problem* (server unreachable /
 * request hung) as opposed to an application error or a deliberate cancel.
 *
 * Two shapes count as a network error:
 *
 * 1. A `TypeError` from `fetch` ("Failed to fetch" / DNS / connection refused).
 * 2. An `AbortError` whose abort reason is our timeout sentinel
 *    (`TIMEOUT_ABORT_REASON`). A request that opened but never responded is a
 *    connection problem from the user's point of view.
 *
 * Deliberately *excluded*: AbortErrors from user navigation or react-query
 * query cancellation. Those abort with a different (or absent) reason, so we
 * must not treat them as a network outage and pop a connection banner.
 */
export function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) {
    const message = error.message.toLowerCase();
    return message.includes('failed to fetch') || message.includes('network') || message.includes('connection');
  }

  if (isTimeoutAbort(error)) {
    return true;
  }

  return false;
}

/**
 * True when the error is an `AbortError` caused by our fetch timeout (not by a
 * user-/react-query-initiated cancel). The abort reason is the timeout
 * sentinel; DOMException-based AbortErrors don't expose it, so we also accept
 * a thrown error that *is* the sentinel reason.
 */
export function isTimeoutAbort(error: unknown): boolean {
  if (error === TIMEOUT_ABORT_REASON) return true;
  const abortError = error as { name?: unknown; reason?: unknown } | null;
  return abortError?.name === 'AbortError' && abortError.reason === TIMEOUT_ABORT_REASON;
}

/** True when an HTTP status falls in the 5xx server-error range. */
export function isServerErrorStatus(status: number | undefined): status is number {
  return status !== undefined && status >= 500 && status < 600;
}
