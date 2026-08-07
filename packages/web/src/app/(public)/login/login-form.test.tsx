import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AppInfoQuery, makeAppInfo } from '@/lib/use-app-info.test-helpers';

// LoginForm reads /app/info to decide whether to surface the "sign up" link.
// Mock the hook + navigation + the login helper so the test is pure layout.
// Paraglide messages are the real compiled output (aliased in
// vitest.config.ts).
const { useAppInfo, useAuthProviders, buildProviderStartUrl } = vi.hoisted(() => ({
  useAppInfo: vi.fn(),
  useAuthProviders: vi.fn(),
  buildProviderStartUrl: vi.fn(),
}));
vi.mock('@/lib/use-app-info', () => ({ useAppInfo }));
vi.mock('@/lib/use-auth-providers', () => ({ useAuthProviders }));
vi.mock('@/lib/auth-handoff', () => ({ buildProviderStartUrl }));
vi.mock('@/lib/auth-login', () => ({ loginWithPassword: vi.fn() }));
const searchParams = { current: new URLSearchParams() };
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => searchParams.current,
}));

import { LoginForm } from './login-form';

const mockAppInfo = (state: AppInfoQuery) => {
  useAppInfo.mockReturnValue(state);
};

const registerLink = () => screen.queryByRole('link', { name: /新規登録/ });

beforeEach(() => {
  searchParams.current = new URLSearchParams();
  useAuthProviders.mockReturnValue({ data: undefined });
  buildProviderStartUrl.mockReset();
});

afterEach(cleanup);

describe('LoginForm registration link', () => {
  it('hides the sign-up link when canSelfRegister is false (Closed)', () => {
    mockAppInfo({ data: makeAppInfo({ canSelfRegister: false }), isLoading: false, isError: false });
    render(<LoginForm />);

    expect(registerLink()).not.toBeInTheDocument();
  });

  it('shows the sign-up link when canSelfRegister is true (Open / Restricted)', () => {
    mockAppInfo({ data: makeAppInfo({ canSelfRegister: true }), isLoading: false, isError: false });
    render(<LoginForm />);

    expect(registerLink()).toHaveAttribute('href', '/register');
  });

  it('fails open and shows the sign-up link while /app/info is loading or errored', () => {
    mockAppInfo({ data: undefined, isLoading: false, isError: true });
    render(<LoginForm />);

    expect(registerLink()).toHaveAttribute('href', '/register');
  });
});

describe('LoginForm federated provider buttons', () => {
  const providers = [
    { name: 'google', buttonLabel: 'Google' },
    { name: 'okta', buttonLabel: 'Okta' },
  ];

  beforeEach(() => {
    mockAppInfo({ data: makeAppInfo({ canSelfRegister: true }), isLoading: false, isError: false });
  });

  it('renders one button per enabled provider, in API order', () => {
    useAuthProviders.mockReturnValue({ data: providers });
    render(<LoginForm />);

    const labels = screen.getAllByRole('button').map((button) => button.textContent);
    expect(labels).toEqual([expect.stringContaining('サインイン'), 'Google でサインイン', 'Okta でサインイン']);
  });

  // Fail-closed: a button that might not reach a configured provider is
  // worse than no button, since password sign-in below always works.
  it.each([
    ['while the provider list is loading', { data: undefined }],
    ['when the provider list failed to load', { data: undefined, isError: true }],
    ['when no provider is enabled', { data: [] }],
  ])('renders no provider button %s', (_label, queryState) => {
    useAuthProviders.mockReturnValue(queryState);
    render(<LoginForm />);

    expect(screen.queryByRole('button', { name: 'Google でサインイン' })).not.toBeInTheDocument();
    // The password form and the registration link must survive all three.
    expect(screen.getByRole('button', { name: /サインイン/ })).toBeInTheDocument();
    expect(registerLink()).toHaveAttribute('href', '/register');
  });

  // Not a plain href: `/start` demands a sender proof that only exists
  // after an async signing step, so the navigation happens on click.
  it('navigates to the signed start URL, carrying the sanitised continue', async () => {
    searchParams.current = new URLSearchParams('continue=/wiki/page');
    useAuthProviders.mockReturnValue({ data: providers });
    buildProviderStartUrl.mockResolvedValue('https://api.example.com/api/auth/providers/google/start?signed=1');
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign } as unknown as Location);

    render(<LoginForm />);
    fireEvent.click(screen.getByRole('button', { name: 'Google でサインイン' }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://api.example.com/api/auth/providers/google/start?signed=1'));
    expect(buildProviderStartUrl).toHaveBeenCalledWith('google', '/wiki/page');
  });

  it('rejects an off-site continue before it reaches the start URL', async () => {
    searchParams.current = new URLSearchParams('continue=//evil.example/');
    useAuthProviders.mockReturnValue({ data: providers });
    buildProviderStartUrl.mockResolvedValue('https://api.example.com/start');
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign: vi.fn() } as unknown as Location);

    render(<LoginForm />);
    fireEvent.click(screen.getByRole('button', { name: 'Google でサインイン' }));

    await waitFor(() => expect(buildProviderStartUrl).toHaveBeenCalledWith('google', '/'));
  });

  it('surfaces an error and re-enables the buttons when the start URL cannot be built', async () => {
    useAuthProviders.mockReturnValue({ data: providers });
    buildProviderStartUrl.mockRejectedValue(new Error('no subtle crypto'));

    render(<LoginForm />);
    fireEvent.click(screen.getByRole('button', { name: 'Google でサインイン' }));

    expect(await screen.findByText('サインイン方法を読み込めませんでした。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Google でサインイン' })).toBeEnabled();
  });
});

// A federated failure has no response body — the callback redirects here
// with `?error=<code>`, so an unrendered code means a silent dead end.
describe('LoginForm federated failure reporting', () => {
  beforeEach(() => {
    mockAppInfo({ data: makeAppInfo({ canSelfRegister: true }), isLoading: false, isError: false });
  });

  it.each([
    ['registration_closed', 'このインスタンスは新規登録を受け付けていません。管理者に招待を依頼してください。'],
    ['email_already_registered', 'そのメールアドレスは既に登録されています。パスワードでサインインしたあと、設定画面からアカウントを連携してください。'],
    ['email_not_allowed', 'そのメールアドレスではサインインできません。管理者に問い合わせてください。'],
    ['account_inactive', 'アカウントがまだ有効になっていません。承認をお待ちください。'],
  ])('explains ?error=%s', (code, message) => {
    searchParams.current = new URLSearchParams(`error=${code}`);
    render(<LoginForm />);

    expect(screen.getByText(message)).toBeInTheDocument();
  });

  // Protocol/infra faults the visitor can neither diagnose nor act on.
  it.each([
    'idp_error',
    'invalid_state',
    'exchange_failed',
    'oidc_verification_failed',
    'profile_rejected',
    'registration_unavailable',
    'made-up',
  ])('falls back to the generic message for ?error=%s', (code) => {
    searchParams.current = new URLSearchParams(`error=${code}`);
    render(<LoginForm />);

    expect(screen.getByText('サインインを完了できませんでした。もう一度お試しください。')).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(code))).not.toBeInTheDocument();
  });

  it('shows no error banner on a plain visit', () => {
    render(<LoginForm />);

    expect(screen.queryByText(/サインインを完了できませんでした/)).not.toBeInTheDocument();
  });
});

// Google's sign-in branding requires its own mark on the button, and
// lucide ships no Google icon — so the logo is an inline SVG we own.
describe('LoginForm provider brand marks', () => {
  beforeEach(() => {
    mockAppInfo({ data: makeAppInfo({ canSelfRegister: true }), isLoading: false, isError: false });
  });

  it('draws the Google mark on the Google button', () => {
    useAuthProviders.mockReturnValue({ data: [{ name: 'google', buttonLabel: 'Google' }] });
    render(<LoginForm />);

    expect(screen.getByRole('button', { name: 'Google でサインイン' }).querySelector('svg')).toBeInTheDocument();
  });

  // A wrong logo is worse than no logo, and falling back to the API's
  // `iconUrl` would leak every visitor to a third-party host before they
  // have chosen to sign in with it.
  it('renders a label-only button for a provider we ship no mark for', () => {
    useAuthProviders.mockReturnValue({ data: [{ name: 'okta', buttonLabel: 'Okta', iconUrl: 'https://okta.example/logo.svg' }] });
    render(<LoginForm />);

    const button = screen.getByRole('button', { name: 'Okta でサインイン' });
    expect(button.querySelector('svg')).not.toBeInTheDocument();
    expect(button.querySelector('img')).not.toBeInTheDocument();
  });
});
