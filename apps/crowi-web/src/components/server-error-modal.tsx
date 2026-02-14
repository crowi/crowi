'use client';

import { AlertTriangle, RefreshCw, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useConnection } from '@/lib/connection-context';

export function ServerErrorModal() {
  const { state, error, retryIn, retry, retryCount } = useConnection();

  // サーバーエラー時のみ表示
  const isOpen = state === 'server-error';

  return (
    <Dialog open={isOpen}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-md"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader className="text-center sm:text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100">
            <AlertTriangle className="h-6 w-6 text-red-600" aria-hidden="true" />
          </div>
          <DialogTitle className="text-xl">サーバーエラー</DialogTitle>
          <DialogDescription className="text-base">
            {error || 'APIサーバーに問題が発生しています。'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <p className="text-center text-muted-foreground text-sm">
            しばらく経っても回復しない場合は、
            <br />
            システム管理者にお問い合わせください。
          </p>

          <div className="flex flex-col items-center gap-3 pt-2">
            {retryIn > 0 ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                <span className="text-sm">
                  再接続を試みています... (次のリトライ: {retryIn}秒後)
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                <span className="text-sm">リトライ中...</span>
              </div>
            )}

            <Button
              variant="outline"
              size="sm"
              onClick={retry}
              className="mt-2"
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              今すぐ再接続
            </Button>

            {retryCount > 0 && (
              <p className="text-xs text-muted-foreground">
                リトライ回数: {retryCount}
              </p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
