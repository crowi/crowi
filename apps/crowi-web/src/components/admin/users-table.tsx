'use client';

import type { AdminPager, UserPublic } from '@crowi/api-contract';
import { UserStatusEnum } from '@crowi/api-contract';
import { MoreHorizontal } from 'lucide-react';
import { UserAvatar } from '@/components/user-avatar';
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

/**
 * Per-row action discriminator emitted by `UsersTable` via `onAction`.
 *
 * The table is intentionally dumb — it does not own the dialog state or the
 * mutation hooks. The parent page maps each `kind` to the corresponding
 * dialog (edit / reset-password / update-email) or AlertDialog confirmation
 * (make-admin / remove-admin / activate / suspend).
 */
export type UserRowActionKind = 'edit' | 'make-admin' | 'remove-admin' | 'activate' | 'suspend' | 'reset-password' | 'update-email';

export interface UserRowAction {
  kind: UserRowActionKind;
  user: UserPublic;
}

interface UsersTableProps {
  users: UserPublic[];
  pager: AdminPager;
  onPageChange: (page: number) => void;
  /**
   * Called when the operator picks an action from the row dropdown. The page
   * stores the chosen user in local state and opens the matching dialog. If
   * omitted, the dropdown column is not rendered (e.g. for read-only views).
   */
  onAction?: (action: UserRowAction) => void;
  /**
   * Current operator's user id. Used to disable destructive self-actions
   * (demote / suspend) at the UI level. Server-side guards live in
   * `migrate-admin-user-actions-api` follow-ups.
   */
  currentUserId?: string;
}

/**
 * Display label for the numeric `status` field on UserPublic.
 *
 * The contract emits raw numbers (1..5 — see UserStatusEnum) so the UI is
 * responsible for translation. Unknown values are rendered as "Unknown" so
 * a stale user document does not break the table.
 */
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

/**
 * Tailwind classes for the status pill — colour-codes the four common states
 * so an operator can scan the table at a glance.
 */
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

/**
 * Numbered pager rendered below the table. The shape is dictated by
 * `AdminPager` (matching the legacy pager helper):
 *   prev  ...  pages...  ...  next
 *
 * `previousDots` / `nextDots` flags drive the gap markers; `pages[]` is the
 * windowed range of clickable page numbers.
 */
function Pager({ pager, onPageChange }: { pager: AdminPager; onPageChange: (page: number) => void }) {
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

/**
 * Dropdown menu for a single user row.
 *
 * Visibility rules for items mirror the legacy admin UI:
 * - The promote/demote item flips between "make admin" and "remove admin"
 *   based on the user's current `admin` flag.
 * - The activate/suspend item flips on the user's `status`. The "activate"
 *   item is shown for both REGISTERED and SUSPENDED so admins can approve
 *   newly-registered users from one place.
 * - "Reset password" / "Change email" are always present (no toggle).
 *
 * Self-protection: when the row is the current operator, the demote /
 * suspend options are rendered as `data-disabled` items that show a hint
 * tooltip — *not* hidden — so the operator understands why they can't act.
 */
function RowActionMenu({ user, isSelf, onAction }: RowActionMenuProps) {
  const showActivate = user.status === UserStatusEnum.SUSPENDED || user.status === UserStatusEnum.REGISTERED;
  const showSuspend = user.status === UserStatusEnum.ACTIVE;

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
              <th className="px-4 py-2 font-medium">{m['admin.users.column_username']()}</th>
              <th className="px-4 py-2 font-medium">{m['admin.users.column_email']()}</th>
              <th className="px-4 py-2 font-medium">{m['admin.users.column_status']()}</th>
              <th className="px-4 py-2 font-medium">{m['admin.users.column_admin']()}</th>
              <th className="px-4 py-2 font-medium">{m['admin.users.column_created_at']()}</th>
              {showActions && <th className="px-4 py-2 font-medium sr-only">{m['admin.users.action.menu_label']()}</th>}
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user._id} className="border-t">
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <UserAvatar user={{ name: user.name, username: user.username, image: user.image ?? null }} size="sm" />
                    <span className="font-medium">{user.name || user.username}</span>
                  </div>
                </td>
                <td className="px-4 py-2 text-muted-foreground">{user.username}</td>
                <td className="px-4 py-2">{user.email}</td>
                <td className="px-4 py-2">
                  <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', statusPillClass(user.status))}>
                    {formatStatus(user.status)}
                  </span>
                </td>
                <td className="px-4 py-2">
                  {user.admin ? (
                    <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                      {m['admin.users.role_admin']()}
                    </span>
                  ) : (
                    <span className="text-muted-foreground text-xs">{m['admin.users.role_member']()}</span>
                  )}
                </td>
                <td className="px-4 py-2 text-muted-foreground">{formatDate(user.createdAt)}</td>
                {showActions && onAction && (
                  <td className="px-2 py-2 text-right">
                    <RowActionMenu user={user} isSelf={user._id === currentUserId} onAction={onAction} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pager pager={pager} onPageChange={onPageChange} />
    </div>
  );
}
