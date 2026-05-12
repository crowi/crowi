'use client';

import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';

export type ConnectionState = 'connected' | 'network-error' | 'server-error';

interface ConnectionContextType {
  state: ConnectionState;
  error: string | null;
  retryCount: number;
  retryIn: number; // 次のリトライまでの秒数
  retry: () => void;
  setNetworkError: (error?: string) => void;
  setServerError: (error?: string) => void;
  setConnected: () => void;
  registerRetryCallback: (callback: () => void) => void;
}

const ConnectionContext = createContext<ConnectionContextType | null>(null);

// リトライ間隔（秒）: 5秒→10秒→30秒→1分→2分
const RETRY_INTERVALS = [5, 10, 30, 60, 120];

function getRetryInterval(retryCount: number): number {
  return RETRY_INTERVALS[Math.min(retryCount, RETRY_INTERVALS.length - 1)];
}

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConnectionState>('connected');
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [retryIn, setRetryIn] = useState(0);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const countdownIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const retryCallbackRef = useRef<(() => void) | null>(null);

  // クリーンアップ関数
  const clearTimers = useCallback(() => {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
  }, []);

  // 接続成功時の処理
  const setConnected = useCallback(() => {
    clearTimers();
    setState('connected');
    setError(null);
    setRetryCount(0);
    setRetryIn(0);
  }, [clearTimers]);

  // リトライコールバックを登録
  const registerRetryCallback = useCallback((callback: () => void) => {
    retryCallbackRef.current = callback;
  }, []);

  // リトライのスケジュール
  const scheduleRetry = useCallback(
    (count: number) => {
      clearTimers();
      const interval = getRetryInterval(count);
      setRetryIn(interval);

      // カウントダウン
      countdownIntervalRef.current = setInterval(() => {
        setRetryIn((prev) => {
          if (prev <= 1) {
            if (countdownIntervalRef.current) {
              clearInterval(countdownIntervalRef.current);
              countdownIntervalRef.current = null;
            }
            return 0;
          }
          return prev - 1;
        });
      }, 1000);

      // リトライ実行
      retryTimeoutRef.current = setTimeout(() => {
        if (retryCallbackRef.current) {
          retryCallbackRef.current();
        }
      }, interval * 1000);
    },
    [clearTimers],
  );

  // ネットワークエラー設定
  const setNetworkError = useCallback(
    (errorMessage?: string) => {
      clearTimers(); // ステート更新前にクリア
      setState('network-error');
      setError(errorMessage || 'ネットワーク接続に問題があります');
      // 既にエラー状態の場合はリトライカウントを増加
      setRetryCount((prev) => {
        const newCount = state !== 'connected' ? prev + 1 : 0;
        scheduleRetry(newCount);
        return newCount;
      });
    },
    [state, scheduleRetry, clearTimers],
  );

  // サーバーエラー設定
  const setServerError = useCallback(
    (errorMessage?: string) => {
      clearTimers(); // ステート更新前にクリア
      setState('server-error');
      setError(errorMessage || 'サーバーに問題が発生しています');
      setRetryCount((prev) => {
        const newCount = state !== 'connected' ? prev + 1 : 0;
        scheduleRetry(newCount);
        return newCount;
      });
    },
    [state, scheduleRetry, clearTimers],
  );

  // 手動リトライ
  const retry = useCallback(() => {
    clearTimers();
    setRetryIn(0);
    if (retryCallbackRef.current) {
      retryCallbackRef.current();
    }
  }, [clearTimers]);

  // コンポーネントアンマウント時のクリーンアップ
  useEffect(() => {
    return () => {
      clearTimers();
    };
  }, [clearTimers]);

  const contextValue = {
    state,
    error,
    retryCount,
    retryIn,
    retry,
    setNetworkError,
    setServerError,
    setConnected,
    registerRetryCallback,
  };

  return <ConnectionContext.Provider value={contextValue}>{children}</ConnectionContext.Provider>;
}

export function useConnection() {
  const context = useContext(ConnectionContext);
  if (!context) {
    throw new Error('useConnection must be used within a ConnectionProvider');
  }
  return context;
}
