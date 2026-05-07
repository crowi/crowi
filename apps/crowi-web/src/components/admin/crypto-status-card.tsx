'use client';

import { AlertTriangle, CheckCircle2, KeyRound, Loader2, ShieldAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useCryptoStatus, useReencryptSensitive } from '@/lib/use-admin-crypto';
import { m } from '@/paraglide/messages.js';

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
        <AlertTitle className="text-amber-800 dark:text-amber-300">{m['admin.crypto.key_missing_title']()}</AlertTitle>
        <AlertDescription className="text-amber-700 dark:text-amber-200">
          <p>{m['admin.crypto.key_missing_lead']()}</p>
          <p className="mt-2 text-xs">
            {m['admin.crypto.key_missing_generate']({
              cmd1: 'openssl rand -base64 32',
              cmd2: 'pnpm --filter @crowi/api crypto:gen-key',
            })}
          </p>
          <p className="mt-1 text-xs">{m['admin.crypto.key_missing_restart']()}</p>
        </AlertDescription>
      </Alert>
    );
  }

  // 2) Has plaintext rows to migrate
  if (unencryptedCount > 0) {
    return (
      <Alert className="border-amber-300 dark:border-amber-700 bg-amber-50/60 dark:bg-amber-900/20">
        <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        <AlertTitle className="text-amber-800 dark:text-amber-300">{m['admin.crypto.unencrypted_title']({ count: unencryptedCount })}</AlertTitle>
        <AlertDescription className="text-amber-700 dark:text-amber-200">
          <p>{m['admin.crypto.unencrypted_body']()}</p>
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
                  {m['admin.crypto.reencrypting']()}
                </>
              ) : (
                m['admin.crypto.reencrypt_button']()
              )}
            </Button>
            <span className="text-xs text-muted-foreground">{m['admin.crypto.reencrypt_summary']({ pending: unencryptedCount, done: encryptedCount })}</span>
          </div>
          {reencrypt.isSuccess && reencrypt.data && (
            <p className="mt-3 text-sm text-amber-900 dark:text-amber-100">{m['admin.crypto.reencrypt_done']({ count: reencrypt.data.rewritten })}</p>
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
        <AlertTitle className="text-emerald-800 dark:text-emerald-300">{m['admin.crypto.all_encrypted_title']()}</AlertTitle>
        <AlertDescription className="text-emerald-700 dark:text-emerald-200">
          {m['admin.crypto.all_encrypted_body']({ count: encryptedCount })}
        </AlertDescription>
      </Alert>
    );
  }

  // 4) Nothing saved yet — show a small reassurance line.
  return (
    <Alert className="border-muted">
      <AlertTriangle className="h-4 w-4 text-muted-foreground" />
      <AlertTitle>{m['admin.crypto.empty_title']()}</AlertTitle>
      <AlertDescription>{m['admin.crypto.empty_body']()}</AlertDescription>
    </Alert>
  );
}
