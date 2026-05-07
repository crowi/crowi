'use client';

import { AlertTriangle, CheckCircle2, KeyRound, Loader2, ShieldAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useCryptoStatus, useReencryptSensitive } from '@/lib/use-admin-crypto';

/**
 * Admin dashboard banner for the at-rest encryption migration. Shows one of:
 *
 * - the env key is not configured → setup hint with the generate command
 * - one or more sensitive Config rows are still plaintext → re-encrypt button
 * - everything is already encrypted → success line
 *
 * The card disappears entirely when no sensitive rows exist yet (= fresh
 * install with no admin-saved secrets) so first-time admins don't see noise.
 */
export function CryptoStatusCard() {
  const { data, isLoading } = useCryptoStatus();
  const reencrypt = useReencryptSensitive();

  if (isLoading || !data) {
    return null;
  }

  const { encryptionConfigured, unencryptedCount, encryptedCount } = data;

  // 1) Key not set
  if (!encryptionConfigured) {
    return (
      <Alert className="border-amber-300 dark:border-amber-700 bg-amber-50/60 dark:bg-amber-900/20">
        <KeyRound className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        <AlertTitle className="text-amber-800 dark:text-amber-300">暗号化キーが未設定です</AlertTitle>
        <AlertDescription className="text-amber-700 dark:text-amber-200">
          <p>
            <code className="px-1 rounded bg-amber-100 dark:bg-amber-900/50">CROWI_ENCRYPTION_KEY</code> が設定されていないため、 OAuth secret や SMTP password
            などは暗号化されずに保存されます。
          </p>
          <p className="mt-2 text-xs">
            生成コマンド: <code className="px-1 rounded bg-amber-100 dark:bg-amber-900/50">openssl rand -base64 32</code> (または{' '}
            <code className="px-1 rounded bg-amber-100 dark:bg-amber-900/50">pnpm --filter @crowi/api crypto:gen-key</code>)
          </p>
          <p className="mt-1 text-xs">設定後にサーバを再起動してください。</p>
        </AlertDescription>
      </Alert>
    );
  }

  // 2) Has plaintext rows to migrate
  if (unencryptedCount > 0) {
    return (
      <Alert className="border-amber-300 dark:border-amber-700 bg-amber-50/60 dark:bg-amber-900/20">
        <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        <AlertTitle className="text-amber-800 dark:text-amber-300">{unencryptedCount} 件の未暗号化データがあります</AlertTitle>
        <AlertDescription className="text-amber-700 dark:text-amber-200">
          <p>暗号化キー導入前に保存された機微なデータが残っています。下のボタンを押すと現在の鍵で一括再暗号化します (内容は変わりません)。</p>
          {reencrypt.isError && reencrypt.error instanceof Error && (
            <p className="mt-2 text-sm text-destructive" role="alert">
              {reencrypt.error.message}
            </p>
          )}
          <div className="mt-3 flex items-center gap-3">
            <Button
              variant="default"
              size="sm"
              onClick={() => reencrypt.mutate()}
              disabled={reencrypt.isPending}
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              {reencrypt.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  再暗号化中...
                </>
              ) : (
                'すべて再暗号化'
              )}
            </Button>
            <span className="text-xs text-muted-foreground">
              対象: {unencryptedCount} 件 / 既に暗号化済: {encryptedCount} 件
            </span>
          </div>
          {reencrypt.isSuccess && reencrypt.data && (
            <p className="mt-3 text-sm text-amber-900 dark:text-amber-100">✓ 再暗号化が完了しました ({reencrypt.data.rewritten} 件)</p>
          )}
        </AlertDescription>
      </Alert>
    );
  }

  // 3) Everything encrypted (and at least one row exists)
  if (encryptedCount > 0) {
    return (
      <Alert className="border-emerald-300 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-900/20">
        <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        <AlertTitle className="text-emerald-800 dark:text-emerald-300">機微情報はすべて暗号化されています</AlertTitle>
        <AlertDescription className="text-emerald-700 dark:text-emerald-200">{encryptedCount} 件の機微情報が AES-256-GCM で保存されています。</AlertDescription>
      </Alert>
    );
  }

  // 4) Nothing saved yet — show a small reassurance line.
  return (
    <Alert className="border-muted">
      <AlertTriangle className="h-4 w-4 text-muted-foreground" />
      <AlertTitle>暗号化キー設定済み</AlertTitle>
      <AlertDescription>各セクションで OAuth secret や SMTP password を保存すると自動で暗号化されます。</AlertDescription>
    </Alert>
  );
}
