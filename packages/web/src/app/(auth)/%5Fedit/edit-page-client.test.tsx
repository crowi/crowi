import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode } from 'react';
import { render, cleanup, screen, waitFor } from '@testing-library/react';

/**
 * RFC-0005 Phase 3 — the `_edit?path=X` create flow (`CreatePageEditor`).
 *
 * `CreatePageEditor` mounts a draft via `POST /pages/drafts` and then
 * `router.replace`s to `_edit?page_id=<pageId>`. These tests exercise
 * the four branches (201 / 409-own / 409-other / 400) by driving
 * `EditPageClient` with a `?path=` search param.
 *
 * The heavy editor + collab modules pulled in by the *update* branch
 * are mocked to keep this an isolated jsdom unit test — the create
 * branch never renders them, but they are imported at module scope.
 */

// --- next/navigation -------------------------------------------------
const { replace, back, searchParamsGet } = vi.hoisted(() => ({
  replace: vi.fn(),
  back: vi.fn(),
  searchParamsGet: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, back, push: vi.fn() }),
  useSearchParams: () => ({ get: searchParamsGet }),
}));

// --- drafts hooks ----------------------------------------------------
const { createDraftMutateAsync, draftsData } = vi.hoisted(() => ({
  createDraftMutateAsync: vi.fn(),
  draftsData: { value: { drafts: [] as { pageId: string; path: string }[] } },
}));
vi.mock('@/lib/use-drafts', async () => {
  const actual = await vi.importActual<typeof import('@/lib/use-drafts')>('@/lib/use-drafts');
  return {
    ...actual,
    useCreateDraft: () => ({ mutateAsync: createDraftMutateAsync, isPending: false }),
    useDrafts: () => ({ data: draftsData.value }),
  };
});

// --- auth ------------------------------------------------------------
const { authUser } = vi.hoisted(() => ({ authUser: { value: { id: 'me' } as { id: string } | null } }));
vi.mock('@/lib/use-auth', () => ({
  useAuth: () => ({ user: authUser.value }),
}));

// --- heavy editor / collab deps (only the update branch needs them) --
vi.mock('@/components/editor/CollaborativeMarkdownEditor', () => ({
  CollaborativeMarkdownEditor: () => null,
  useCollabSession: () => ({ status: 'connecting', yText: null, awareness: null }),
}));
vi.mock('@/components/editor/MarkdownEditor', () => ({ MarkdownEditor: () => null }));
vi.mock('@/components/editor/MarkdownPreview', () => ({ MarkdownPreview: () => null }));
vi.mock('@/lib/use-page', () => ({ usePage: () => ({ page: null, isLoading: true, isError: false }) }));
vi.mock('@/lib/use-presence', () => ({ usePresence: () => undefined }));
// `usePageTitle` pulls in `useAppInfo` (`useQuery`); mock to a no-op so the
// test doesn't need a `QueryClientProvider`. Document-title behaviour is
// covered separately and not in scope for the create-flow tests here.
vi.mock('@/lib/use-page-title', () => ({ usePageTitle: vi.fn() }));
// `UpdatePageEditor` mounts these unconditionally; the real hooks call
// `useQueryClient()` and would throw without a `QueryClientProvider`.
vi.mock('@/lib/use-page-mutations', () => ({
  useUpdatePage: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSetPageGrant: () => ({ mutateAsync: vi.fn(), isPending: false }),
  PageRevisionConflictError: class extends Error {},
}));
// `UpdatePageEditor` calls `useQueryClient()` directly (post-save cache
// invalidation); stub it so the draft-editor branch doesn't need a real
// `QueryClientProvider`.
vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
  return { ...actual, useQueryClient: () => ({ invalidateQueries: vi.fn() }) };
});

import { DraftPathConflictError } from '@/lib/use-drafts';
import { m } from '@paraglide/messages.js';
import { EditPageClient } from './edit-page-client';

beforeEach(() => {
  replace.mockReset();
  back.mockReset();
  searchParamsGet.mockReset();
  createDraftMutateAsync.mockReset();
  draftsData.value = { drafts: [] };
  authUser.value = { id: 'me' };
  // Default: `?path=/new/page`, no `page_id`.
  searchParamsGet.mockImplementation((key: string) => (key === 'path' ? '/new/page' : null));
});

afterEach(() => {
  cleanup();
});

/** Drives `createDraft.mutateAsync(input)` → resolved / rejected. */
function mutateResolvesWith(pageId: string) {
  createDraftMutateAsync.mockResolvedValue({ pageId });
}
function mutateRejectsWith(err: unknown) {
  createDraftMutateAsync.mockRejectedValue(err);
}

describe('CreatePageEditor (_edit?path=)', () => {
  it('201: creates a draft and replaces the URL with the page-id editor route', async () => {
    mutateResolvesWith('draft-1');
    render(<EditPageClient />);

    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
    // The create flow seeds a path-derived H1 (editor-QoL): `/new/page`
    // has a non-date leaf, so the title is the leaf `page`.
    expect(createDraftMutateAsync).toHaveBeenCalledWith({ path: '/new/page', initialBody: '# page\n\n' });
    expect(replace).toHaveBeenCalledWith('/_edit?page_id=draft-1');
  });

  it('201: switches to the draft editor without depending on the URL re-render', async () => {
    // Regression: `CreatePageEditor` used to render `UpdatePageEditor`
    // only when `useSearchParams()` re-resolved to `?page_id=` after
    // the `router.replace`. A query-only navigation does not reliably
    // re-render `EditPageClient`, so the "preparing the editor" spinner
    // hung forever. The mode switch must now be driven by local state.
    // `useSearchParams` stays on `?path=` (the default mock) — the
    // editor must still appear.
    mutateResolvesWith('draft-1');
    render(<EditPageClient />);

    // `UpdatePageEditor` mounts → `usePage` (mocked `isLoading: true`)
    // → the page-loading spinner. The "preparing the editor" message
    // must be gone even though the search param never changed.
    await waitFor(() => expect(screen.queryByText(m['edit.loading_page']())).not.toBeNull());
    expect(screen.queryByText(m['edit.creating_draft']())).toBeNull();
  });

  it('409 own draft: looks the page id up from the drafts list and replaces to it', async () => {
    draftsData.value = { drafts: [{ pageId: 'existing-draft', path: '/new/page' }] };
    mutateRejectsWith(new DraftPathConflictError('taken', { id: 'me', username: 'me', displayName: 'Me' }));
    render(<EditPageClient />);

    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
    expect(replace).toHaveBeenCalledWith('/_edit?page_id=existing-draft');
  });

  it('409 own draft but not in the list: surfaces a recoverable error instead of replacing', async () => {
    draftsData.value = { drafts: [] };
    mutateRejectsWith(new DraftPathConflictError('taken', { id: 'me', username: 'me', displayName: 'Me' }));
    render(<EditPageClient />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect(replace).not.toHaveBeenCalled();
  });

  it("409 other user's draft: shows the contact-the-owner conflict message inline", async () => {
    mutateRejectsWith(new DraftPathConflictError('taken', { id: 'someone', username: 'alice', displayName: 'Alice' }));
    render(<EditPageClient />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect(replace).not.toHaveBeenCalled();
    // The conflict message interpolates the owner's display name + handle.
    expect(screen.getByRole('alert').textContent).toContain('Alice');
    expect(screen.getByRole('alert').textContent).toContain('alice');
  });

  it('400: shows the server error message inline', async () => {
    mutateRejectsWith(new Error('A published page already exists at this path'));
    render(<EditPageClient />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('A published page already exists at this path');
  });

  it('POSTs one draft and still navigates under StrictMode double-invoked effects', async () => {
    mutateResolvesWith('draft-1');
    render(
      <StrictMode>
        <EditPageClient />
      </StrictMode>,
    );

    // StrictMode mounts → unmounts → remounts the effect. The
    // `draftPromiseRef` guard keeps the POST to exactly one, and the
    // remounted instance re-attaches to the same promise so the result
    // still drives navigation (regression: the result used to be
    // orphaned on the destroyed first-mount observer).
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/_edit?page_id=draft-1'));
    expect(createDraftMutateAsync).toHaveBeenCalledTimes(1);
  });
});
