import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type PropsWithChildren } from 'react';
import { nextNavigationMockModule } from '@/lib/test-utils/mocks';

/**
 * feature-restricted-grant-share-banner Phase 1 — `IdRedirector` now
 * resolves id URLs through `useClaimPageLinkAccess` (POST
 * /pages/link-access, grant-on-first-access) instead of the plain
 * read-only `usePage({ page_id })`. These tests pin the same
 * loading/notGranted/notFound/redirect branches the old `usePage`-backed
 * component had, plus the new 429 → isError → ErrorAlert path.
 */

const { push, replace, back } = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }));
vi.mock('next/navigation', () => nextNavigationMockModule({ push, replace, back }));

const { claimLinkAccess } = vi.hoisted(() => ({ claimLinkAccess: vi.fn() }));
vi.mock('@/lib/api-client', () => ({
  apiClient: { pages: { 'link-access': { $post: claimLinkAccess } } },
}));

import { IdRedirector } from './id-redirector';

function renderWithClient(pageId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  return render(<IdRedirector pageId={pageId} />, { wrapper });
}

beforeEach(() => {
  claimLinkAccess.mockReset();
  push.mockReset();
  replace.mockReset();
  back.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('IdRedirector — resolves via useClaimPageLinkAccess', () => {
  it('renders a loading spinner while the claim is in flight', async () => {
    claimLinkAccess.mockReturnValue(new Promise(() => {}));

    renderWithClient('p1');

    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('replaces to the canonical path once the claim resolves', async () => {
    claimLinkAccess.mockResolvedValue({
      status: 200,
      json: async () => ({ page: { _id: 'p1', path: '/shared/example', grant: 2 }, granted: true }),
    });

    renderWithClient('p1');

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/shared/example'));
  });

  it('renders AccessDeniedCard when the claim resolves as not granted (403)', async () => {
    claimLinkAccess.mockResolvedValue({ status: 403, json: async () => ({}) });

    renderWithClient('p1');

    // baseLocale (ja) message text — see messages/ja.json "common.access_denied_title".
    await waitFor(() => expect(screen.getByText('アクセスが拒否されました')).toBeInTheDocument());
  });

  it('renders NotFoundCard when the claim resolves as not found (404)', async () => {
    claimLinkAccess.mockResolvedValue({ status: 404, json: async () => ({}) });

    renderWithClient('p1');

    // baseLocale (ja) message text — see messages/ja.json "page.not_found_title".
    await waitFor(() => expect(screen.getByText('ページが見つかりません')).toBeInTheDocument());
  });

  it('renders ErrorAlert when the claim is rate limited (429)', async () => {
    claimLinkAccess.mockResolvedValue({
      status: 429,
      json: async () => ({ error: 'rate_limited', message: 'slow down', retryAfterSeconds: 30 }),
    });

    renderWithClient('p1');

    // baseLocale (ja) message text — see messages/ja.json "page.id_redirector_failed".
    await waitFor(() => expect(screen.getByText(/ページの検索に失敗しました/)).toBeInTheDocument());
  });
});
