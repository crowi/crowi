'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode, useMemo } from 'react';
import { ConnectionProvider, useConnection } from './connection-context';
import { ConnectionErrorContext } from './use-auth';

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000, // 1 minute
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ConnectionProvider>
        <ConnectionErrorBridge>{children}</ConnectionErrorBridge>
      </ConnectionProvider>
    </QueryClientProvider>
  );
}

// ConnectionContextの値をConnectionErrorContextに橋渡しするコンポーネント
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

  return <ConnectionErrorContext.Provider value={errorHandlers}>{children}</ConnectionErrorContext.Provider>;
}
