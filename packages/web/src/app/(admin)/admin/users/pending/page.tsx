'use client';

import { useState } from 'react';
import { UserStatusEnum } from '@crowi/api-contract';
import type { UserPublic } from '@crowi/api-contract';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ErrorAlert } from '@/components/ui/error-alert';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { UserIdentityCell } from '@/components/admin/user-identity-cell';
import { UsersPager } from '@/components/admin/users-table';
import { formatDate } from '@/lib/date-utils';
import { useAdminUsers, useToggleAdminStatus } from '@/lib/use-admin-users';
import { m } from '@paraglide/messages.js';

/**
 * User-approval queue. Lists every user awaiting admin approval (status
 * REGISTERED — produced by the "Restricted" registration mode) and lets an
 * admin activate them one click at a time. Approving a user invalidates the
 * list query so the row drops out and the sidebar badge count drops too.
 */
export default function AdminUsersPendingPage() {
  const [page, setPage] = useState(1);
  const { data, isLoading, error } = useAdminUsers({ status: UserStatusEnum.REGISTERED, page });
  const toggleStatus = useToggleAdminStatus();
  const [rowError, setRowError] = useState<string | null>(null);

  const approve = (user: UserPublic) => {
    setRowError(null);
    toggleStatus.mutate(
      { id: user._id, nextStatus: 'active' },
      {
        onError: (err) => setRowError(err instanceof Error ? err.message : m['admin.users.pending.approve_failed']()),
      },
    );
  };

  const users = data?.users ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{m['admin.users.pending.heading']()}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{m['admin.users.pending.lead']()}</p>
      </div>

      {isLoading && <LoadingSpinner />}

      {!isLoading && error && <ErrorAlert message={error instanceof Error ? error.message : m['admin.users.failed_to_load']()} />}

      {rowError && <ErrorAlert message={rowError} />}

      {!isLoading && !error && users.length === 0 && (
        <div className="rounded-md border bg-muted/30 px-4 py-8 text-center">
          <p className="text-sm font-medium">{m['admin.users.pending.empty_title']()}</p>
          <p className="text-muted-foreground mt-1 text-sm">{m['admin.users.pending.empty_body']()}</p>
        </div>
      )}

      {!isLoading && !error && users.length > 0 && (
        <Card>
          <CardContent className="divide-y p-0">
            {users.map((user) => (
              <div key={user._id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <UserIdentityCell user={user} />
                </div>
                <span className="text-muted-foreground hidden whitespace-nowrap text-xs sm:inline">{formatDate(user.createdAt)}</span>
                <Button type="button" size="sm" disabled={toggleStatus.isPending} onClick={() => approve(user)}>
                  {toggleStatus.isPending && toggleStatus.variables?.id === user._id
                    ? m['admin.users.pending.approving']()
                    : m['admin.users.pending.approve']()}
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {!isLoading && !error && data && <UsersPager pager={data.pager} onPageChange={setPage} />}
    </div>
  );
}
