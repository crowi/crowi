import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// FederatedRegisterForm reads `?token=` via next/navigation, talks to the
// typed apiClient, and clears tokens via auth-token.ts. All three are
// mocked so this is a pure component test — no react-query, no network.
// Paraglide messages are the real compiled output (aliased in
// vitest.config.ts), so assertions match the actual rendered copy.
const { useRouterMock, useSearchParamsMock, apiGet, apiPost, apiLogoutPost, clearTokensMock } = vi.hoisted(() => ({
  useRouterMock: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
  useSearchParamsMock: vi.fn(() => new URLSearchParams('token=grant-abc')),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiLogoutPost: vi.fn(),
  clearTokensMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => useRouterMock,
  useSearchParams: useSearchParamsMock,
}));

vi.mock('@/lib/api-client', () => ({
  apiClient: {
    auth: {
      'federated-registration': {
        ':token': {
          $get: apiGet,
          $post: apiPost,
          logout: { $post: apiLogoutPost },
        },
      },
    },
  },
}));

vi.mock('@/lib/auth-token', () => ({
  clearTokens: clearTokensMock,
}));

import { FederatedRegisterForm } from './federated-register-form';

const jsonResponse = (status: number, body: unknown) => ({ status, json: () => Promise.resolve(body) });
const SNAPSHOT = { email: 'user@example.com', provider: 'google', providerLabel: 'Google' };

afterEach(() => {
  cleanup();
  useRouterMock.push.mockReset();
  useRouterMock.replace.mockReset();
  apiGet.mockReset();
  apiPost.mockReset();
  apiLogoutPost.mockReset();
  clearTokensMock.mockReset();
  useSearchParamsMock.mockReturnValue(new URLSearchParams('token=grant-abc'));
});

const renderLoaded = async () => {
  apiGet.mockResolvedValue(jsonResponse(200, SNAPSHOT));
  render(<FederatedRegisterForm />);
  await waitFor(() => expect(screen.getByLabelText('ユーザーID')).toBeInTheDocument());
};

describe('FederatedRegisterForm', () => {
  describe('snapshot prefill + logout exit (AC-2, AC-8)', () => {
    it('prefills the read-only email, and always shows a logout link once loaded', async () => {
      await renderLoaded();
      expect(screen.getByLabelText('メールアドレス')).toHaveValue('user@example.com');
      expect(screen.getByLabelText('メールアドレス')).toHaveAttribute('readonly');
      expect(screen.getByRole('button', { name: 'サインインをやめる' })).toBeInTheDocument();
    });

    it('shows a logout link on the expired-grant screen too', async () => {
      apiGet.mockResolvedValue(jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'nope' } }));
      render(<FederatedRegisterForm />);
      await screen.findByText('登録リンクが無効です');
      expect(screen.getByRole('button', { name: 'サインインをやめる' })).toBeInTheDocument();
    });

    it('logout cancels the grant (best-effort) then always clears local tokens and replaces to /login', async () => {
      await renderLoaded();
      apiLogoutPost.mockRejectedValue(new Error('network error'));

      fireEvent.click(screen.getByRole('button', { name: 'サインインをやめる' }));

      await waitFor(() => expect(clearTokensMock).toHaveBeenCalledTimes(1));
      expect(useRouterMock.replace).toHaveBeenCalledWith('/login');
      expect(apiLogoutPost).toHaveBeenCalledWith({ param: { token: 'grant-abc' } });
    });

    it('shows a logout link WHILE the snapshot is still loading, before it resolves', async () => {
      let resolveGet: (value: unknown) => void = () => {};
      apiGet.mockReturnValue(
        new Promise((resolve) => {
          resolveGet = resolve;
        }),
      );
      render(<FederatedRegisterForm />);

      expect(screen.getByRole('button', { name: 'サインインをやめる' })).toBeInTheDocument();
      expect(screen.queryByLabelText('ユーザーID')).not.toBeInTheDocument();

      resolveGet(jsonResponse(200, SNAPSHOT));
      await waitFor(() => expect(screen.getByLabelText('ユーザーID')).toBeInTheDocument());
    });

    it('the approval-pending view logout ALSO cancels the grant + clears tokens + replaces to /login (not a plain link)', async () => {
      await renderLoaded();
      apiPost.mockResolvedValue(jsonResponse(200, { status: 'approval_required' }));
      apiLogoutPost.mockResolvedValue({ status: 204 });

      fireEvent.change(screen.getByLabelText('ユーザーID'), { target: { value: 'pending-approval-user' } });
      fireEvent.click(screen.getByRole('button', { name: '新規登録' }));
      await screen.findByText('登録を受け付けました');

      fireEvent.click(screen.getByRole('button', { name: 'サインインをやめる' }));

      await waitFor(() => expect(clearTokensMock).toHaveBeenCalledTimes(1));
      expect(apiLogoutPost).toHaveBeenCalledWith({ param: { token: 'grant-abc' } });
      expect(useRouterMock.replace).toHaveBeenCalledWith('/login');
    });

    it('a reauthenticated/refreshed visit against an already-finalized row still returns the plain snapshot (no `status` field) and shows the ordinary username form — approval status is conveyed ONLY by the submit response, never by GET', async () => {
      apiGet.mockResolvedValue(jsonResponse(200, SNAPSHOT));
      render(<FederatedRegisterForm />);

      await waitFor(() => expect(screen.getByLabelText('ユーザーID')).toBeInTheDocument());
      expect(screen.queryByText('登録を受け付けました')).not.toBeInTheDocument();
      expect(apiPost).not.toHaveBeenCalled();
    });
  });

  describe('snapshot load errors (AC-8: distinguishable from expiry)', () => {
    it('shows a general error state (NOT the expired-grant card) for a 500 GET response, with the logout link still present', async () => {
      apiGet.mockResolvedValue(jsonResponse(500, { error: { code: 'INTERNAL_ERROR', message: 'boom' } }));
      render(<FederatedRegisterForm />);

      expect(await screen.findByText('登録情報を読み込めませんでした')).toBeInTheDocument();
      expect(screen.queryByText('登録リンクが無効です')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'サインインをやめる' })).toBeInTheDocument();
    });

    it('shows the same general error state (NOT expiry) for a network-level failure loading the snapshot', async () => {
      apiGet.mockRejectedValue(new Error('network error'));
      render(<FederatedRegisterForm />);

      expect(await screen.findByText('登録情報を読み込めませんでした')).toBeInTheDocument();
      expect(screen.queryByText('登録リンクが無効です')).not.toBeInTheDocument();
    });
  });

  describe('grant expiry (AC-3, AC-8)', () => {
    it('shows the expired-link card for a 404 snapshot fetch', async () => {
      apiGet.mockResolvedValue(jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'nope' } }));
      render(<FederatedRegisterForm />);
      expect(await screen.findByText('登録リンクが無効です')).toBeInTheDocument();
      expect(screen.queryByLabelText('ユーザーID')).not.toBeInTheDocument();
    });

    it('shows the expired-link card when there is no token at all', async () => {
      useSearchParamsMock.mockReturnValue(new URLSearchParams());
      render(<FederatedRegisterForm />);
      expect(await screen.findByText('登録リンクが無効です')).toBeInTheDocument();
      expect(apiGet).not.toHaveBeenCalled();
    });

    it('submitting against an already-invalidated grant (404 on submit) also shows the expired-link card', async () => {
      await renderLoaded();
      apiPost.mockResolvedValue(jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'nope' } }));

      fireEvent.change(screen.getByLabelText('ユーザーID'), { target: { value: 'a-valid-username' } });
      fireEvent.click(screen.getByRole('button', { name: '新規登録' }));

      expect(await screen.findByText('登録リンクが無効です')).toBeInTheDocument();
    });
  });

  describe('username validation (AC-8, same UsernameSchema as the API)', () => {
    // 'empty string' is excluded: the `required` input attribute already
    // blocks the browser's native form submission before any JS runs, so
    // that case can never reach handleSubmit via a real click — the API
    // suite's own `INVALID_USERNAME_CASES` (packages/api/src/test/setup.ts)
    // covers it as a direct wire-level case instead.
    it.each([
      ['contains a dot', 'bad.name'],
      ['contains a Unicode character', 'ソタロウ'],
      ['65 characters (one over the boundary)', 'a'.repeat(65)],
    ])('rejects a username that is %s WITHOUT calling the API', async (_label, username) => {
      await renderLoaded();
      fireEvent.change(screen.getByLabelText('ユーザーID'), { target: { value: username } });
      fireEvent.click(screen.getByRole('button', { name: '新規登録' }));

      await waitFor(() => expect(screen.getByText('ユーザーIDは半角英数字・ハイフン・アンダースコアのみ、1〜64文字で入力してください。')).toBeInTheDocument());
      expect(apiPost).not.toHaveBeenCalled();
    });
  });

  describe('submit outcomes (AC-4, AC-8)', () => {
    it('conflict (409): shows an inline error and stays on the form for a retry', async () => {
      await renderLoaded();
      apiPost.mockResolvedValue(jsonResponse(409, { error: { code: 'USERNAME_TAKEN', message: 'Username already taken' } }));

      fireEvent.change(screen.getByLabelText('ユーザーID'), { target: { value: 'taken-name' } });
      fireEvent.click(screen.getByRole('button', { name: '新規登録' }));

      expect(await screen.findByText('そのユーザー名は既に使われています。')).toBeInTheDocument();
      expect(screen.getByLabelText('ユーザーID')).toBeInTheDocument();
      expect(useRouterMock.push).not.toHaveBeenCalled();
    });

    it('Restricted (approval_required): shows the approval-pending card, never navigates', async () => {
      await renderLoaded();
      apiPost.mockResolvedValue(jsonResponse(200, { status: 'approval_required' }));

      fireEvent.change(screen.getByLabelText('ユーザーID'), { target: { value: 'pending-approval-user' } });
      fireEvent.click(screen.getByRole('button', { name: '新規登録' }));

      expect(await screen.findByText('登録を受け付けました')).toBeInTheDocument();
      expect(useRouterMock.push).not.toHaveBeenCalled();
    });

    it('Open (active): submits `{ username }` ONLY (never a sender key — AC-4/AC-8), receives a one-time handoff code, and hands off to the trusted /login/complete redemption page — this component never redeems it inline, stores no tokens, and never renders/logs the code or the registration grant', async () => {
      await renderLoaded();
      apiPost.mockResolvedValue(jsonResponse(200, { status: 'active', code: 'one-time-handoff-code' }));

      // AC-8: log/persistent-storage non-exposure — spy on every console
      // method AND both Storage.prototype.setItem (localStorage AND
      // sessionStorage — a call-level spy, not just an after-the-fact
      // getItem check, so ANY write attempt is caught even if the key name
      // is unexpected) so a stray debug log or a direct-write bypass would
      // fail this test, not just the "not rendered" check below.
      const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
      const localStorageSetSpy = vi.spyOn(Storage.prototype, 'setItem');
      window.localStorage.clear();
      window.sessionStorage.clear();

      fireEvent.change(screen.getByLabelText('ユーザーID'), { target: { value: 'brand-new-user' } });
      fireEvent.click(screen.getByRole('button', { name: '新規登録' }));

      await waitFor(() =>
        expect(apiPost).toHaveBeenCalledWith({
          param: { token: 'grant-abc' },
          json: { username: 'brand-new-user' },
        }),
      );
      await waitFor(() => expect(useRouterMock.push).toHaveBeenCalledWith('/login/complete?code=one-time-handoff-code'));

      // Token non-exposure (AC-8): neither the one-time code nor the
      // registration grant token is ever rendered into the DOM.
      expect(screen.queryByText('one-time-handoff-code')).not.toBeInTheDocument();
      expect(screen.queryByText('grant-abc')).not.toBeInTheDocument();
      expect(document.body.innerHTML).not.toContain('one-time-handoff-code');
      expect(document.body.innerHTML).not.toContain('grant-abc');

      // Never logged, whether the secret is the one-time handoff code or
      // the registration grant itself.
      const secrets = ['one-time-handoff-code', 'grant-abc'];
      for (const spy of consoleSpies) {
        for (const call of spy.mock.calls) {
          const serialized = call.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ');
          for (const secret of secrets) expect(serialized).not.toContain(secret);
        }
        spy.mockRestore();
      }

      // Never WRITTEN to either Storage (localStorage or sessionStorage —
      // `Storage.prototype.setItem` is shared by both) with either secret
      // as the value — this component holds no fallback direct-write path
      // for tokens (it never even sees any) or for the grant token.
      for (const call of localStorageSetSpy.mock.calls) {
        const [, value] = call;
        for (const secret of secrets) expect(value).not.toContain(secret);
      }
      localStorageSetSpy.mockRestore();
      expect(window.localStorage.getItem('accessToken')).toBeNull();
      expect(window.localStorage.getItem('refreshToken')).toBeNull();
      expect(window.sessionStorage.length).toBe(0);
    });
  });
});
