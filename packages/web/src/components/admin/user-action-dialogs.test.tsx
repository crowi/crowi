import type { AdminUserListItem } from '@crowi/api-contract';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Pure component tests: every mutation hook this file's dialogs use is
// mocked, real paraglide messages are used (aliased in vitest.config.ts),
// mirroring `linked-accounts-section.test.tsx`'s convention.
const { useEditAdminUser, useInviteAdminUsers, useUpdateAdminUserEmail, useUnlinkAdminUserIdentity, editMutateAsync, unlinkMutate } = vi.hoisted(() => ({
  useEditAdminUser: vi.fn(),
  useInviteAdminUsers: vi.fn(),
  useUpdateAdminUserEmail: vi.fn(),
  useUnlinkAdminUserIdentity: vi.fn(),
  editMutateAsync: vi.fn(),
  unlinkMutate: vi.fn(),
}));

vi.mock('@/lib/use-admin-users', async () => {
  const actual = await vi.importActual<typeof import('@/lib/use-admin-users')>('@/lib/use-admin-users');
  return { ...actual, useEditAdminUser, useInviteAdminUsers, useUpdateAdminUserEmail, useUnlinkAdminUserIdentity };
});

import { EditUserDialog, UnlinkIdentityDialog, type UnlinkIdentityTarget } from './user-action-dialogs';

function makeUser(overrides: Partial<AdminUserListItem> = {}): AdminUserListItem {
  return {
    _id: 'u1',
    id: 'u1',
    username: 'dave',
    name: 'Dave',
    email: 'dave@example.com',
    image: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    admin: false,
    linkedProviders: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useEditAdminUser.mockReturnValue({ mutateAsync: editMutateAsync, reset: vi.fn(), isPending: false, isError: false, error: null });
  useInviteAdminUsers.mockReturnValue({ mutateAsync: vi.fn(), reset: vi.fn(), isPending: false, isError: false, error: null });
  useUpdateAdminUserEmail.mockReturnValue({ mutateAsync: vi.fn(), reset: vi.fn(), isPending: false, isError: false, error: null });
  useUnlinkAdminUserIdentity.mockReturnValue({
    mutate: unlinkMutate,
    reset: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
    data: undefined,
  });
});

afterEach(cleanup);

describe('EditUserDialog (AC-3: name only)', () => {
  it('renders the name field but no email field', () => {
    render(<EditUserDialog user={makeUser()} onOpenChange={vi.fn()} />);

    expect(screen.getByLabelText('名前')).toBeInTheDocument();
    expect(screen.queryByLabelText('メール')).not.toBeInTheDocument();
  });

  it('submits only { name } — never an email field', async () => {
    render(<EditUserDialog user={makeUser()} onOpenChange={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('名前'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(editMutateAsync).toHaveBeenCalledWith({ id: 'u1', body: { name: 'Renamed' } });
  });
});

describe('UnlinkIdentityDialog (AC-10)', () => {
  const target: UnlinkIdentityTarget = { user: makeUser({ linkedProviders: ['google'] }), provider: 'google', providerLabel: 'Google' };

  it('asks for confirmation before unlinking, using the display label (not the raw slug)', () => {
    render(<UnlinkIdentityDialog target={target} onOpenChange={vi.fn()} />);

    expect(screen.getByText('Google の連携を解除しますか?')).toBeInTheDocument();
    expect(unlinkMutate).not.toHaveBeenCalled();
  });

  it('calls the mutation with { id, provider } on confirm', () => {
    render(<UnlinkIdentityDialog target={target} onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '実行' }));

    expect(unlinkMutate).toHaveBeenCalledWith({ id: 'u1', provider: 'google' });
  });

  it('shows "password unchanged" when passwordIssued is false', () => {
    useUnlinkAdminUserIdentity.mockReturnValue({
      mutate: unlinkMutate,
      reset: vi.fn(),
      isPending: false,
      isSuccess: true,
      isError: false,
      error: null,
      data: { user: target.user, passwordIssued: false },
    });

    render(<UnlinkIdentityDialog target={target} onOpenChange={vi.fn()} />);

    expect(screen.getByText('連携を解除しました。既存のパスワードは変更していません。')).toBeInTheDocument();
    expect(screen.queryByLabelText('新しいパスワード')).not.toBeInTheDocument();
  });

  it('shows the newly-issued password when passwordIssued is true', () => {
    useUnlinkAdminUserIdentity.mockReturnValue({
      mutate: unlinkMutate,
      reset: vi.fn(),
      isPending: false,
      isSuccess: true,
      isError: false,
      error: null,
      data: { user: target.user, passwordIssued: true, newPassword: 'freshly-generated-pw' },
    });

    render(<UnlinkIdentityDialog target={target} onOpenChange={vi.fn()} />);

    expect(
      screen.getByText(
        'このユーザーはパスワード未設定でした。新しいパスワードを発行しました。安全な経路で本人に伝えてください。このパスワードは再表示できません。',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('新しいパスワード')).toHaveValue('freshly-generated-pw');
  });

  it('surfaces a server refusal (e.g. CANNOT_UNLINK_SELF) without switching to the result view', () => {
    useUnlinkAdminUserIdentity.mockReturnValue({
      mutate: unlinkMutate,
      reset: vi.fn(),
      isPending: false,
      isSuccess: false,
      isError: true,
      error: Object.assign(new Error('An admin cannot unlink their own federated identity from here'), { code: 'CANNOT_UNLINK_SELF' }),
      data: undefined,
    });

    render(<UnlinkIdentityDialog target={target} onOpenChange={vi.fn()} />);

    expect(screen.getByText('An admin cannot unlink their own federated identity from here')).toBeInTheDocument();
    expect(screen.getByText('Google の連携を解除しますか?')).toBeInTheDocument();
  });

  // Regression: `page.tsx` passes `target` as a fresh object literal on every
  // render, and a successful unlink's `onSuccess` invalidates the list query
  // the parent reads — guaranteeing a parent re-render while the dialog is
  // still open. An identity-keyed reset effect would fire on THAT re-render
  // too, reset()-ing the mutation and flipping the dialog back to the
  // confirm step before the admin could read a one-time `newPassword`. The
  // effect must key off `target.user._id` / `target.provider`, not `target`
  // itself, so a same-identity object with a new reference does not re-fire it.
  it('keeps showing the result after a parent re-render that passes a new (but same-identity) target object', () => {
    const resetSpy = vi.fn();
    useUnlinkAdminUserIdentity.mockReturnValue({
      mutate: unlinkMutate,
      reset: resetSpy,
      isPending: false,
      isSuccess: true,
      isError: false,
      error: null,
      data: { user: target.user, passwordIssued: true, newPassword: 'freshly-generated-pw' },
    });

    const { rerender } = render(<UnlinkIdentityDialog target={target} onOpenChange={vi.fn()} />);
    expect(screen.getByLabelText('新しいパスワード')).toHaveValue('freshly-generated-pw');
    // The mount-time effect run (clearing stale state for a freshly-opened
    // target) is the one legitimate call. Pin it explicitly so the next
    // assertion is "still exactly one", not just "unchanged from an
    // unobserved prior count".
    expect(resetSpy).toHaveBeenCalledTimes(1);

    // Same user id / provider, but a NEW object reference — exactly what
    // `page.tsx` produces on a re-render triggered by the mutation's own
    // `onSuccess` (it invalidates the list query the parent reads).
    rerender(<UnlinkIdentityDialog target={{ ...target }} onOpenChange={vi.fn()} />);

    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('新しいパスワード')).toHaveValue('freshly-generated-pw');
  });

  it('clears the mutation state (reset) when the result step is closed, so a one-time newPassword does not linger', () => {
    const resetSpy = vi.fn();
    const onOpenChange = vi.fn();
    useUnlinkAdminUserIdentity.mockReturnValue({
      mutate: unlinkMutate,
      reset: resetSpy,
      isPending: false,
      isSuccess: true,
      isError: false,
      error: null,
      data: { user: target.user, passwordIssued: true, newPassword: 'freshly-generated-pw' },
    });

    render(<UnlinkIdentityDialog target={target} onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));

    // Radix's own AlertDialogAction dismissal (uncontrolled `open` in this
    // test double) can route through the close handler more than once; what
    // matters is that it is reset at all — before this fix it was never
    // called on close, leaving the plaintext newPassword in mutation state.
    expect(resetSpy).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
