import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// LoginCompleteForm's whole job is redeeming the `?code=` in the URL, so
// the handoff helper and navigation are mocked and the assertions are
// about what it does with each outcome. Paraglide messages are the real
// compiled output (aliased in vitest.config.ts).
const { useRouterMock, searchParams, completeAuthHandoff } = vi.hoisted(() => ({
  useRouterMock: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
  searchParams: { current: new URLSearchParams() },
  completeAuthHandoff: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => useRouterMock,
  useSearchParams: () => searchParams.current,
}));
vi.mock('@/lib/auth-handoff', () => ({ completeAuthHandoff }));

import { LoginCompleteForm } from './login-complete-form';

beforeEach(() => {
  vi.clearAllMocks();
  searchParams.current = new URLSearchParams();
});

afterEach(cleanup);

describe('LoginCompleteForm', () => {
  it('redeems the code once and replaces to the sanitised continue', async () => {
    searchParams.current = new URLSearchParams('code=handoff-abc&continue=%2Fwiki%2Fpage');
    completeAuthHandoff.mockResolvedValue({ ok: true, username: 'alice' });

    render(<LoginCompleteForm />);

    await waitFor(() => expect(useRouterMock.replace).toHaveBeenCalledWith('/wiki/page'));
    expect(completeAuthHandoff).toHaveBeenCalledTimes(1);
    expect(completeAuthHandoff).toHaveBeenCalledWith('handoff-abc');
  });

  // `/` is what `/start` sends when the user had no explicit destination,
  // so it means "no preference" — same as password sign-in, land on the
  // user's own page rather than the portal root.
  it('lands on the user page when the continue carries no preference', async () => {
    searchParams.current = new URLSearchParams('code=handoff-abc&continue=%2F');
    completeAuthHandoff.mockResolvedValue({ ok: true, username: 'alice' });

    render(<LoginCompleteForm />);

    await waitFor(() => expect(useRouterMock.replace).toHaveBeenCalledWith('/user/alice'));
  });

  it('refuses an off-site continue rather than following it', async () => {
    searchParams.current = new URLSearchParams('code=handoff-abc&continue=https%3A%2F%2Fevil.example%2F');
    completeAuthHandoff.mockResolvedValue({ ok: true, username: 'alice' });

    render(<LoginCompleteForm />);

    await waitFor(() => expect(useRouterMock.replace).toHaveBeenCalledWith('/user/alice'));
  });

  it('shows the failure message and navigates nowhere when redemption fails', async () => {
    searchParams.current = new URLSearchParams('code=stale-code');
    completeAuthHandoff.mockResolvedValue({ ok: false, message: 'サインインを完了できませんでした。' });

    render(<LoginCompleteForm />);

    expect(await screen.findByText('サインインを完了できませんでした。')).toBeInTheDocument();
    expect(useRouterMock.replace).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: /サインイン画面に戻る/ })).toHaveAttribute('href', '/login');
  });

  it('never calls the api when the URL carries no code', async () => {
    render(<LoginCompleteForm />);

    expect(await screen.findByText('サインインを完了できませんでした。リンクの有効期限が切れているか、既に使用されています。')).toBeInTheDocument();
    expect(completeAuthHandoff).not.toHaveBeenCalled();
    expect(useRouterMock.replace).not.toHaveBeenCalled();
  });

  // A rejected promise must not leave the user staring at a spinner
  // forever, and must not be retried — the code is already spent.
  it('falls back to the invalid message when the helper throws', async () => {
    searchParams.current = new URLSearchParams('code=handoff-abc');
    completeAuthHandoff.mockRejectedValue(new Error('boom'));

    render(<LoginCompleteForm />);

    expect(await screen.findByText('サインインを完了できませんでした。リンクの有効期限が切れているか、既に使用されています。')).toBeInTheDocument();
    expect(useRouterMock.replace).not.toHaveBeenCalled();
  });
});
