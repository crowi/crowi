import { m } from '@paraglide/messages.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The restore control shown above a past version (page view and portal alike).
 * It is driven through the real `useRevertToRevision`, with only the API
 * client, the router and the notifier faked, so what is asserted is what the
 * reader sees: for an artifact page, a successful restore notifies and goes to
 * the current URL, and a server-side ingest rejection shows the error without a
 * success notice or navigation.
 */
const { revertToRevision, push, notifyInfo, notifyError } = vi.hoisted(() => ({
  revertToRevision: vi.fn(),
  push: vi.fn(),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));
vi.mock('@/lib/api-client', () => ({ apiClient: { pages: { 'revert-to-revision': { $post: revertToRevision } } } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => createElement('a', { href }, children) }));
vi.mock('@/lib/notify', () => ({ notify: { info: notifyInfo, error: notifyError, warn: vi.fn() } }));

import { StaleRevisionBanner } from './stale-revision-banner';

const rejection = {
  error: {
    code: 'ARTIFACT_WRITE_REJECTED',
    reason: 'EXTERNAL_REFERENCE',
    ruleId: 'AI-R11',
    message: 'fixed ingest rejection message',
  },
};

function renderBanner() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  return render(createElement(StaleRevisionBanner, { pagePath: '/team/artifact-page', pageId: 'page-1', revisionId: 'rev-old' }), { wrapper });
}

const restoreButton = () => screen.getByRole('button', { name: m['page.revert_to_this_version']() });

beforeEach(() => {
  revertToRevision.mockReset();
  push.mockReset();
  notifyInfo.mockReset();
  notifyError.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('StaleRevisionBanner — restoring an artifact version (AC-04)', () => {
  it('sends the restore for the viewed revision, then notifies and goes to the current URL', async () => {
    revertToRevision.mockResolvedValue({ ok: true, json: async () => ({ page: { _id: 'page-1', path: '/team/artifact-page' } }) });
    renderBanner();

    await act(async () => {
      fireEvent.click(restoreButton());
    });

    await waitFor(() => expect(push).toHaveBeenCalledWith('/team/artifact-page'));
    expect(revertToRevision).toHaveBeenCalledWith({ json: { page_id: 'page-1', revision_id: 'rev-old' } });
    expect(notifyInfo).toHaveBeenCalledWith(m['page.revert_success']());
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('on an ingest rejection, shows the error notice only: no success notice and no navigation', async () => {
    revertToRevision.mockResolvedValue({ ok: false, status: 400, json: async () => rejection });
    renderBanner();

    await act(async () => {
      fireEvent.click(restoreButton());
    });

    await waitFor(() => expect(notifyError).toHaveBeenCalledTimes(1));
    expect(notifyError.mock.calls[0][0]).toContain('fixed ingest rejection message');
    expect(notifyInfo).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('links back to the latest version', () => {
    renderBanner();
    expect(screen.getByRole('link', { name: m['page.stale_revision_show_latest']() }).getAttribute('href')).toBe('/team/artifact-page');
  });
});
