import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AppInfoQuery, makeAppInfo } from '@/lib/use-app-info.test-helpers';

// LoginForm reads /app/info to decide whether to surface the "sign up" link.
// Mock the hook + navigation + the login helper so the test is pure layout.
// Paraglide messages are the real compiled output (aliased in
// vitest.config.ts).
const { useAppInfo } = vi.hoisted(() => ({ useAppInfo: vi.fn() }));
vi.mock('@/lib/use-app-info', () => ({ useAppInfo }));
vi.mock('@/lib/auth-login', () => ({ loginWithPassword: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { LoginForm } from './login-form';

const mockAppInfo = (state: AppInfoQuery) => {
  useAppInfo.mockReturnValue(state);
};

const registerLink = () => screen.queryByRole('link', { name: /新規登録/ });

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
