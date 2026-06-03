'use client';

import type { AdminPager, UserPublic } from '@crowi/api-contract';
import { UserStatusEnum } from '@crowi/api-contract';
import { MoreHorizontal } from 'lucide-react';
import { UserIdentityCell } from '@/components/admin/user-identity-cell';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { formatDate } from '@/lib/date-utils';
import { m } from '@paraglide/messages.js';

export type UserRowActionKind = 'edit' | 'make-admin' | 'remove-admin' | 'activate' | 'suspend' | 'reset-password' | 'update-email' | 'delete';

export interface UserRowAction {
  kind: UserRowActionKind;
  user: UserPublic;
}

interface UsersTableProps {
  users: UserPublic[];
  pager: AdminPager;
  onPageChange: (page: number) => void;
  /** When omitted the row dropdown is hidden (e.g. read-only contexts). */
  onAction?: (action: UserRowAction) => void;
  /** Disables self-destructive actions (demote / suspend) for this user id. */
  currentUserId?: string;
}

function formatStatus(status: number | undefined): string {
  switch (status) {
    case UserStatusEnum.REGISTERED:
      return m['admin.users.status_registered']();
    case UserStatusEnum.ACTIVE:
      return m['admin.users.status_active']();
    case UserStatusEnum.SUSPENDED:
      return m['admin.users.status_suspended']();
    case UserStatusEnum.DELETED:
      return m['admin.users.status_deleted']();
    case UserStatusEnum.INVITED:
      return m['admin.users.status_invited']();
    default:
      return m['admin.users.status_unknown']();
  }
}

function statusPillClass(status: number | undefined): string {
  switch (status) {
    case UserStatusEnum.ACTIVE:
      return 'bg-green-100 text-green-800';
    case UserStatusEnum.REGISTERED:
    case UserStatusEnum.INVITED:
      return 'bg-yellow-100 text-yellow-800';
    case UserStatusEnum.SUSPENDED:
      return 'bg-orange-100 text-orange-800';
    case UserStatusEnum.DELETED:
      return 'bg-red-100 text-red-800';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

export function UsersPager({ pager, onPageChange }: { pager: AdminPager; onPageChange: (page: number) => void }) {
  if (pager.pagesCount <= 1) return null;

  return (
    <nav className="flex items-center justify-center gap-1" aria-label={m['admin.users.pager_aria_label']()}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pager.previous === null}
        onClick={() => pager.previous !== null && onPageChange(pager.previous)}
      >
        {m['admin.users.pager_previous']()}
      </Button>

      {pager.previousDots && <span className="px-2 text-muted-foreground">...</span>}

      {pager.pages.map((p) => (
        <Button
          key={p}
          type="button"
          variant={p === pager.page ? 'default' : 'outline'}
          size="sm"
          onClick={() => onPageChange(p)}
          aria-current={p === pager.page ? 'page' : undefined}
        >
          {p}
        </Button>
      ))}

      {pager.nextDots && <span className="px-2 text-muted-foreground">...</span>}

      <Button type="button" variant="outline" size="sm" disabled={pager.next === null} onClick={() => pager.next !== null && onPageChange(pager.next)}>
        {m['admin.users.pager_next']()}
      </Button>
    </nav>
  );
}

interface RowActionMenuProps {
  user: UserPublic;
  isSelf: boolean;
  onAction: (action: UserRowAction) => void;
}

function RowActionMenu({ user, isSelf, onAction }: RowActionMenuProps) {
  const showActivate = user.status === UserStatusEnum.SUSPENDED || user.status === UserStatusEnum.REGISTERED;
  const showSuspend = user.status === UserStatusEnum.ACTIVE;

  // Invited (never-activated) users have a deliberately minimal menu: the only
  // meaningful operations are correcting the invite email or removing the
  // pending invite. Activation/admin toggles make no sense pre-acceptance.
  if (user.status === UserStatusEnum.INVITED) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="h-8 w-8 p-0" aria-label={m['admin.users.action.menu_open']()}>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>{m['admin.users.action.menu_label']()}</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => onAction({ kind: 'update-email', user })}>{m['admin.users.action.update_email']()}</DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => onAction({ kind: 'delete', user })}>
            {m['admin.users.action.delete']()}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="h-8 w-8 p-0" aria-label={m['admin.users.action.menu_open']()}>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{m['admin.users.action.menu_label']()}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onAction({ kind: 'edit', user })}>{m['admin.users.action.edit']()}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAction({ kind: 'update-email', user })}>{m['admin.users.action.update_email']()}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAction({ kind: 'reset-password', user })}>{m['admin.users.action.reset_password']()}</DropdownMenuItem>
        <DropdownMenuSeparator />
        {user.admin ? (
          <DropdownMenuItem
            disabled={isSelf}
            title={isSelf ? m['admin.users.action.self_disabled_hint']() : undefined}
            onSelect={() => !isSelf && onAction({ kind: 'remove-admin', user })}
          >
            {m['admin.users.action.remove_admin']()}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={() => onAction({ kind: 'make-admin', user })}>{m['admin.users.action.make_admin']()}</DropdownMenuItem>
        )}
        {showActivate && <DropdownMenuItem onSelect={() => onAction({ kind: 'activate', user })}>{m['admin.users.action.activate']()}</DropdownMenuItem>}
        {showSuspend && (
          <DropdownMenuItem
            variant="destructive"
            disabled={isSelf}
            title={isSelf ? m['admin.users.action.self_disabled_hint']() : undefined}
            onSelect={() => !isSelf && onAction({ kind: 'suspend', user })}
          >
            {m['admin.users.action.suspend']()}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function UsersTable({ users, pager, onPageChange, onAction, currentUserId }: UsersTableProps) {
  if (users.length === 0) {
    return (
      <div className="rounded-md border bg-muted/30 px-4 py-8 text-center">
        <p className="text-sm font-medium">{m['admin.users.empty_title']()}</p>
        <p className="text-muted-foreground mt-1 text-sm">{m['admin.users.empty_body']()}</p>
      </div>
    );
  }

  const showActions = Boolean(onAction);

  return (
    <div className="space-y-4">
      <div className="text-muted-foreground text-sm">{m['admin.users.pager_total']({ total: pager.total })}</div>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="text-left">
              <th className="px-4 py-2 font-medium">{m['admin.users.column_user']()}</th>
              <th className="px-4 py-2 font-medium">{m['admin.users.column_status']()}</th>
              <th className="px-4 py-2 font-medium">{m['admin.users.column_admin']()}</th>
              <th className="px-4 py-2 font-medium whitespace-nowrap">{m['admin.users.column_created_at']()}</th>
              {showActions && <th className="px-2 py-2 font-medium sr-only">{m['admin.users.action.menu_label']()}</th>}
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user._id} className="border-t align-top">
                <td className="px-4 py-3">
                  <UserIdentityCell user={user} />
                </td>
                <td className="px-4 py-3">
                  <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', statusPillClass(user.status))}>
                    {formatStatus(user.status)}
                  </span>
                </td>
                <td className="px-4 py-3">
                  {user.admin && (
                    <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary whitespace-nowrap">
                      {m['admin.users.role_admin']()}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{formatDate(user.createdAt)}</td>
                {showActions && onAction && (
                  <td className="px-2 py-3 text-right">
                    <RowActionMenu user={user} isSelf={user._id === currentUserId} onAction={onAction} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <UsersPager pager={pager} onPageChange={onPageChange} />
    </div>
  );
}
