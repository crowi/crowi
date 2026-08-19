'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { UserPlus } from 'lucide-react';
import type { AdminUserListItem } from '@crowi/api-contract';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ErrorAlert } from '@/components/ui/error-alert';
import { Input } from '@/components/ui/input';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { UsersTable, type UserRowAction, type UserRowActionKind } from '@/components/admin/users-table';
import {
  ConfirmActionDialog,
  EditUserDialog,
  InviteUsersDialog,
  ResetPasswordResultDialog,
  UnlinkIdentityDialog,
  UpdateEmailDialog,
  userLabel,
} from '@/components/admin/user-action-dialogs';
import { useAdminUsers, useDeleteAdminUser, useResetAdminUserPassword, useToggleAdminRole, useToggleAdminStatus } from '@/lib/use-admin-users';
import { useAuth } from '@/lib/use-auth';
import { m } from '@paraglide/messages.js';

const SEARCH_DEBOUNCE_MS = 300;

function parsePage(value: string | null): number {
  if (!value) return 1;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return parsed;
}

type ConfirmKind = Extract<UserRowActionKind, 'make-admin' | 'remove-admin' | 'activate' | 'suspend' | 'delete'>;

/**
 * Discriminated union for the open dialog. Mutual exclusion (one dialog at a
 * time) is encoded in the type so we don't have to manage 6 individual state
 * slices.
 */
type DialogState =
  | { kind: 'none' }
  | { kind: 'invite' }
  | { kind: 'edit'; user: AdminUserListItem }
  | { kind: 'update-email'; user: AdminUserListItem }
  | { kind: 'reset'; user: AdminUserListItem }
  | { kind: 'unlink-identity'; user: AdminUserListItem; provider: string; providerLabel: string }
  | { kind: 'confirm'; action: ConfirmKind; user: AdminUserListItem; error?: string };

const CLOSED: DialogState = { kind: 'none' };

const CONFIRM_COPY: Record<ConfirmKind, { title: () => string; description: (vars: { name: string }) => string; destructive: boolean }> = {
  'make-admin': {
    title: () => m['admin.users.action.confirm_make_admin_title'](),
    description: (v) => m['admin.users.action.confirm_make_admin_description'](v),
    destructive: false,
  },
  'remove-admin': {
    title: () => m['admin.users.action.confirm_remove_admin_title'](),
    description: (v) => m['admin.users.action.confirm_remove_admin_description'](v),
    destructive: true,
  },
  activate: {
    title: () => m['admin.users.action.confirm_activate_title'](),
    description: (v) => m['admin.users.action.confirm_activate_description'](v),
    destructive: false,
  },
  suspend: {
    title: () => m['admin.users.action.confirm_suspend_title'](),
    description: (v) => m['admin.users.action.confirm_suspend_description'](v),
    destructive: true,
  },
  delete: {
    title: () => m['admin.users.action.confirm_delete_title'](),
    description: (v) => m['admin.users.action.confirm_delete_description'](v),
    destructive: true,
  },
};

export default function AdminUsersPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const { user: currentUser } = useAuth();

  const urlQuery = searchParams.get('q') ?? '';
  const urlPage = parsePage(searchParams.get('page'));

  const [inputValue, setInputValue] = useState(urlQuery);
  const [dialog, setDialog] = useState<DialogState>(CLOSED);

  const toggleRole = useToggleAdminRole();
  const toggleStatus = useToggleAdminStatus();
  const resetPassword = useResetAdminUserPassword();
  const deleteUser = useDeleteAdminUser();

  useEffect(() => {
    setInputValue(urlQuery);
  }, [urlQuery]);

  useEffect(() => {
    if (inputValue === urlQuery) return;
    const timer = setTimeout(() => {
      const next = new URLSearchParams();
      if (inputValue.length > 0) next.set('q', inputValue);
      startTransition(() => {
        router.replace(next.toString().length > 0 ? `/admin/users?${next.toString()}` : '/admin/users');
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [inputValue, urlQuery, router]);

  const { data, isLoading, error, isFetching } = useAdminUsers({ q: urlQuery || undefined, page: urlPage });

  const handlePageChange = (page: number) => {
    const next = new URLSearchParams();
    if (urlQuery.length > 0) next.set('q', urlQuery);
    if (page > 1) next.set('page', String(page));
    startTransition(() => {
      router.replace(next.toString().length > 0 ? `/admin/users?${next.toString()}` : '/admin/users');
    });
  };

  const handleAction = (action: UserRowAction) => {
    switch (action.kind) {
      case 'edit':
        setDialog({ kind: 'edit', user: action.user });
        return;
      case 'update-email':
        setDialog({ kind: 'update-email', user: action.user });
        return;
      case 'reset-password':
        setDialog({ kind: 'reset', user: action.user });
        resetPassword.reset();
        resetPassword.mutate({ id: action.user._id });
        return;
      case 'unlink-identity':
        if (!action.provider) return;
        setDialog({ kind: 'unlink-identity', user: action.user, provider: action.provider, providerLabel: action.providerLabel ?? action.provider });
        return;
      case 'make-admin':
      case 'remove-admin':
      case 'activate':
      case 'suspend':
      case 'delete':
        setDialog({ kind: 'confirm', action: action.kind, user: action.user });
        return;
    }
  };

  const handleConfirm = () => {
    if (dialog.kind !== 'confirm') return;
    const { action, user } = dialog;
    setDialog({ ...dialog, error: undefined });
    const onError = (err: unknown) => {
      const message = err instanceof Error ? err.message : m['admin.users.action.role_failed']();
      setDialog((prev) => (prev.kind === 'confirm' ? { ...prev, error: message } : prev));
    };
    if (action === 'make-admin' || action === 'remove-admin') {
      toggleRole.mutate({ id: user._id, nextAdmin: action === 'make-admin' }, { onSuccess: () => setDialog(CLOSED), onError });
      return;
    }
    if (action === 'delete') {
      deleteUser.mutate({ id: user._id }, { onSuccess: () => setDialog(CLOSED), onError });
      return;
    }
    toggleStatus.mutate({ id: user._id, nextStatus: action === 'activate' ? 'active' : 'suspended' }, { onSuccess: () => setDialog(CLOSED), onError });
  };

  const closeResetDialog = () => {
    setDialog(CLOSED);
    resetPassword.reset();
  };

  const confirmCopy =
    dialog.kind === 'confirm'
      ? {
          ...CONFIRM_COPY[dialog.action],
          name: userLabel(dialog.user),
        }
      : null;
  const confirmPending =
    dialog.kind === 'confirm' &&
    (dialog.action === 'make-admin' || dialog.action === 'remove-admin'
      ? toggleRole.isPending
      : dialog.action === 'delete'
        ? deleteUser.isPending
        : toggleStatus.isPending);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{m['admin.users.heading']()}</h1>
          <p className="text-muted-foreground mt-1 text-sm">{m['admin.users.lead']()}</p>
        </div>
        <Button type="button" onClick={() => setDialog({ kind: 'invite' })}>
          <UserPlus className="mr-1 h-4 w-4" />
          {m['admin.users.action.invite']()}
        </Button>
      </div>

      <Card>
        <CardContent className="space-y-4 pt-6">
          <Input
            type="search"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder={m['admin.users.search_placeholder']()}
            aria-label={m['admin.users.search_placeholder']()}
            className="max-w-md"
          />

          {isLoading && <LoadingSpinner />}

          {!isLoading && error && <ErrorAlert message={error instanceof Error ? error.message : m['admin.users.failed_to_load']()} />}

          {!isLoading && !error && data && (
            <div aria-busy={isFetching}>
              <UsersTable users={data.users} pager={data.pager} onPageChange={handlePageChange} onAction={handleAction} currentUserId={currentUser?.id} />
            </div>
          )}
        </CardContent>
      </Card>

      <InviteUsersDialog open={dialog.kind === 'invite'} onOpenChange={(open) => !open && setDialog(CLOSED)} />

      <EditUserDialog user={dialog.kind === 'edit' ? dialog.user : null} onOpenChange={(open) => !open && setDialog(CLOSED)} />

      <UpdateEmailDialog user={dialog.kind === 'update-email' ? dialog.user : null} onOpenChange={(open) => !open && setDialog(CLOSED)} />

      <UnlinkIdentityDialog
        target={dialog.kind === 'unlink-identity' ? { user: dialog.user, provider: dialog.provider, providerLabel: dialog.providerLabel } : null}
        onOpenChange={(open) => !open && setDialog(CLOSED)}
      />

      <ResetPasswordResultDialog
        newPassword={resetPassword.data?.newPassword ?? null}
        pending={resetPassword.isPending && dialog.kind === 'reset'}
        errorMessage={resetPassword.error instanceof Error ? resetPassword.error.message : null}
        onOpenChange={(open) => {
          if (!open) closeResetDialog();
        }}
      />

      {dialog.kind === 'confirm' && confirmCopy && (
        <ConfirmActionDialog
          open
          title={confirmCopy.title()}
          description={confirmCopy.description({ name: confirmCopy.name })}
          destructive={confirmCopy.destructive}
          pending={confirmPending}
          errorMessage={dialog.error ?? null}
          onConfirm={handleConfirm}
          onOpenChange={(open) => !open && setDialog(CLOSED)}
        />
      )}
    </div>
  );
}
