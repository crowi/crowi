import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The section composes several react-query-shaped hooks; all are mocked so
// this stays a pure component test. Paraglide messages are the real
// compiled output (aliased in vitest.config.ts), so assertions match the
// rendered copy.
const {
  useAuthProviders,
  useLinkedAuthProviders,
  useUnlinkAuthProvider,
  useStartProviderLink,
  usePendingLinkCompletion,
  useCompleteProviderLink,
  startMutate,
  unlinkMutate,
  completeMutate,
  refetchConfirmation,
} = vi.hoisted(() => ({
  useAuthProviders: vi.fn(),
  useLinkedAuthProviders: vi.fn(),
  useUnlinkAuthProvider: vi.fn(),
  useStartProviderLink: vi.fn(),
  usePendingLinkCompletion: vi.fn(),
  useCompleteProviderLink: vi.fn(),
  startMutate: vi.fn(),
  unlinkMutate: vi.fn(),
  completeMutate: vi.fn(),
  refetchConfirmation: vi.fn(),
}));

vi.mock('@/lib/use-auth-providers', () => ({
  useAuthProviders,
  useLinkedAuthProviders,
  useUnlinkAuthProvider,
  useStartProviderLink,
  usePendingLinkCompletion,
  useCompleteProviderLink,
}));

import { LinkedAccountsSection, PendingLinkCompletionContainer } from './linked-accounts-section';

const PROVIDERS = [{ name: 'google', buttonLabel: 'Google' }];

/** Matches the shape `ProviderLinkError` gives components — status/code/message. */
function makeLinkError(status: number, code: string | undefined, message: string): { status: number; code?: string; message: string } {
  return { status, code, message };
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthProviders.mockReturnValue({ data: PROVIDERS });
  useLinkedAuthProviders.mockReturnValue({ data: [] });
  useUnlinkAuthProvider.mockReturnValue({ mutate: unlinkMutate, isPending: false, isError: false, error: null });
  useStartProviderLink.mockReturnValue({ mutate: startMutate, isPending: false, isError: false });
  usePendingLinkCompletion.mockReturnValue({ isLoading: false, isError: false, error: null, data: undefined, refetch: refetchConfirmation });
  useCompleteProviderLink.mockReturnValue({ mutate: completeMutate, isPending: false });
});

afterEach(cleanup);

const confirmUnlink = () => {
  fireEvent.click(screen.getByRole('button', { name: /連携を解除/ }));
  fireEvent.click(screen.getByRole('button', { name: '解除する' }));
};

describe('LinkedAccountsSection', () => {
  it('renders nothing when the instance has no federated providers', () => {
    useAuthProviders.mockReturnValue({ data: [] });
    const { container } = render(<LinkedAccountsSection />);

    expect(container).toBeEmptyDOMElement();
  });

  it('offers Link for a provider that is not connected', () => {
    render(<LinkedAccountsSection />);

    expect(screen.getByText('未連携')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /連携する/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /連携を解除/ })).not.toBeInTheDocument();
  });

  it('offers Unlink for a connected provider', () => {
    useLinkedAuthProviders.mockReturnValue({ data: ['google'] });
    render(<LinkedAccountsSection />);

    expect(screen.getByText('連携済み')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /連携を解除/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /連携する/ })).not.toBeInTheDocument();
  });

  // AC-2: start POST only, then a full navigation to the returned authorizationUrl.
  it('navigates to the authorizationUrl returned by a successful start POST', async () => {
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign } as unknown as Location);
    startMutate.mockImplementation((_provider: string, opts?: { onSuccess?: (data: { authorizationUrl: string }) => void }) => {
      opts?.onSuccess?.({ authorizationUrl: 'https://api.example.com/api/auth/providers/google/callback?state=xyz' });
    });

    render(<LinkedAccountsSection />);
    fireEvent.click(screen.getByRole('button', { name: /連携する/ }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://api.example.com/api/auth/providers/google/callback?state=xyz'));
    expect(startMutate).toHaveBeenCalledWith('google', expect.anything());
  });

  it('reports a failure to start linking without navigating', () => {
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign } as unknown as Location);
    useStartProviderLink.mockReturnValue({ mutate: startMutate, isPending: false, isError: true });

    render(<LinkedAccountsSection />);

    expect(screen.getByText('連携を開始できませんでした。')).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('only unlinks after the confirmation is accepted', () => {
    useLinkedAuthProviders.mockReturnValue({ data: ['google'] });
    render(<LinkedAccountsSection />);

    fireEvent.click(screen.getByRole('button', { name: /連携を解除/ }));
    expect(unlinkMutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(unlinkMutate).not.toHaveBeenCalled();
  });

  it('unlinks the confirmed provider', () => {
    useLinkedAuthProviders.mockReturnValue({ data: ['google'] });
    render(<LinkedAccountsSection />);

    confirmUnlink();

    expect(unlinkMutate).toHaveBeenCalledWith('google');
  });

  // The server owns the "you would lock yourself out" verdict, so its
  // message is shown verbatim and the row stays as it was — no optimistic
  // flip to "not linked".
  it('shows the server refusal and keeps the provider linked', () => {
    useLinkedAuthProviders.mockReturnValue({ data: ['google'] });
    useUnlinkAuthProvider.mockReturnValue({
      mutate: unlinkMutate,
      isPending: false,
      isError: true,
      error: Object.assign(new Error('パスワードを設定してください。'), { code: 'PASSWORD_REQUIRED' }),
    });
    render(<LinkedAccountsSection />);

    expect(screen.getByText('パスワードを設定してください。')).toBeInTheDocument();
    expect(screen.getByText('連携済み')).toBeInTheDocument();
  });

  it('surfaces a failure to load the linked list', () => {
    useLinkedAuthProviders.mockReturnValue({ data: undefined, isError: true });
    render(<LinkedAccountsSection />);

    expect(screen.getByText('連携状況を読み込めませんでした。')).toBeInTheDocument();
  });
});

describe('PendingLinkCompletionContainer', () => {
  const pending = { provider: 'google', code: 'a'.repeat(43) };

  it('renders nothing when there is no pending completion', () => {
    const { container } = render(<PendingLinkCompletionContainer pending={null} onPendingChange={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('opens purely from `pending` being non-null — independent of the profile/provider-list state', () => {
    useAuthProviders.mockReturnValue({ data: undefined, isLoading: true }); // provider list still loading
    usePendingLinkCompletion.mockReturnValue({ isLoading: true, isError: false, error: null, data: undefined, refetch: refetchConfirmation });

    render(<PendingLinkCompletionContainer pending={pending} onPendingChange={vi.fn()} />);

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText('確認情報を読み込んでいます…')).toBeInTheDocument();
  });

  it('shows the confirmation with the account label when the GET succeeds', () => {
    usePendingLinkCompletion.mockReturnValue({
      isLoading: false,
      isError: false,
      error: null,
      data: { provider: 'google', accountLabel: 'user@example.com' },
      refetch: refetchConfirmation,
    });

    render(<PendingLinkCompletionContainer pending={pending} onPendingChange={vi.fn()} />);

    expect(screen.getByText('Google（user@example.com）を連携しますか?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '連携する' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'キャンセル' })).toBeInTheDocument();
  });

  it('falls back to the provider SLUG when the provider list is unavailable (loading/error/empty)', () => {
    useAuthProviders.mockReturnValue({ data: undefined });
    usePendingLinkCompletion.mockReturnValue({
      isLoading: false,
      isError: false,
      error: null,
      data: { provider: 'google' },
      refetch: refetchConfirmation,
    });

    render(<PendingLinkCompletionContainer pending={pending} onPendingChange={vi.fn()} />);

    expect(screen.getByText('google を連携しますか?')).toBeInTheDocument();
  });

  it('never auto-POSTs before confirmation', () => {
    usePendingLinkCompletion.mockReturnValue({
      isLoading: false,
      isError: false,
      error: null,
      data: { provider: 'google' },
      refetch: refetchConfirmation,
    });

    render(<PendingLinkCompletionContainer pending={pending} onPendingChange={vi.fn()} />);

    expect(completeMutate).not.toHaveBeenCalled();
  });

  it('cancel discards the pending completion without posting', () => {
    usePendingLinkCompletion.mockReturnValue({
      isLoading: false,
      isError: false,
      error: null,
      data: { provider: 'google' },
      refetch: refetchConfirmation,
    });
    const onPendingChange = vi.fn();

    render(<PendingLinkCompletionContainer pending={pending} onPendingChange={onPendingChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));

    expect(completeMutate).not.toHaveBeenCalled();
    expect(onPendingChange).toHaveBeenCalledWith(null);
  });

  it.each([
    ['network', makeLinkError(0, undefined, 'network error')],
    ['400', makeLinkError(400, 'VALIDATION_ERROR', '400 error')],
    ['404', makeLinkError(404, 'NOT_FOUND', '404 error')],
    ['409', makeLinkError(409, 'LINK_COMPLETION_CONSUMED', '409 error')],
    ['500', makeLinkError(500, 'INTERNAL_ERROR', '500 error')],
  ])('confirmation GET %s: keeps pending, shows retry, and pressing it calls refetch()', (_label, error) => {
    usePendingLinkCompletion.mockReturnValue({ isLoading: false, isError: true, error, data: undefined, refetch: refetchConfirmation });
    const onPendingChange = vi.fn();

    render(<PendingLinkCompletionContainer pending={pending} onPendingChange={onPendingChange} />);
    expect(screen.getByText('連携確認を読み込めませんでした。')).toBeInTheDocument();
    expect(onPendingChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '再試行' }));
    expect(refetchConfirmation).toHaveBeenCalledTimes(1);
    // Retry must NOT discard the pending code (unlike Radix's default AlertDialogAction dismiss-on-click behavior).
    expect(onPendingChange).not.toHaveBeenCalled();
  });

  it('200 success: parent code discarded, terminal result shown, dialog stays open until closed', () => {
    usePendingLinkCompletion.mockReturnValue({
      isLoading: false,
      isError: false,
      error: null,
      data: { provider: 'google' },
      refetch: refetchConfirmation,
    });
    completeMutate.mockImplementation((_input: unknown, opts?: { onSuccess?: () => void }) => {
      opts?.onSuccess?.();
    });
    const onPendingChange = vi.fn();

    render(<PendingLinkCompletionContainer pending={pending} onPendingChange={onPendingChange} />);
    fireEvent.click(screen.getByRole('button', { name: '連携する' }));

    expect(onPendingChange).toHaveBeenCalledWith(null);
    expect(screen.getByText('アカウントを連携しました。')).toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument(); // still open

    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
  });

  it.each([
    ['VALIDATION_ERROR (malformed)', 400, 'VALIDATION_ERROR', '連携に失敗しました。もう一度お試しください。'],
    ['NOT_FOUND (invalid/expired)', 404, 'NOT_FOUND', 'この連携確認は無効か期限切れです。現在の連携状況は下の一覧で確認できます。'],
    ['FEDERATED_IDENTITY_IN_USE', 409, 'FEDERATED_IDENTITY_IN_USE', 'その外部アカウントは既に他のユーザーが使用しています。'],
    [
      'FEDERATED_LINK_AUTH_STATE_CHANGED',
      409,
      'FEDERATED_LINK_AUTH_STATE_CHANGED',
      '連携を開始してからセッションの状態が変わりました。もう一度サインインしてやり直してください。',
    ],
    ['FEDERATED_LINK_NOT_LINKED', 409, 'FEDERATED_LINK_NOT_LINKED', 'このアカウントは連携されていません。'],
  ])('final POST 4xx (%s): parent code discarded, the matching terminal message is shown', (_label, status, code, expectedMessage) => {
    usePendingLinkCompletion.mockReturnValue({
      isLoading: false,
      isError: false,
      error: null,
      data: { provider: 'google' },
      refetch: refetchConfirmation,
    });
    completeMutate.mockImplementation((_input: unknown, opts?: { onError?: (error: unknown) => void }) => {
      opts?.onError?.(makeLinkError(status, code, expectedMessage));
    });
    const onPendingChange = vi.fn();

    render(<PendingLinkCompletionContainer pending={pending} onPendingChange={onPendingChange} />);
    fireEvent.click(screen.getByRole('button', { name: '連携する' }));

    expect(onPendingChange).toHaveBeenCalledWith(null);
    expect(screen.getByText(expectedMessage)).toBeInTheDocument();
  });

  it.each([
    ['network', makeLinkError(0, undefined, 'network down')],
    ['500', makeLinkError(500, 'INTERNAL_ERROR', 'server exploded')],
  ])('final POST %s: keeps the SAME pending code (no discard), stays on the confirm view for a retry', (_label, error) => {
    usePendingLinkCompletion.mockReturnValue({
      isLoading: false,
      isError: false,
      error: null,
      data: { provider: 'google' },
      refetch: refetchConfirmation,
    });
    completeMutate.mockImplementation((_input: unknown, opts?: { onError?: (error: unknown) => void }) => {
      opts?.onError?.(error);
    });
    const onPendingChange = vi.fn();

    render(<PendingLinkCompletionContainer pending={pending} onPendingChange={onPendingChange} />);
    fireEvent.click(screen.getByRole('button', { name: '連携する' }));

    expect(onPendingChange).not.toHaveBeenCalled();
    // Still on the confirm view — the Link button is still there to resend.
    expect(screen.getByRole('button', { name: '連携する' })).toBeInTheDocument();
    expect(screen.getByText(error.message)).toBeInTheDocument();
  });

  it('no linked-list refetch special-casing: a generic LINK_COMPLETION_CONSUMED-shaped POST error is treated like any other 4xx (terminal result, code discarded)', () => {
    usePendingLinkCompletion.mockReturnValue({
      isLoading: false,
      isError: false,
      error: null,
      data: { provider: 'google' },
      refetch: refetchConfirmation,
    });
    completeMutate.mockImplementation((_input: unknown, opts?: { onError?: (error: unknown) => void }) => {
      opts?.onError?.(makeLinkError(409, 'LINK_COMPLETION_CONSUMED', 'already used'));
    });
    const onPendingChange = vi.fn();

    render(<PendingLinkCompletionContainer pending={pending} onPendingChange={onPendingChange} />);
    fireEvent.click(screen.getByRole('button', { name: '連携する' }));

    expect(onPendingChange).toHaveBeenCalledWith(null);
    // Falls into the generic "failed" bucket — LINK_COMPLETION_CONSUMED is not one of the POST's own conflict codes.
    expect(screen.getByText('連携に失敗しました。もう一度お試しください。')).toBeInTheDocument();
  });
});
