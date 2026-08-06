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
    { name: 'google', buttonLabel: 'Google で続ける' },
    { name: 'okta', buttonLabel: 'Okta で続ける' },
  ];

  beforeEach(() => {
    mockAppInfo({ data: makeAppInfo({ canSelfRegister: true }), isLoading: false, isError: false });
  });

  it('renders one button per enabled provider, in API order', () => {
    useAuthProviders.mockReturnValue({ data: providers });
    render(<LoginForm />);

    const labels = screen.getAllByRole('button').map((button) => button.textContent);
    expect(labels).toEqual([expect.stringContaining('サインイン'), 'Google で続ける', 'Okta で続ける']);
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

    expect(screen.queryByRole('button', { name: 'Google で続ける' })).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: 'Google で続ける' }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://api.example.com/api/auth/providers/google/start?signed=1'));
    expect(buildProviderStartUrl).toHaveBeenCalledWith('google', '/wiki/page');
  });

  it('rejects an off-site continue before it reaches the start URL', async () => {
    searchParams.current = new URLSearchParams('continue=//evil.example/');
    useAuthProviders.mockReturnValue({ data: providers });
    buildProviderStartUrl.mockResolvedValue('https://api.example.com/start');
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign: vi.fn() } as unknown as Location);

    render(<LoginForm />);
    fireEvent.click(screen.getByRole('button', { name: 'Google で続ける' }));

    await waitFor(() => expect(buildProviderStartUrl).toHaveBeenCalledWith('google', '/'));
  });

  it('surfaces an error and re-enables the buttons when the start URL cannot be built', async () => {
    useAuthProviders.mockReturnValue({ data: providers });
    buildProviderStartUrl.mockRejectedValue(new Error('no subtle crypto'));

    render(<LoginForm />);
    fireEvent.click(screen.getByRole('button', { name: 'Google で続ける' }));

    expect(await screen.findByText('サインイン方法を読み込めませんでした。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Google で続ける' })).toBeEnabled();
  });
});
