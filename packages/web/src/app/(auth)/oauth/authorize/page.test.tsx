import { createElement, StrictMode, type PropsWithChildren } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApiResponse, nextNavigationMockModule } from '@/lib/test-utils/mocks';

/**
 * RFC-0016 §4.4/§14 — the authorize page reads `GET /oauth/client-info`
 * before deciding whether to render `ConsentCard` or auto-approve. These
 * tests pin AC4: a `trusted` client (`crowi-ios`) never renders
 * `ConsentCard` — not even on an auto-approve failure — and reaches the
 * redirect automatically, while a non-trusted client (`crowi-cli`) is
 * completely unchanged.
 */
const { searchParamsGet, clientInfoGet, authorizePost, denyPost } = vi.hoisted(() => ({
  searchParamsGet: vi.fn(),
  clientInfoGet: vi.fn(),
  authorizePost: vi.fn(),
  denyPost: vi.fn(),
}));

vi.mock('next/navigation', () => nextNavigationMockModule({ push: vi.fn(), searchParamsGet }));
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    oauth: {
      'client-info': { $get: clientInfoGet },
      authorize: { $post: authorizePost, deny: { $post: denyPost } },
    },
  },
}));

import OAuthAuthorizePage from './page';

const BASE_PARAMS: Record<string, string> = {
  redirect_uri: 'http://127.0.0.1:51234/callback',
  scope: 'pages:read',
  code_challenge: 'challenge-value',
  code_challenge_method: 'S256',
};

const setParams = (overrides: Record<string, string>) => {
  const params = { ...BASE_PARAMS, ...overrides };
  searchParamsGet.mockImplementation((key: string) => params[key] ?? null);
};

const renderPage = (wrapper: 'plain' | 'strict' = 'plain') => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: PropsWithChildren) =>
    wrapper === 'strict'
      ? createElement(StrictMode, null, createElement(QueryClientProvider, { client }, children))
      : createElement(QueryClientProvider, { client }, children);
  return render(<OAuthAuthorizePage />, { wrapper: Wrapper });
};

const approveButton = () => screen.queryByRole('button', { name: '許可する' });
const retryButton = () => screen.queryByRole('button', { name: '再試行' });

/**
 * `window.location.href = ...` is how the authorize page navigates on
 * success/denial (it must support non-http(s) custom schemes like
 * `crowi-ios://callback`, which `next/navigation`'s router can't). jsdom
 * does not implement real navigation — assigning `href` is a silent no-op
 * (a suppressed "Not implemented: navigation" jsdomError, see
 * vitest.setup.ts) and the property never reflects the new value — so
 * assertions on the redirect target replace `window.location` with a
 * minimal object that records every assignment instead.
 */
const originalLocation = window.location;
let hrefAssignments: string[];

beforeEach(() => {
  searchParamsGet.mockReset();
  clientInfoGet.mockReset();
  authorizePost.mockReset();
  denyPost.mockReset();
  hrefAssignments = [];
  // @ts-expect-error jsdom's window.location can be deleted/replaced for tests.
  delete window.location;
  // @ts-expect-error partial Location mock — only `href` is exercised by this page.
  window.location = {
    ...originalLocation,
    get href() {
      return originalLocation.href;
    },
    set href(value: string) {
      hrefAssignments.push(value);
    },
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // @ts-expect-error restore the real Location.
  window.location = originalLocation;
});

describe('OAuth authorize page — trusted client skip-consent', () => {
  it('auto-approves a trusted client (crowi-ios) without ever rendering ConsentCard, and navigates to the returned redirect', async () => {
    setParams({ client_id: 'crowi-ios', redirect_uri: 'crowi-ios://callback' });
    clientInfoGet.mockResolvedValue(makeApiResponse(200, { clientId: 'crowi-ios', name: 'Crowi for iOS', firstParty: true, trusted: true }));
    authorizePost.mockResolvedValue(makeApiResponse(200, { redirectUri: 'crowi-ios://callback?code=abc123' }));

    renderPage();

    // Never renders ConsentCard, not even while the client-info lookup is
    // still pending.
    expect(approveButton()).not.toBeInTheDocument();

    await waitFor(() => expect(authorizePost).toHaveBeenCalledTimes(1));
    expect(authorizePost).toHaveBeenCalledWith({
      json: {
        client_id: 'crowi-ios',
        redirect_uri: 'crowi-ios://callback',
        scope: 'pages:read',
        code_challenge: 'challenge-value',
        code_challenge_method: 'S256',
      },
    });
    expect(approveButton()).not.toBeInTheDocument();

    // AC4: reaches the code-bearing redirect automatically.
    await waitFor(() => expect(hrefAssignments).toEqual(['crowi-ios://callback?code=abc123']));
  });

  it('auto-approves exactly once under React StrictMode double-invoked effects', async () => {
    setParams({ client_id: 'crowi-ios', redirect_uri: 'crowi-ios://callback' });
    clientInfoGet.mockResolvedValue(makeApiResponse(200, { clientId: 'crowi-ios', name: 'Crowi for iOS', firstParty: true, trusted: true }));
    authorizePost.mockResolvedValue(makeApiResponse(200, { redirectUri: 'crowi-ios://callback?code=abc123' }));

    renderPage('strict');

    // Regression: a `useState`-based once-only guard still reads its
    // pre-update value on StrictMode's synchronous second effect
    // invocation and fires a second `POST /oauth/authorize`. The `useRef`
    // guard must keep this to exactly one call.
    await waitFor(() => expect(hrefAssignments).toEqual(['crowi-ios://callback?code=abc123']));
    expect(authorizePost).toHaveBeenCalledTimes(1);
  });

  it('shows a retry alert (never ConsentCard) when the trusted client auto-approve POST fails, and retrying succeeds', async () => {
    setParams({ client_id: 'crowi-ios', redirect_uri: 'crowi-ios://callback' });
    clientInfoGet.mockResolvedValue(makeApiResponse(200, { clientId: 'crowi-ios', name: 'Crowi for iOS', firstParty: true, trusted: true }));
    authorizePost.mockResolvedValueOnce(makeApiResponse(500, {}));

    renderPage();

    // Auto-approve fires and fails; ConsentCard must never appear, even now.
    await waitFor(() => expect(authorizePost).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(retryButton()).toBeInTheDocument());
    expect(approveButton()).not.toBeInTheDocument();

    authorizePost.mockResolvedValueOnce(makeApiResponse(200, { redirectUri: 'crowi-ios://callback?code=abc123' }));
    fireEvent.click(retryButton() as HTMLElement);

    await waitFor(() => expect(hrefAssignments).toEqual(['crowi-ios://callback?code=abc123']));
    expect(authorizePost).toHaveBeenCalledTimes(2);
    expect(approveButton()).not.toBeInTheDocument();
  });

  it('renders ConsentCard unchanged for a non-trusted client (crowi-cli)', async () => {
    setParams({ client_id: 'crowi-cli' });
    clientInfoGet.mockResolvedValue(makeApiResponse(200, { clientId: 'crowi-cli', name: 'Crowi CLI', firstParty: true, trusted: false }));

    renderPage();

    await waitFor(() => expect(approveButton()).toBeInTheDocument());
    expect(authorizePost).not.toHaveBeenCalled();
  });

  it('falls back to ConsentCard when the client-info lookup 404s (unknown client)', async () => {
    setParams({ client_id: 'no-such-client' });
    clientInfoGet.mockResolvedValue(makeApiResponse(404, {}));

    renderPage();

    await waitFor(() => expect(approveButton()).toBeInTheDocument());
    expect(authorizePost).not.toHaveBeenCalled();
  });
});

describe('OAuth authorize page — deny', () => {
  const cancelButton = () => screen.getByRole('button', { name: 'キャンセル' });
  const INVALID = 'この認可リクエストは無効、または情報が不足しています。';
  const FAILED = '許可に失敗しました。もう一度お試しください。';

  const renderConsent = async (overrides: Record<string, string> = {}) => {
    setParams({ client_id: 'crowi-cli', ...overrides });
    clientInfoGet.mockResolvedValue(makeApiResponse(200, { clientId: 'crowi-cli', name: 'Crowi CLI', firstParty: true, trusted: false }));
    renderPage();
    await waitFor(() => expect(approveButton()).toBeInTheDocument());
  };

  it('never navigates to an unregistered redirect_uri when the server rejects the denial (400)', async () => {
    await renderConsent({ redirect_uri: 'https://evil.example/cb' });
    denyPost.mockResolvedValue(makeApiResponse(400, { error: 'invalid_request' }));

    fireEvent.click(cancelButton());

    expect(await screen.findByText(INVALID)).toBeInTheDocument();
    expect(hrefAssignments).toEqual([]);
  });

  it('navigates only to the server-built redirectUri on 200 and sends client_id / redirect_uri / state', async () => {
    await renderConsent({ state: 's1' });
    denyPost.mockResolvedValue(makeApiResponse(200, { redirectUri: 'http://127.0.0.1:51234/callback?error=access_denied&state=s1' }));

    fireEvent.click(cancelButton());

    await waitFor(() => expect(hrefAssignments).toEqual(['http://127.0.0.1:51234/callback?error=access_denied&state=s1']));
    expect(denyPost).toHaveBeenCalledWith({
      json: { client_id: 'crowi-cli', redirect_uri: 'http://127.0.0.1:51234/callback', state: 's1' },
    });
  });

  it('shows error_failed and does not navigate on a 500', async () => {
    await renderConsent();
    denyPost.mockResolvedValue(makeApiResponse(500, {}));

    fireEvent.click(cancelButton());

    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    expect(hrefAssignments).toEqual([]);
  });

  it('shows error_failed and does not navigate when the request throws', async () => {
    await renderConsent();
    denyPost.mockRejectedValue(new Error('network'));

    fireEvent.click(cancelButton());

    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    expect(hrefAssignments).toEqual([]);
  });
});
