'use client';

import { useState, useEffect, useCallback, useRef, useContext, createContext } from 'react';
import { useRouter } from 'next/navigation';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3300';

// ネットワークエラーかどうかを判定
function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) {
    const message = error.message.toLowerCase();
    return (
      message.includes('failed to fetch') ||
      message.includes('network') ||
      message.includes('connection')
    );
  }
  return false;
}

// サーバーエラー（5xx）かどうかを判定
function isServerError(status: number): boolean {
  return status >= 500 && status < 600;
}

interface User {
  id: string;
  username: string;
  email: string;
  name: string;
  image?: string;
  status: number;
  createdAt: string;
}

interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
}

// 接続エラーハンドラーのコンテキスト（connection-contextとは別に、オプショナルに使用）
interface ConnectionErrorHandlers {
  setNetworkError: (error?: string) => void;
  setServerError: (error?: string) => void;
  setConnected: () => void;
  registerRetryCallback: (callback: () => void) => void;
}

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
      const response = await fetch(`${API_BASE_URL}/api/v2/auth/me`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        setAuthState({
          user: data.user,
          isLoading: false,
          isAuthenticated: true,
        });
        // 接続成功を通知
        connectionHandlers?.setConnected();
      } else if (isServerError(response.status)) {
        // サーバーエラー（5xx）: トークンはクリアせず、サーバーエラーを通知
        connectionHandlers?.setServerError(
          `サーバーエラーが発生しました (${response.status})`
        );
        // ローディング状態は解除するが、認証状態は維持
        setAuthState((prev) => ({
          ...prev,
          isLoading: false,
        }));
      } else {
        // 認証エラー（401等）: トークンをクリア
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
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
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        setAuthState({
          user: null,
          isLoading: false,
          isAuthenticated: false,
        });
      }
    }
  }, [connectionHandlers]);

  const logout = useCallback(async () => {
    const accessToken = localStorage.getItem('accessToken');
    const refreshToken = localStorage.getItem('refreshToken');

    // Call logout API if we have a token
    if (accessToken) {
      try {
        await fetch(`${API_BASE_URL}/api/v2/auth/logout`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ refreshToken }),
        });
      } catch {
        // Ignore errors, we'll clear tokens anyway
      }
    }

    // Clear tokens
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');

    setAuthState({
      user: null,
      isLoading: false,
      isAuthenticated: false,
    });

    router.push('/login');
  }, [router]);

  // リトライコールバックを登録
  useEffect(() => {
    if (connectionHandlers) {
      connectionHandlers.registerRetryCallback(fetchUser);
    }
  }, [connectionHandlers, fetchUser]);

  useEffect(() => {
    // Initial auth check on mount - valid pattern for client-side authentication
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchUser();
  }, [fetchUser]);

  return {
    ...authState,
    logout,
    refetch: fetchUser,
  };
}
