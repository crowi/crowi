import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The section composes three react-query hooks plus the link-start
// helper; all four are mocked so this stays a pure component test.
// Paraglide messages are the real compiled output (aliased in
// vitest.config.ts), so assertions match the rendered copy.
const { searchParams, useAuthProviders, useLinkedAuthProviders, useUnlinkAuthProvider, buildProviderLinkStartUrl, unlinkMutate } = vi.hoisted(() => ({
  searchParams: { current: new URLSearchParams() },
  useAuthProviders: vi.fn(),
  useLinkedAuthProviders: vi.fn(),
  useUnlinkAuthProvider: vi.fn(),
  buildProviderLinkStartUrl: vi.fn(),
  unlinkMutate: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useSearchParams: () => searchParams.current }));
vi.mock('@/lib/use-auth-providers', () => ({ useAuthProviders, useLinkedAuthProviders, useUnlinkAuthProvider }));
vi.mock('@/lib/auth-handoff', () => ({ buildProviderLinkStartUrl }));

import { LinkedAccountsSection } from './linked-accounts-section';

const PROVIDERS = [{ name: 'google', buttonLabel: 'Google' }];

beforeEach(() => {
  vi.clearAllMocks();
  searchParams.current = new URLSearchParams();
  useAuthProviders.mockReturnValue({ data: PROVIDERS });
  useLinkedAuthProviders.mockReturnValue({ data: [] });
  useUnlinkAuthProvider.mockReturnValue({ mutate: unlinkMutate, isPending: false, isError: false, error: null });
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

  // Link mode needs a server-minted grant bound to a fresh sender key, so
  // the URL only exists after an async step — hence a click, not an href.
  it('navigates to the link start URL, returning to /me', async () => {
    buildProviderLinkStartUrl.mockResolvedValue('https://api.example.com/api/auth/providers/google/start?link=1');
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign } as unknown as Location);

    render(<LinkedAccountsSection />);
    fireEvent.click(screen.getByRole('button', { name: /連携する/ }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://api.example.com/api/auth/providers/google/start?link=1'));
    expect(buildProviderLinkStartUrl).toHaveBeenCalledWith('google', '/me');
  });

  it('reports a failure to start linking without navigating', async () => {
    buildProviderLinkStartUrl.mockRejectedValue(new Error('grant refused'));
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign } as unknown as Location);

    render(<LinkedAccountsSection />);
    fireEvent.click(screen.getByRole('button', { name: /連携する/ }));

    expect(await screen.findByText('連携を開始できませんでした。')).toBeInTheDocument();
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

  // A completed link comes back as a full-page redirect carrying its
  // outcome in the URL — there is no in-page mutation result to read.
  it.each([
    ['linked', 'アカウントを連携しました。'],
    ['federated_identity_in_use', 'その外部アカウントは既に他のユーザーが使用しています。'],
    ['link_failed', '連携に失敗しました。もう一度お試しください。'],
  ])('reports the ?link=%s outcome of a returning link flow', (result, message) => {
    searchParams.current = new URLSearchParams(`provider=google&link=${result}`);
    render(<LinkedAccountsSection />);

    expect(screen.getByText(message)).toBeInTheDocument();
  });

  it('ignores an unrecognised ?link= value', () => {
    searchParams.current = new URLSearchParams('provider=google&link=made-up');
    render(<LinkedAccountsSection />);

    expect(screen.queryByText('アカウントを連携しました。')).not.toBeInTheDocument();
  });
});

describe('LinkedAccountsSection link outcome styling', () => {
  // A confirmed success rendered in the same neutral card as everything
  // else read as chrome — the user reported missing it entirely.
  it('shows a successful link in the success style, not the neutral one', () => {
    searchParams.current = new URLSearchParams('provider=google&link=linked');
    render(<LinkedAccountsSection />);

    expect(screen.getByText('アカウントを連携しました。').closest('[role="alert"]')).toHaveClass('text-crowi-success');
  });

  it.each(['federated_identity_in_use', 'link_failed'])('keeps a failed link destructive (?link=%s)', (result) => {
    searchParams.current = new URLSearchParams(`provider=google&link=${result}`);
    render(<LinkedAccountsSection />);

    expect(screen.getByRole('alert')).toHaveClass('text-destructive');
  });
});
