import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `page.tsx`'s page-boundary capture
 * effect: `provider`+`link_completion` off the URL becomes component state
 * BEFORE (independent of) `useProfile`'s own loading/error/not-found
 * branches, the URL is rewritten via `history.replaceState` exactly once,
 * and `PendingLinkCompletionContainer` mounts unconditionally regardless of
 * profile state or whether the Security tab's own content ever renders.
 *
 * Every child (`SettingsLayout`, `LinkedAccountsSection`,
 * `PendingLinkCompletionContainer`) and hook (`useProfile`, `usePageTitle`)
 * is mocked — this file tests ONLY the page-boundary wiring; the
 * confirmation dialog's own states are covered in
 * `linked-accounts-section.test.tsx`.
 */
const { searchParams, useProfile } = vi.hoisted(() => ({
  searchParams: { current: new URLSearchParams() },
  useProfile: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useSearchParams: () => searchParams.current }));
vi.mock('@/lib/use-profile', () => ({ useProfile }));
vi.mock('@/lib/use-page-title', () => ({ usePageTitle: () => {} }));

// `SettingsLayout` renders NEITHER `profileTab` nor `securityTab` by
// default — this models "the Security tab (and therefore
// `LinkedAccountsSection`) never mounted" so AC-15's "persists even
// without the Security tab mounted" property is exercised directly,
// without needing a real Radix Tabs + jsdom interaction.
vi.mock('./settings-layout', () => ({
  SettingsLayout: () => <div data-testid="settings-layout" />,
}));

vi.mock('./linked-accounts-section', () => ({
  LinkedAccountsSection: () => <div data-testid="linked-accounts-section" />,
  PendingLinkCompletionContainer: ({ pending }: { pending: { provider: string; code: string } | null }) => (
    <div data-testid="pending-container">{pending ? `${pending.provider}:${pending.code}` : 'none'}</div>
  ),
}));

import SettingsPage from './page';

const PROFILE = { id: 'u1', federated: false, createdAt: '2024-01-01T00:00:00Z' };

/**
 * Sets BOTH the mocked `useSearchParams()` return value AND jsdom's real
 * `window.location` (via `pushState`, never `replaceState` — that method
 * is what THIS file spies on and asserts against) so the two never drift
 * apart. The page's own effect reads the query via `useSearchParams()` but
 * rewrites the URL via `new URL(window.location.href)` — exactly like a
 * real browser, where both already agree.
 */
function setQuery(query: string): void {
  searchParams.current = new URLSearchParams(query);
  window.history.pushState({}, '', query ? `/me?${query}` : '/me');
}

beforeEach(() => {
  vi.clearAllMocks();
  setQuery('');
  useProfile.mockReturnValue({ data: PROFILE, isLoading: false, error: null });
  vi.spyOn(window.history, 'replaceState');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SettingsPage — page-boundary link-completion capture (AC-15)', () => {
  it('captures provider+link_completion and strips the URL even while the profile is still LOADING', () => {
    setQuery('provider=google&link_completion=CODE123');
    useProfile.mockReturnValue({ data: undefined, isLoading: true, error: null });

    render(<SettingsPage />);

    expect(screen.getByTestId('pending-container')).toHaveTextContent('google:CODE123');
    expect(window.history.replaceState).toHaveBeenCalledTimes(1);
    const [, , url] = (window.history.replaceState as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [unknown, unknown, string];
    expect(url).not.toContain('link_completion');
    expect(url).toContain('tab=security');
    expect(url).toContain('provider=google');
  });

  it('captures provider+link_completion while the profile fetch ERRORED', () => {
    setQuery('provider=google&link_completion=CODE123');
    useProfile.mockReturnValue({ data: undefined, isLoading: false, error: new Error('boom') });

    render(<SettingsPage />);

    expect(screen.getByTestId('pending-container')).toHaveTextContent('google:CODE123');
    expect(window.history.replaceState).toHaveBeenCalledTimes(1);
  });

  it('captures provider+link_completion when the profile resolves to NOT-FOUND (no data, no error, not loading)', () => {
    setQuery('provider=google&link_completion=CODE123');
    useProfile.mockReturnValue({ data: undefined, isLoading: false, error: null });

    render(<SettingsPage />);

    expect(screen.getByTestId('pending-container')).toHaveTextContent('google:CODE123');
    expect(window.history.replaceState).toHaveBeenCalledTimes(1);
  });

  it('persists the captured pending value once the profile later resolves, independent of the Security tab ever mounting', () => {
    setQuery('provider=google&link_completion=CODE123');
    useProfile.mockReturnValue({ data: undefined, isLoading: true, error: null });

    const { rerender } = render(<SettingsPage />);
    expect(screen.getByTestId('pending-container')).toHaveTextContent('google:CODE123');

    // Profile resolves; `SettingsLayout` is still mocked to render nothing
    // (Security tab / LinkedAccountsSection never mount) — the pending
    // value must survive regardless.
    useProfile.mockReturnValue({ data: PROFILE, isLoading: false, error: null });
    rerender(<SettingsPage />);

    expect(screen.getByTestId('pending-container')).toHaveTextContent('google:CODE123');
    expect(screen.queryByTestId('linked-accounts-section')).not.toBeInTheDocument();
  });

  it('one-shot: a later re-render never re-captures or re-strips the URL a second time', () => {
    setQuery('provider=google&link_completion=CODE123');
    useProfile.mockReturnValue({ data: undefined, isLoading: true, error: null });

    const { rerender } = render(<SettingsPage />);
    expect(window.history.replaceState).toHaveBeenCalledTimes(1);

    useProfile.mockReturnValue({ data: PROFILE, isLoading: false, error: null });
    rerender(<SettingsPage />);
    rerender(<SettingsPage />);

    expect(window.history.replaceState).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('pending-container')).toHaveTextContent('google:CODE123');
  });

  it('ignores a lone ?provider= with no link_completion — no capture, no URL rewrite', () => {
    setQuery('provider=google');

    render(<SettingsPage />);

    expect(screen.getByTestId('pending-container')).toHaveTextContent('none');
    expect(window.history.replaceState).not.toHaveBeenCalled();
  });

  it('ignores a lone ?link_completion= with no provider — no capture, no URL rewrite', () => {
    setQuery('link_completion=CODE123');

    render(<SettingsPage />);

    expect(screen.getByTestId('pending-container')).toHaveTextContent('none');
    expect(window.history.replaceState).not.toHaveBeenCalled();
  });

  it('with neither query present, mounts the pending container with null and never touches history', () => {
    render(<SettingsPage />);

    expect(screen.getByTestId('pending-container')).toHaveTextContent('none');
    expect(window.history.replaceState).not.toHaveBeenCalled();
  });
});
