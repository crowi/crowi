'use client';

import { RefreshCw, Wifi, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useConnection } from '@/lib/connection-context';

export function ConnectionBanner() {
  const { state, error, retryIn, retry } = useConnection();

  // 接続正常時は何も表示しない
  if (state === 'connected') {
    return null;
  }

  // ネットワークエラー時のみバナーを表示（サーバーエラーはモーダルで表示）
  if (state !== 'network-error') {
    return null;
  }

  return (
    <div
      className="fixed top-0 left-0 right-0 z-50 animate-in slide-in-from-top duration-300"
      role="alert"
      aria-live="polite"
    >
      <div className="bg-amber-500 text-amber-950 px-4 py-3 shadow-lg">
        <div className="max-w-4xl mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <WifiOff className="h-5 w-5 shrink-0" aria-hidden="true" />
            <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3">
              <span className="font-medium">
                {error || 'ネットワーク接続に問題があります'}
              </span>
              <span className="text-amber-900 text-sm">
                {retryIn > 0 ? (
                  <>次のリトライ: {retryIn}秒後</>
                ) : (
                  <>リトライ中...</>
                )}
              </span>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={retry}
            className="bg-amber-100 border-amber-600 text-amber-900 hover:bg-amber-200 hover:text-amber-950 shrink-0"
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            今すぐ再接続
          </Button>
        </div>
      </div>
    </div>
  );
}

// 復旧時のアニメーション付きバナー（オプション）
export function ConnectionRestoredBanner({
  show,
  onHide,
}: {
  show: boolean;
  onHide: () => void;
}) {
  if (!show) {
    return null;
  }

  // 3秒後に自動的に非表示
  setTimeout(onHide, 3000);

  return (
    <div
      className="fixed top-0 left-0 right-0 z-50 animate-in slide-in-from-top duration-300"
      role="status"
      aria-live="polite"
    >
      <div className="bg-green-500 text-green-950 px-4 py-3 shadow-lg">
        <div className="max-w-4xl mx-auto flex items-center gap-3">
          <Wifi className="h-5 w-5 shrink-0" aria-hidden="true" />
          <span className="font-medium">接続が回復しました</span>
        </div>
      </div>
    </div>
  );
}
