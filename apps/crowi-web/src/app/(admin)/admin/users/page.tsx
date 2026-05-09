'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { UserPlus } from 'lucide-react';
import type { UserPublic } from '@crowi/api-contract';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ErrorAlert } from '@/components/ui/error-alert';
import { Input } from '@/components/ui/input';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { UsersTable, type UserRowAction } from '@/components/admin/users-table';
import {
  ConfirmActionDialog,
  EditUserDialog,
  InviteUsersDialog,
  ResetPasswordResultDialog,
  UpdateEmailDialog,
  userLabel,
} from '@/components/admin/user-action-dialogs';
import { useAdminUsers, useResetAdminUserPassword, useToggleAdminRole, useToggleAdminStatus } from '@/lib/use-admin-users';
import { useAuth } from '@/lib/use-auth';
import { m } from '@paraglide/messages.js';

const SEARCH_DEBOUNCE_MS = 300;

/**
 * Coerce ?page=N into a 1-based positive integer; falls back to 1 when the
 * param is missing or malformed. Mirrors the server-side default to keep
 * client / server in sync without a guard.
 */
function parsePage(value: string | null): number {
  if (!value) return 1;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return parsed;
}

/**
 * Discriminator for the active confirm dialog. `null` means no confirm is
 * open; otherwise we know which mutation to fire on confirm.
 */
type ConfirmKind = 'make-admin' | 'remove-admin' | 'activate' | 'suspend';

interface PendingConfirm {
  kind: ConfirmKind;
  user: UserPublic;
}

/**
 * /admin/users
 *
 * Searchable, paginated user list with per-row action menu. Authorization is
 * delegated to the surrounding (admin) layout — this page assumes the
 * current user is admin and only owns:
 *   1. URL <-> search-input sync (debounced 300ms)
 *   2. Pagination state (?page=N)
 *   3. Action dialog orchestration (invite / edit / reset / email / confirm)
 *
 * Mutation hooks live in `use-admin-users.ts`; this component only wires
 * dialogs to those hooks.
 */
export default function AdminUsersPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const { user: currentUser } = useAuth();

  const urlQuery = searchParams.get('q') ?? '';
  const urlPage = parsePage(searchParams.get('page'));

  const [inputValue, setInputValue] = useState(urlQuery);

  // Action dialog state. Only one dialog is open at a time so a single set
  // of "selected user / pending confirm" pieces is sufficient.
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<UserPublic | null>(null);
  const [emailTarget, setEmailTarget] = useState<UserPublic | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  // Reset-password lives in its own slice so the result modal can stay open
  // after the mutation resolves (the plaintext is only shown once).
  const [resetTarget, setResetTarget] = useState<UserPublic | null>(null);
  const [resetResult, setResetResult] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);

  const toggleRole = useToggleAdminRole();
  const toggleStatus = useToggleAdminStatus();
  const resetPassword = useResetAdminUserPassword();

  /**
   * When the URL query changes from another source (back/forward navigation,
   * external link), pull it back into the input so the field reflects the
   * active search.
   */
  useEffect(() => {
    setInputValue(urlQuery);
  }, [urlQuery]);

  /**
   * Debounce: flush the typed value into the URL after 300ms of inactivity.
   * Resets the page to 1 so the user lands on the first page of new results.
   */
  useEffect(() => {
    if (inputValue === urlQuery) return;
    const timer = setTimeout(() => {
      const next = new URLSearchParams();
      if (inputValue.length > 0) next.set('q', inputValue);
      // Always reset to page 1 on a query change.
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
    setConfirmError(null);
    switch (action.kind) {
      case 'edit':
        setEditTarget(action.user);
        return;
      case 'update-email':
        setEmailTarget(action.user);
        return;
      case 'reset-password':
        setResetTarget(action.user);
        setResetResult(null);
        setResetError(null);
        resetPassword.mutate(
          { id: action.user._id },
          {
            onSuccess: (response) => {
              setResetResult(response.newPassword);
            },
            onError: (err) => {
              setResetError(err instanceof Error ? err.message : m['admin.users.action.reset_password_failed']());
            },
          },
        );
        return;
      case 'make-admin':
      case 'remove-admin':
      case 'activate':
      case 'suspend':
        setPendingConfirm({ kind: action.kind, user: action.user });
        return;
    }
  };

  const handleConfirm = () => {
    if (!pendingConfirm) return;
    setConfirmError(null);
    const { kind, user } = pendingConfirm;
    const onError = (err: unknown) => {
      setConfirmError(err instanceof Error ? err.message : m['admin.users.action.role_failed']());
    };
    if (kind === 'make-admin' || kind === 'remove-admin') {
      toggleRole.mutate(
        { id: user._id, nextAdmin: kind === 'make-admin' },
        {
          onSuccess: () => setPendingConfirm(null),
          onError,
        },
      );
      return;
    }
    toggleStatus.mutate(
      { id: user._id, nextStatus: kind === 'activate' ? 'active' : 'suspended' },
      {
        onSuccess: () => setPendingConfirm(null),
        onError,
      },
    );
  };

  const confirmCopy = useMemo(() => {
    if (!pendingConfirm) return null;
    const name = userLabel(pendingConfirm.user);
    switch (pendingConfirm.kind) {
      case 'make-admin':
        return {
          title: m['admin.users.action.confirm_make_admin_title'](),
          description: m['admin.users.action.confirm_make_admin_description']({ name }),
          destructive: false,
        };
      case 'remove-admin':
        return {
          title: m['admin.users.action.confirm_remove_admin_title'](),
          description: m['admin.users.action.confirm_remove_admin_description']({ name }),
          destructive: true,
        };
      case 'activate':
        return {
          title: m['admin.users.action.confirm_activate_title'](),
          description: m['admin.users.action.confirm_activate_description']({ name }),
          destructive: false,
        };
      case 'suspend':
        return {
          title: m['admin.users.action.confirm_suspend_title'](),
          description: m['admin.users.action.confirm_suspend_description']({ name }),
          destructive: true,
        };
    }
  }, [pendingConfirm]);

  const confirmKindUsesRole = pendingConfirm?.kind === 'make-admin' || pendingConfirm?.kind === 'remove-admin';
  const confirmPending = pendingConfirm !== null && (confirmKindUsesRole ? toggleRole.isPending : toggleStatus.isPending);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{m['admin.users.heading']()}</h1>
          <p className="text-muted-foreground mt-1 text-sm">{m['admin.users.lead']()}</p>
        </div>
        <Button type="button" onClick={() => setInviteOpen(true)}>
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

      <InviteUsersDialog open={inviteOpen} onOpenChange={setInviteOpen} />

      <EditUserDialog
        user={editTarget}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
      />

      <UpdateEmailDialog
        user={emailTarget}
        onOpenChange={(open) => {
          if (!open) setEmailTarget(null);
        }}
      />

      <ResetPasswordResultDialog
        newPassword={resetResult}
        pending={resetPassword.isPending && resetTarget !== null}
        errorMessage={resetError}
        onOpenChange={(open) => {
          if (!open) {
            setResetTarget(null);
            setResetResult(null);
            setResetError(null);
            resetPassword.reset();
          }
        }}
      />

      {pendingConfirm && confirmCopy && (
        <ConfirmActionDialog
          open
          title={confirmCopy.title}
          description={confirmCopy.description}
          destructive={confirmCopy.destructive}
          pending={confirmPending}
          errorMessage={confirmError}
          onConfirm={handleConfirm}
          onOpenChange={(open) => {
            if (!open) {
              setPendingConfirm(null);
              setConfirmError(null);
            }
          }}
        />
      )}
    </div>
  );
}
