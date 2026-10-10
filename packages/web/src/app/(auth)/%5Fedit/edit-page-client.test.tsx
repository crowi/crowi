import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('@/components/editor/collaborative-markdown-editor', () => ({
  CollaborativeMarkdownEditor: () => null,
  useCollabSession: () => ({
    status: 'connecting',
    yText: null,
    yUndoManager: null,
    awareness: null,
    synced: false,
    hasEverSynced: false,
    authRecoveryExhausted: false,
    subscribeStateless: () => () => undefined,
    sendStateless: () => undefined,
    doc: null,
  }),
}));
vi.mock('@/components/editor/markdown-editor', () => ({ MarkdownEditor: () => null }));
vi.mock('@/components/editor/markdown-preview', () => ({ MarkdownPreview: () => null }));
// `usePage` is driven per test through `pageResults` (keyed by the `page_id` / `path` it is asked for).
const { usePage, pageResults, presenceMounts, presenceUnmounts } = vi.hoisted(() => {
  type PageResult = { page: unknown; isLoading: boolean; isError: boolean; error: Error | null; notFound: boolean; notGranted: boolean };
  const loading: PageResult = { page: null, isLoading: true, isError: false, error: null, notFound: false, notGranted: false };
  const pageResults = { byId: new Map<string, PageResult>(), byPath: new Map<string, PageResult>(), loading };
  return {
    pageResults,
    presenceMounts: { value: 0 },
    presenceUnmounts: { value: 0 },
    usePage: vi.fn((params: { page_id?: string; path?: string }) => {
      if (params.page_id) return pageResults.byId.get(params.page_id) ?? loading;
      if (params.path) return pageResults.byPath.get(params.path) ?? loading;
      return loading;
    }),
  };
});
vi.mock('@/lib/use-page', () => ({ usePage }));
// Mounted only by `MarkdownPageEditor`: counting it proves whether the editing stack started at all.
vi.mock('@/lib/use-presence', async () => {
  const { useEffect } = await import('react');
  return {
    usePresence: () => {
      useEffect(() => {
        presenceMounts.value += 1;
        return () => {
          presenceUnmounts.value += 1;
        };
      }, []);
      return undefined;
    },
  };
});
// `usePageTitle` pulls in `useAppInfo` (`useQuery`); mock to a no-op so the
// test doesn't need a `QueryClientProvider`. Document-title behaviour is
// covered separately and not in scope for the create-flow tests here.
vi.mock('@/lib/use-page-title', () => ({ usePageTitle: vi.fn() }));
vi.mock('@/lib/use-app-info', () => ({ useLinkCardEnabled: () => false }));
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

import { m } from '@paraglide/messages.js';
import { DraftPathConflictError } from '@/lib/use-drafts';
import { EditPageClient } from './edit-page-client';

beforeEach(() => {
  usePage.mockClear();
  pageResults.byId.clear();
  pageResults.byPath.clear();
  presenceMounts.value = 0;
  presenceUnmounts.value = 0;
  replace.mockReset();
  back.mockReset();
  searchParamsGet.mockReset();
  createDraftMutateAsync.mockReset();
  draftsData.value = { drafts: [] };
  authUser.value = { id: 'me' };
  // Default: `?path=/new/page`, no `page_id`, and that path is free (an explicit 404).
  searchParamsGet.mockImplementation((key: string) => (key === 'path' ? '/new/page' : null));
  pageResults.byPath.set('/new/page', { page: null, isLoading: false, isError: false, error: null, notFound: true, notGranted: false });
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

/**
 * artifact-edit-guard (R-4) — the route decides from the fetched page before
 * it mounts anything of the editing stack. `usePresence` is mounted only by
 * the Markdown editor child, so `presenceMounts` is the "did the editor
 * start" probe (the collab session, recovery buffer, session-reauth provider
 * and save mutation live in the same subtree).
 */
describe('EditPageClient — artifact guard (artifact-edit-guard)', () => {
  const found = (overrides: Record<string, unknown>) => ({
    page: {
      _id: 'page-1',
      path: '/team/some page',
      grant: 1,
      revision: { _id: 'rev-1', path: '/team/some page', body: '# body', contentType: 'markdown' },
      ...overrides,
    },
    isLoading: false,
    isError: false,
    error: null,
    notFound: false,
    notGranted: false,
  });
  const artifactPage = () => found({ revision: { _id: 'rev-a', path: '/team/some page', body: '<html></html>', contentType: 'artifact' } });
  const blockedTitle = () => m['edit.artifact_blocked_title']();
  const blockedBody = () => m['edit.artifact_blocked_body']();

  // The Markdown editor's children use react-query mutations (attachments), so they need a real provider.
  const renderEdit = () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    return render(<EditPageClient />, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
  };

  const queryIs = (params: Record<string, string>) => searchParamsGet.mockImplementation((key: string) => params[key] ?? null);

  it('?page_id= of an artifact page: shows the notice with a way back derived from the fetched path, and starts nothing', () => {
    queryIs({ page_id: 'page-1' });
    pageResults.byId.set('page-1', artifactPage());
    renderEdit();

    expect(screen.getByText(blockedTitle())).toBeTruthy();
    expect(screen.getByText(blockedBody())).toBeTruthy();
    const back = screen.getByRole('link', { name: m['edit.back_to_page']() });
    expect(back.getAttribute('href')).toBe('/team/some+page');
    expect(presenceMounts.value).toBe(0);
    expect(createDraftMutateAsync).not.toHaveBeenCalled();
  });

  it('the notice carries the exact product wording', () => {
    expect(m['edit.artifact_blocked_body']({}, { locale: 'ja' })).toBe(
      'この編集画面では artifact を編集できません。本文の編集には CLI または MCP を使用してください。',
    );
    expect(m['edit.back_to_page']({}, { locale: 'ja' })).toBe('ページに戻る');
    expect(m['edit.artifact_blocked_body']({}, { locale: 'en' })).toBe('This editor cannot edit artifact pages. Use the CLI or MCP to edit the body.');
  });

  it('?path= of an existing artifact page: shows the same notice, never creates a draft, never starts the editor', () => {
    queryIs({ path: '/team/some page' });
    pageResults.byPath.set('/team/some page', artifactPage());
    renderEdit();

    expect(screen.getByText(blockedBody())).toBeTruthy();
    expect(screen.getByRole('link', { name: m['edit.back_to_page']() }).getAttribute('href')).toBe('/team/some+page');
    expect(createDraftMutateAsync).not.toHaveBeenCalled();
    expect(presenceMounts.value).toBe(0);
  });

  it.each([
    ['loading', { page: null, isLoading: true, isError: false, error: null, notFound: false, notGranted: false }],
    ['a 401 / network failure', { page: null, isLoading: false, isError: true, error: new Error('Failed to fetch page'), notFound: false, notGranted: false }],
    ['a 403', { page: null, isLoading: false, isError: false, error: null, notFound: false, notGranted: true }],
    ['a 404', { page: null, isLoading: false, isError: false, error: null, notFound: true, notGranted: false }],
  ])('?page_id= while %s: no editor, no presence, no draft POST', (_label, result) => {
    queryIs({ page_id: 'page-1' });
    pageResults.byId.set('page-1', result);
    renderEdit();

    expect(presenceMounts.value).toBe(0);
    expect(createDraftMutateAsync).not.toHaveBeenCalled();
    expect(screen.queryByText(blockedBody())).toBeNull();
  });

  it.each([
    ['loading', { page: null, isLoading: true, isError: false, error: null, notFound: false, notGranted: false }],
    ['a failure', { page: null, isLoading: false, isError: true, error: new Error('Failed to fetch page'), notFound: false, notGranted: false }],
    ['a 403', { page: null, isLoading: false, isError: false, error: null, notFound: false, notGranted: true }],
  ])('?path= while %s: waits or errors without POSTing a draft or starting the editor', (_label, result) => {
    queryIs({ path: '/team/some page' });
    pageResults.byPath.set('/team/some page', result);
    renderEdit();

    expect(createDraftMutateAsync).not.toHaveBeenCalled();
    expect(presenceMounts.value).toBe(0);
  });

  it('?path= that is free (explicit 404) still creates a draft, and a later page refetch does not swap the draft flow out', async () => {
    queryIs({ path: '/team/free' });
    pageResults.byPath.set('/team/free', { page: null, isLoading: false, isError: false, error: null, notFound: true, notGranted: false });
    mutateResolvesWith('draft-9');
    const view = renderEdit();

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/_edit?page_id=draft-9'));
    expect(createDraftMutateAsync).toHaveBeenCalledTimes(1);

    // The draft POST invalidates page queries; the path now resolves to the new draft. No remount, no second POST.
    pageResults.byPath.set('/team/free', found({ _id: 'draft-9', path: '/team/free' }));
    view.rerender(<EditPageClient />);
    expect(createDraftMutateAsync).toHaveBeenCalledTimes(1);
  });

  it('?path= of an existing Markdown page opens its editor instead of creating a draft', () => {
    queryIs({ path: '/team/some page' });
    pageResults.byPath.set('/team/some page', found({}));
    pageResults.byId.set('page-1', found({}));
    renderEdit();

    expect(createDraftMutateAsync).not.toHaveBeenCalled();
    expect(usePage).toHaveBeenCalledWith({ page_id: 'page-1' });
  });

  it('switching the query from a Markdown page to an artifact page discards the editor session', () => {
    queryIs({ page_id: 'page-1' });
    pageResults.byId.set('page-1', found({}));
    pageResults.byId.set('page-2', found({ _id: 'page-2', revision: { _id: 'rev-a', path: '/x', body: '<html></html>', contentType: 'artifact' } }));
    const view = renderEdit();
    expect(presenceMounts.value).toBe(1);
    expect(presenceUnmounts.value).toBe(0);

    queryIs({ page_id: 'page-2' });
    view.rerender(<EditPageClient />);
    expect(presenceUnmounts.value).toBe(1);
    expect(screen.getByText(blockedBody())).toBeTruthy();
  });

  it('switching between two Markdown pages remounts the editor (no state carried across ids)', () => {
    queryIs({ page_id: 'page-1' });
    pageResults.byId.set('page-1', found({}));
    pageResults.byId.set('page-2', found({ _id: 'page-2' }));
    const view = renderEdit();
    expect(presenceMounts.value).toBe(1);

    queryIs({ page_id: 'page-2' });
    view.rerender(<EditPageClient />);
    expect(presenceUnmounts.value).toBe(1);
    expect(presenceMounts.value).toBe(2);
  });
});
