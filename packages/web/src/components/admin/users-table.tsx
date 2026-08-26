'use client';

import { useMemo } from 'react';
import type { AdminPager, AdminUserListItem } from '@crowi/api-contract';
import { UserStatusEnum } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { Link2, Loader2, MoreHorizontal, Send } from 'lucide-react';
import { UserIdentityCell } from '@/components/admin/user-identity-cell';
import { BRAND_MARK_BY_PROVIDER } from '@/components/brand-icons';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Pager } from '@/components/ui/pager';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatDate } from '@/lib/date-utils';
import { notify } from '@/lib/notify';
import { useResendAdminInvite } from '@/lib/use-admin-users';
import { useAuthProviders } from '@/lib/use-auth-providers';
import { cn } from '@/lib/utils';

export type UserRowActionKind =
  | 'edit'
  | 'make-admin'
  | 'remove-admin'
  | 'activate'
  | 'suspend'
  | 'reset-password'
  | 'update-email'
  | 'unlink-identity'
  | 'delete';

export interface UserRowAction {
  kind: UserRowActionKind;
  user: AdminUserListItem;
  /** Set only for 'unlink-identity' — which of the user's linkedProviders to unlink. */
  provider?: string;
  /** Set only for 'unlink-identity' — display label for `provider` (falls back to the slug). */
  providerLabel?: string;
}

interface UsersTableProps {
  users: AdminUserListItem[];
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
  return <Pager mode="numbered" page={pager.page} totalPages={pager.pagesCount} onPageChange={onPageChange} ariaLabel={m['admin.users.pager_aria_label']()} />;
}

/**
 * In-row "Resend invite" affordance for INVITED users — a primary action a
 * deliberately minimal pre-acceptance row should expose directly (not buried
 * in the menu). One click re-issues the invite token and resends the email
 * (no confirm dialog, mirroring the reset-password row action). Success and
 * failure surface as a toast via the shared `notify` helper (the Toaster is
 * mounted by the admin layout) rather than inline, so the row height never
 * shifts and the table layout stays stable. The button is disabled while in
 * flight to prevent a double-send.
 */
function ResendInviteButton({ user }: { user: AdminUserListItem }) {
  const resend = useResendAdminInvite();

  const onClick = () => {
    resend.mutate(
      { id: user._id },
      {
        onSuccess: () => notify.info(m['admin.users.action.resend_invite_success']()),
        onError: (err) => notify.error(err instanceof Error ? err.message : m['admin.users.action.resend_invite_failed']()),
      },
    );
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          disabled={resend.isPending}
          aria-label={m['admin.users.action.resend_invite']()}
          onClick={onClick}
        >
          {resend.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{resend.isPending ? m['admin.users.action.resending']() : m['admin.users.action.resend_invite']()}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Small inline marker for "this user has at least one linked federated
 * identity" — shown next to the user cell so an admin can tell at a glance
 * without opening the row menu. One mark per linked provider, using the
 * vendor's own brand mark (the same inline SVGs the login screen draws, so
 * no third-party host is contacted) and falling back to the generic link
 * icon for a provider we ship no mark for — a wrong logo is worse than a
 * neutral one.
 *
 * Slug -> display label comes from `useAuthProviders()`; a provider whose
 * plugin was since removed still has its slug shown verbatim rather than
 * disappearing (the identity itself is still real and still blocks email
 * changes / needs unlinking).
 */
function LinkedIdentityBadge({ providers, providerLabels }: { providers: string[]; providerLabels: Map<string, string> }) {
  if (providers.length === 0) return null;
  const label = providers.map((p) => providerLabels.get(p) ?? p).join(', ');
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-muted-foreground">
          {providers.map((provider) => {
            const Mark = BRAND_MARK_BY_PROVIDER[provider];
            return Mark ? <Mark key={provider} className="h-4 w-4" /> : <Link2 key={provider} className="h-4 w-4" aria-hidden />;
          })}
          <span className="sr-only">{m['admin.users.linked_identity_label']({ providers: label })}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{m['admin.users.linked_identity_label']({ providers: label })}</TooltipContent>
    </Tooltip>
  );
}

interface RowActionMenuProps {
  user: AdminUserListItem;
  isSelf: boolean;
  providerLabels: Map<string, string>;
  onAction: (action: UserRowAction) => void;
}

function RowActionMenu({ user, isSelf, providerLabels, onAction }: RowActionMenuProps) {
  const showActivate = user.status === UserStatusEnum.SUSPENDED || user.status === UserStatusEnum.REGISTERED;
  const showSuspend = user.status === UserStatusEnum.ACTIVE;
  // A federated identity locks the email to the IdP-verified address — the
  // admin has to unlink first (spec: "変更が必要な場合は先に連携を解除します").
  const hasLinkedIdentity = user.linkedProviders.length > 0;

  // Invited (never-activated) users have a deliberately minimal menu: the only
  // meaningful operations are correcting the invite email or removing the
  // pending invite. Activation/admin toggles make no sense pre-acceptance.
  // (JIT federated registration never leaves a user INVITED, so linkedProviders
  // is always empty here — no lock/unlink affordance needed on this branch.)
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
        <DropdownMenuItem
          disabled={hasLinkedIdentity}
          title={hasLinkedIdentity ? m['admin.users.action.update_email_locked_hint']() : undefined}
          onSelect={() => !hasLinkedIdentity && onAction({ kind: 'update-email', user })}
        >
          {m['admin.users.action.update_email']()}
        </DropdownMenuItem>
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
        {hasLinkedIdentity && (
          <>
            <DropdownMenuSeparator />
            {user.linkedProviders.map((provider) => {
              const providerLabel = providerLabels.get(provider) ?? provider;
              return (
                <DropdownMenuItem
                  key={provider}
                  variant="destructive"
                  disabled={isSelf}
                  title={isSelf ? m['admin.users.action.self_disabled_hint']() : undefined}
                  onSelect={() => !isSelf && onAction({ kind: 'unlink-identity', user, provider, providerLabel })}
                >
                  {m['admin.users.action.unlink_identity']({ provider: providerLabel })}
                </DropdownMenuItem>
              );
            })}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function UsersTable({ users, pager, onPageChange, onAction, currentUserId }: UsersTableProps) {
  const { data: providers } = useAuthProviders();
  const providerLabels = useMemo(() => new Map((providers ?? []).map((p) => [p.name, p.buttonLabel])), [providers]);

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
                  <div className="flex items-start gap-2">
                    <UserIdentityCell user={user} />
                    <LinkedIdentityBadge providers={user.linkedProviders} providerLabels={providerLabels} />
                  </div>
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
                    <div className="inline-flex items-start justify-end gap-1">
                      {/* INVITED rows surface "Resend invite" directly (outside the menu) as a primary action. */}
                      {user.status === UserStatusEnum.INVITED && <ResendInviteButton user={user} />}
                      <RowActionMenu user={user} isSelf={user._id === currentUserId} providerLabels={providerLabels} onAction={onAction} />
                    </div>
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
