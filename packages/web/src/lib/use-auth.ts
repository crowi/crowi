'use client';

import { useState, useEffect, useCallback, useRef, useContext, createContext } from 'react';
import { useRouter } from 'next/navigation';
import { apiClientV2 } from './api-client';
import { clearTokens, getRefreshToken } from './auth-token';
import { isNetworkError, isServerErrorStatus } from './is-network-error';
import type { ConnectionErrorHandlers } from './connection-error-ref';

interface User {
  id: string;
  username: string;
  email: string;
  name: string;
  image?: string;
  status: number;
  admin?: boolean;
  createdAt: string;
}

interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
}

// 接続エラーハンドラーのコンテキスト（connection-contextとは別に、オプショナルに使用）
// 型は connection-error-ref.ts と共有する（QueryCache.onError の module-level
// ブリッジでも同じハンドラ形を使うため）。
const ConnectionErrorContext = createContext<ConnectionErrorHandlers | null>(null);

export function useConnectionErrorHandlers(): ConnectionErrorHandlers | null {
  return useContext(ConnectionErrorContext);
}

export { ConnectionErrorContext };

export function useAuth() {
  const router = useRouter();
  const initialCheckDone = useRef(false);
  const [authState, setAuthState] = useState<AuthState>({
    user: null,
    isLoading: true,
    isAuthenticated: false,
  });

  // ConnectionErrorHandlers をオプショナルに取得
  const connectionHandlers = useConnectionErrorHandlers();

  const fetchUser = useCallback(async () => {
    const accessToken = localStorage.getItem('accessToken');

    if (!accessToken) {
      setAuthState({
        user: null,
        isLoading: false,
        isAuthenticated: false,
      });
      return;
    }

    // If we have a token, assume authenticated to avoid flicker while verifying
    if (!initialCheckDone.current) {
      initialCheckDone.current = true;
      setAuthState((prev) => ({
        ...prev,
        isAuthenticated: true,
      }));
    }

    try {
      // Use apiClientV2 (`hc<AppType>`) so the 401 → /auth/refresh → retry
      // interceptor in `api-client.ts` runs. Raw `fetch` here used to
      // bypass it and log the user out as soon as the 15-minute access
      // token expired — even when a fresh refresh token was available.
      const response = await apiClientV2.auth.me.$get();

      if (response.ok) {
        const data = await response.json();
        setAuthState({
          user: data.user,
          isLoading: false,
          isAuthenticated: true,
        });
        // 接続成功を通知
        connectionHandlers?.setConnected();
      } else if (isServerErrorStatus(response.status)) {
        // サーバーエラー（5xx）: トークンはクリアせず、サーバーエラーを通知
        connectionHandlers?.setServerError(`サーバーエラーが発生しました (${response.status})`);
        // ローディング状態は解除するが、認証状態は維持
        setAuthState((prev) => ({
          ...prev,
          isLoading: false,
        }));
      } else {
        // 認証エラー（401等）: トークンをクリア
        clearTokens();
        setAuthState({
          user: null,
          isLoading: false,
          isAuthenticated: false,
        });
      }
    } catch (error) {
      // ネットワークエラー: トークンはクリアせず、エラーを通知
      if (isNetworkError(error)) {
        connectionHandlers?.setNetworkError();
        // ローディング状態は解除するが、認証状態は維持
        setAuthState((prev) => ({
          ...prev,
          isLoading: false,
        }));
      } else {
        // その他のエラー: 安全のためログアウト
        clearTokens();
        setAuthState({
          user: null,
          isLoading: false,
          isAuthenticated: false,
        });
      }
    }
    // connectionHandlersは依存配列に含めない（最新の値は常に参照される）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const logout = useCallback(async () => {
    const refreshToken = getRefreshToken();

    // Call logout API if we have a token. `apiClientV2` attaches the
    // Authorization header and refreshes on 401 transparently; logout
    // failures are non-fatal — we clear tokens locally regardless.
    try {
      await apiClientV2.auth.logout.$post({
        json: refreshToken ? { refreshToken } : {},
      });
    } catch {
      // Ignore — local cleanup happens below either way.
    }

    // Clear tokens
    clearTokens();

    setAuthState({
      user: null,
      isLoading: false,
      isAuthenticated: false,
    });

    router.push('/login');
  }, [router]);

  // リトライコールバックを登録（初回のみ）
  useEffect(() => {
    if (connectionHandlers) {
      connectionHandlers.registerRetryCallback(fetchUser);
    }
    // fetchUserは常に最新の関数が参照されるため、初回登録のみでよい
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  return {
    ...authState,
    logout,
    refetch: fetchUser,
  };
}
