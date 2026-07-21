'use client';

import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode, useEffect, useMemo } from 'react';
import { ThemeProvider } from '@/components/theme-provider';
import { AuthSync } from './auth-sync';
import { ConnectionProvider, useConnection } from './connection-context';
import { getConnectionErrorHandlers, setConnectionErrorHandlers } from './connection-error-ref';
import { isNetworkError, isServerErrorStatus } from './is-network-error';

/**
 * Extract an HTTP status from a thrown error, if it carries one.
 *
 * Most query hooks throw a plain `Error('Failed to fetch X')` that does NOT
 * carry the status, so 5xx aggregation at this layer is best-effort: it only
 * fires for errors that expose a numeric `status` / `statusCode`. The reliable
 * signal here is network/timeout (a thrown TypeError / timeout AbortError),
 * which `isNetworkError` classifies. 5xx surfacing for hooks that swallow the
 * status remains the responsibility of the `useAuth` path (which inspects
 * `response.status`) and each component's own `isError` rendering. See the
 * task's open question on this.
 */
function extractStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null) {
    const status = (error as { status?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

/**
 * 4xx → no retry (the request is wrong, retrying won't help). 5xx / network /
 * timeout → retry a couple of times for transient blips. Anything else → also
 * retry sparingly. Keeps spinner→error transitions snappy for hard errors.
 */
function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  const status = extractStatus(error);
  if (status !== undefined && status >= 400 && status < 500) {
    return false;
  }
  return failureCount < 2;
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        const handlers = getConnectionErrorHandlers();
        if (!handlers) return;

        const status = extractStatus(error);

        // 401 is handled by the api-client refresh interceptor; never surface
        // it here (double-handling / spurious banners).
        if (status === 401) return;

        if (isNetworkError(error)) {
          handlers.setNetworkError();
          return;
        }

        if (isServerErrorStatus(status)) {
          handlers.setServerError();
        }
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 60 * 1000, // 1 minute
        refetchOnWindowFocus: false,
        retry: shouldRetryQuery,
      },
      // Mutations stay no-retry (default) to avoid duplicate writes.
    },
  });
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createQueryClient);

  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <ConnectionProvider>
          <ConnectionErrorBridge>
            {/* Single mounted island for all auth-state listeners (session
                expiry / cross-tab logout / token refresh / retry). Kept out of
                the thin `useAuth` so the listeners register once, not 15×. */}
            <AuthSync />
            {children}
          </ConnectionErrorBridge>
        </ConnectionProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

// ConnectionContext の値を module-level ref (connection-error-ref.ts) に書き、
// React ツリー外の QueryCache.onError / fetchMe (use-auth) から参照できるように
// するブリッジ。以前あった ConnectionErrorContext (React Context) は consumer が
// いなくなった (両者とも module ref を読む) ため撤去した。
function ConnectionErrorBridge({ children }: { children: ReactNode }) {
  const connection = useConnection();

  const errorHandlers = useMemo(
    () => ({
      setNetworkError: connection.setNetworkError,
      setServerError: connection.setServerError,
      setConnected: connection.setConnected,
      registerRetryCallback: connection.registerRetryCallback,
    }),
    [connection.setNetworkError, connection.setServerError, connection.setConnected, connection.registerRetryCallback],
  );

  // Keep the module-level ref pointed at the live handlers so QueryCache.onError
  // (constructed outside this tree) reaches the current ConnectionProvider.
  useEffect(() => {
    setConnectionErrorHandlers(errorHandlers);
    return () => setConnectionErrorHandlers(null);
  }, [errorHandlers]);

  return <>{children}</>;
}
