/**
 * Per-request timeout for fetch, kept in its own module (no
 * `@crowi/api-contract` import) so it can be unit-tested in isolation and so
 * `is-network-error.ts` can read the sentinel without dragging the hc client
 * into the test graph.
 *
 * A connection that opens but never responds (a hung backend, a stalled
 * reverse proxy) would otherwise leave `await fetch` pending forever, freezing
 * the UI on a spinner. The AbortController below caps that wait so the failure
 * surfaces as an error the connection-error plumbing can react to.
 */

const DEFAULT_API_TIMEOUT_MS = 20_000;

function resolveTimeoutMs(): number {
  const raw = process.env.NEXT_PUBLIC_API_TIMEOUT_MS;
  if (!raw) return DEFAULT_API_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_API_TIMEOUT_MS;
}

/** Resolved default timeout (`NEXT_PUBLIC_API_TIMEOUT_MS` override or 20s). */
export const API_TIMEOUT_MS = resolveTimeoutMs();

/**
 * Sentinel abort reason used to mark an abort as *our timeout* rather than a
 * user-/react-query-initiated cancel. `isNetworkError` (lib/is-network-error.ts)
 * inspects `signal.reason` for this value so a timeout is classified as a
 * connection problem while ordinary cancels are not.
 */
export const TIMEOUT_ABORT_REASON = 'crowi:timeout' as const;

/**
 * Run `fetch` with a timeout, composing the caller's `signal` (if any) with an
 * internal timeout controller via `AbortSignal.any` so an existing
 * abort/cancel still works AND a hang is bounded. Falls back to manual
 * listener wiring on runtimes without `AbortSignal.any`.
 */
export async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit | undefined, timeoutMs: number = API_TIMEOUT_MS): Promise<Response> {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(TIMEOUT_ABORT_REASON), timeoutMs);

  const callerSignal = init?.signal ?? undefined;
  let signal: AbortSignal;
  let cleanupComposite: (() => void) | undefined;

  if (callerSignal) {
    if (typeof AbortSignal.any === 'function') {
      signal = AbortSignal.any([callerSignal, timeoutController.signal]);
    } else {
      // Manual fallback: forward whichever fires first onto a fresh controller.
      const composite = new AbortController();
      const onAbort = (source: AbortSignal) => composite.abort(source.reason);
      const onCaller = () => onAbort(callerSignal);
      const onTimeout = () => onAbort(timeoutController.signal);
      callerSignal.addEventListener('abort', onCaller);
      timeoutController.signal.addEventListener('abort', onTimeout);
      cleanupComposite = () => {
        callerSignal.removeEventListener('abort', onCaller);
        timeoutController.signal.removeEventListener('abort', onTimeout);
      };
      signal = composite.signal;
    }
  } else {
    signal = timeoutController.signal;
  }

  try {
    return await fetch(input, { ...init, signal });
  } finally {
    clearTimeout(timer);
    cleanupComposite?.();
  }
}
