import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hooks are mocked so this stays a pure component test; Paraglide messages are the real compiled output (aliased in vitest.config.ts), so assertions match the rendered copy — same technique as `linked-accounts-section.test.tsx`.
const { useOAuthSessions, useDeleteOAuthSession, mutateAsync } = vi.hoisted(() => ({
  useOAuthSessions: vi.fn(),
  useDeleteOAuthSession: vi.fn(),
  mutateAsync: vi.fn(),
}));

vi.mock('@/lib/use-oauth-sessions', () => ({
  useOAuthSessions,
  useDeleteOAuthSession,
}));

import { OAuthSessionsSection } from './oauth-sessions-section';

const SESSION = {
  id: 's1',
  clientId: 'crowi-cli',
  clientName: 'Crowi CLI',
  scopes: ['pages:read', 'pages:write'],
  authorizedAt: '2026-01-01T00:00:00.000Z',
  lastRefreshedAt: '2026-01-05T00:00:00.000Z',
  expiresAt: '2026-01-05T01:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  useOAuthSessions.mockReturnValue({ data: { oauthSessions: [SESSION] }, isLoading: false, error: null });
  useDeleteOAuthSession.mockReturnValue({ mutateAsync, isPending: false });
  mutateAsync.mockResolvedValue(SESSION);
});

afterEach(cleanup);

describe('OAuthSessionsSection', () => {
  it('shows a loading spinner while the list is loading', () => {
    useOAuthSessions.mockReturnValue({ data: undefined, isLoading: true, error: null });
    const { container } = render(<OAuthSessionsSection />);
    expect(container.querySelector('.animate-spin')).toBeInTheDocument();
  });

  it('shows a fetch-failed message on error', () => {
    useOAuthSessions.mockReturnValue({ data: undefined, isLoading: false, error: new Error('boom') });
    render(<OAuthSessionsSection />);
    expect(screen.getByText('認証済みアプリの取得に失敗しました。')).toBeInTheDocument();
  });

  it('shows the empty state when there are no sessions', () => {
    useOAuthSessions.mockReturnValue({ data: { oauthSessions: [] }, isLoading: false, error: null });
    render(<OAuthSessionsSection />);
    expect(screen.getByText('認証済みアプリはまだありません。')).toBeInTheDocument();
  });

  it('lists clientName, scopes, and all 3 timestamps for each session', () => {
    render(<OAuthSessionsSection />);
    expect(screen.getByText('Crowi CLI')).toBeInTheDocument();
    expect(screen.getByText('pages:read')).toBeInTheDocument();
    expect(screen.getByText('pages:write')).toBeInTheDocument();
    expect(screen.getByText(/認証日時 2026/)).toBeInTheDocument();
    expect(screen.getByText(/最終更新 2026/)).toBeInTheDocument();
    expect(screen.getByText(/有効期限 2026/)).toBeInTheDocument();
  });

  it('does not call the mutation before the confirm dialog is accepted', () => {
    render(<OAuthSessionsSection />);
    fireEvent.click(screen.getByRole('button', { name: '失効' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('calls the mutation with the tip id only after confirming', () => {
    render(<OAuthSessionsSection />);
    fireEvent.click(screen.getByRole('button', { name: '失効' }));
    fireEvent.click(screen.getByRole('button', { name: '失効する' }));
    expect(mutateAsync).toHaveBeenCalledWith('s1');
  });

  it('cancelling the dialog never calls the mutation', () => {
    render(<OAuthSessionsSection />);
    fireEvent.click(screen.getByRole('button', { name: '失効' }));
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('shows a revoke-failed message when the mutation rejects', async () => {
    mutateAsync.mockRejectedValue(new Error('server exploded'));
    render(<OAuthSessionsSection />);
    fireEvent.click(screen.getByRole('button', { name: '失効' }));
    fireEvent.click(screen.getByRole('button', { name: '失効する' }));

    expect(await screen.findByText('認証済みアプリの失効に失敗しました。もう一度お試しください。')).toBeInTheDocument();
  });

  // AC-7: "last refreshed" is refresh time (not last API access), and the web login session is not part of this list.
  it('explains that "last refreshed" is refresh time, not last API access, and that the web session is excluded (AC-7)', () => {
    render(<OAuthSessionsSection />);
    expect(screen.getByText('「最終更新」は refresh token が最後にローテーションされた日時であり、API の最終アクセス日時ではありません。')).toBeInTheDocument();
    expect(screen.getByText('web のログインセッションはこの一覧に表示されません。')).toBeInTheDocument();
  });

  // AC-11: revoking stops future refreshes reachable from the row, but an
  // already-issued access token keeps working until its TTL.
  it('explains that revoke stops reachable future refreshes while an issued access token stays usable until its TTL (AC-11)', () => {
    render(<OAuthSessionsSection />);
    expect(
      screen.getByText(
        '失効すると、選択した行から辿れる今後のアクセストークンの更新が止まります。発行済みのアクセストークンは有効期限 (既定 1 時間) まで引き続き利用できます。',
      ),
    ).toBeInTheDocument();
  });

  // AC-14: a concurrent-refresh fork leaves multiple persistent rows from
  // the same origin — each must be revoked individually.
  it('explains that rows from a concurrent-refresh fork must be revoked individually (AC-14)', () => {
    render(<OAuthSessionsSection />);
    expect(
      screen.getByText(/同じ認証情報が複数箇所から同時に更新された場合は複数行がそのまま残ることがあり、その場合は各行を個別に失効する必要があります。/),
    ).toBeInTheDocument();
  });

  // AC-15: an ordinary rotation's transient 2-row state converges on
  // refetch and is distinct from the AC-14 fork.
  it('explains that an ordinary rotation’s temporary extra row converges on reload and is not a fork (AC-15)', () => {
    render(<OAuthSessionsSection />);
    expect(
      screen.getByText(/通常のトークン更新中は同じアプリの行が一時的に複数表示されることがありますが、再読み込みすると 1 行に収束します。/),
    ).toBeInTheDocument();
  });
});
