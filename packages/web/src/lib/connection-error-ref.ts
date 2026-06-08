/**
 * Module-level bridge between the QueryClient's `QueryCache.onError` callback
 * and the React-tree `ConnectionProvider`.
 *
 * Why a module-level ref instead of Context: the `QueryClient` is constructed
 * in `providers.tsx`'s `useState` initializer, *before* (and outside) the
 * `ConnectionProvider` that lives below it in the tree. `onError` therefore
 * cannot read a React Context. Instead, `ConnectionErrorBridge` pushes the
 * latest Context handlers here via `setConnectionErrorHandlers`, and
 * `onError` pulls them with `getConnectionErrorHandlers`.
 *
 * This mirrors the existing module-level signal pattern already used for
 * session-reauth (`session-reauth-context.ts`).
 */

export interface ConnectionErrorHandlers {
  setNetworkError: (error?: string) => void;
  setServerError: (error?: string) => void;
  setConnected: () => void;
  registerRetryCallback: (callback: () => void) => void;
}

let handlers: ConnectionErrorHandlers | null = null;

/** Called by ConnectionErrorBridge to keep the ref pointed at the live handlers. */
export function setConnectionErrorHandlers(next: ConnectionErrorHandlers | null): void {
  handlers = next;
}

/** Read the current handlers from outside the React tree (e.g. QueryCache.onError). */
export function getConnectionErrorHandlers(): ConnectionErrorHandlers | null {
  return handlers;
}
