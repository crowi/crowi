'use client';

import { type ReactNode, useEffect, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { useClearRenderCacheAll, useClearRenderCachePlugin } from '@/lib/use-admin-plugins';
import { m } from '@paraglide/messages.js';

/**
 * Phase 4 destructive-action shell shared by the "Clear all render
 * cache" and "Clear cache for this plugin" buttons. Renders an
 * `AlertDialog`-gated trigger; result toast auto-dismisses success
 * after ~4s (cleanup-on-unmount via useEffect), errors persist until
 * the next click.
 */
const SUCCESS_DISMISS_MS = 4000;

type Status = null | { kind: 'success'; count: number } | { kind: 'error'; message: string };

interface ClearCacheButtonShellProps {
  triggerLabel: string;
  confirmTitle: string;
  confirmBody: ReactNode;
  confirmCancel: string;
  confirmAction: string;
  pendingLabel: string;
  isPending: boolean;
  onConfirm: () => void;
  status: Status;
}

function ClearCacheButtonShell({
  triggerLabel,
  confirmTitle,
  confirmBody,
  confirmCancel,
  confirmAction,
  pendingLabel,
  isPending,
  onConfirm,
  status,
}: ClearCacheButtonShellProps) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} disabled={isPending}>
        <Trash2 className="mr-1 h-4 w-4" />
        {triggerLabel}
      </Button>
      {status?.kind === 'success' && (
        <p className="mt-2 text-xs text-muted-foreground" role="status">
          {m['admin.plugins.clear_cache_success_toast']({ count: status.count })}
        </p>
      )}
      {status?.kind === 'error' && (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {m['admin.plugins.clear_cache_error_toast']({ message: status.message })}
        </p>
      )}
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmTitle}</AlertDialogTitle>
            <AlertDialogDescription>{confirmBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>{confirmCancel}</AlertDialogCancel>
            <AlertDialogAction
              disabled={isPending}
              className={cn('bg-destructive text-white hover:bg-destructive/90')}
              onClick={(e) => {
                e.preventDefault();
                setOpen(false);
                onConfirm();
              }}
            >
              {isPending ? (
                <>
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  {pendingLabel}
                </>
              ) : (
                confirmAction
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function useStatusWithAutoDismiss() {
  const [status, setStatus] = useState<Status>(null);
  useEffect(() => {
    if (status?.kind !== 'success') return;
    const id = window.setTimeout(() => setStatus(null), SUCCESS_DISMISS_MS);
    return () => window.clearTimeout(id);
  }, [status]);
  return [status, setStatus] as const;
}

export function ClearAllRenderCacheButton() {
  const clearAll = useClearRenderCacheAll();
  const [status, setStatus] = useStatusWithAutoDismiss();

  const onConfirm = () => {
    setStatus(null);
    clearAll.mutate(undefined, {
      onSuccess: (data) => setStatus({ kind: 'success', count: data.removedCount }),
      onError: (err) => setStatus({ kind: 'error', message: err.message }),
    });
  };

  return (
    <ClearCacheButtonShell
      triggerLabel={m['admin.plugins.clear_cache_all_button']()}
      confirmTitle={m['admin.plugins.clear_cache_confirm_title']()}
      confirmBody={m['admin.plugins.clear_cache_confirm_body_all']()}
      confirmCancel={m['admin.plugins.clear_cache_confirm_cancel']()}
      confirmAction={m['admin.plugins.clear_cache_confirm_confirm']()}
      pendingLabel={m['admin.plugins.clear_cache_confirm_pending']()}
      isPending={clearAll.isPending}
      onConfirm={onConfirm}
      status={status}
    />
  );
}

interface ClearPluginRenderCacheButtonProps {
  pluginName: string;
}

export function ClearPluginRenderCacheButton({ pluginName }: ClearPluginRenderCacheButtonProps) {
  const clear = useClearRenderCachePlugin();
  const [status, setStatus] = useStatusWithAutoDismiss();

  const onConfirm = () => {
    setStatus(null);
    clear.mutate(
      { name: pluginName },
      {
        onSuccess: (data) => setStatus({ kind: 'success', count: data.removedCount }),
        onError: (err) => setStatus({ kind: 'error', message: err.message }),
      },
    );
  };

  return (
    <ClearCacheButtonShell
      triggerLabel={m['admin.plugins.clear_cache_plugin_button']()}
      confirmTitle={m['admin.plugins.clear_cache_confirm_title']()}
      confirmBody={m['admin.plugins.clear_cache_confirm_body_plugin']({ name: pluginName })}
      confirmCancel={m['admin.plugins.clear_cache_confirm_cancel']()}
      confirmAction={m['admin.plugins.clear_cache_confirm_confirm']()}
      pendingLabel={m['admin.plugins.clear_cache_confirm_pending']()}
      isPending={clear.isPending}
      onConfirm={onConfirm}
      status={status}
    />
  );
}
