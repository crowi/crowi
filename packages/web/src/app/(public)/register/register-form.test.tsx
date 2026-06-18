import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppInfoResponse } from '@crowi/api-contract';

// RegisterForm reads /app/info to decide whether self-service registration
// is open. Mock the hook (and the api client it would call on submit) so the
// test is pure layout — no react-query, no network. Paraglide messages are
// the real compiled output (aliased in vitest.config.ts), so the rendered
// copy matches production.
const { useAppInfo } = vi.hoisted(() => ({ useAppInfo: vi.fn() }));
vi.mock('@/lib/use-app-info', () => ({ useAppInfo }));
vi.mock('@/lib/api-client', () => ({ apiClientV2: {} }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }));

import { RegisterForm } from './register-form';

type AppInfoQuery = {
  data?: AppInfoResponse;
  isLoading: boolean;
  isError: boolean;
};

const mockAppInfo = (state: AppInfoQuery) => {
  useAppInfo.mockReturnValue(state);
};

const makeAppInfo = (canSelfRegister: boolean): AppInfoResponse => ({
  title: null,
  confidential: null,
  version: '0.0.0',
  apiVersion: 'v2',
  capabilities: [],
  canSelfRegister,
});

afterEach(cleanup);

describe('RegisterForm registration-closed guard', () => {
  it('shows the invite-only notice (no form) when canSelfRegister is false', () => {
    mockAppInfo({ data: makeAppInfo(false), isLoading: false, isError: false });
    render(<RegisterForm />);

    // Invite-only card + a way back to sign in, instead of the form.
    expect(screen.getByText('登録は招待制です')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /サインインに戻る/ })).toHaveAttribute('href', '/login');
    expect(screen.queryByLabelText('ユーザーID')).not.toBeInTheDocument();
  });

  it('shows the registration form when canSelfRegister is true (Open / Restricted)', () => {
    mockAppInfo({ data: makeAppInfo(true), isLoading: false, isError: false });
    render(<RegisterForm />);

    expect(screen.getByLabelText('ユーザーID')).toBeInTheDocument();
    expect(screen.queryByText('登録は招待制です')).not.toBeInTheDocument();
  });

  it('fails open and shows the form when the /app/info fetch errors', () => {
    mockAppInfo({ data: undefined, isLoading: false, isError: true });
    render(<RegisterForm />);

    expect(screen.getByLabelText('ユーザーID')).toBeInTheDocument();
    expect(screen.queryByText('登録は招待制です')).not.toBeInTheDocument();
  });

  it('renders the skeleton (neither form nor notice) while /app/info is loading', () => {
    mockAppInfo({ data: undefined, isLoading: true, isError: false });
    render(<RegisterForm />);

    expect(screen.queryByLabelText('ユーザーID')).not.toBeInTheDocument();
    expect(screen.queryByText('登録は招待制です')).not.toBeInTheDocument();
  });
});
