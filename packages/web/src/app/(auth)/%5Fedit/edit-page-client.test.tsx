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
const { createDraftMutate, draftsData } = vi.hoisted(() => ({
  createDraftMutate: vi.fn(),
  draftsData: { value: { drafts: [] as { pageId: string; path: string }[] } },
}));
vi.mock('@/lib/use-drafts', async () => {
  const actual = await vi.importActual<typeof import('@/lib/use-drafts')>('@/lib/use-drafts');
  return {
    ...actual,
    useCreateDraft: () => ({ mutate: createDraftMutate, isPending: false }),
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

import { DraftPathConflictError } from '@/lib/use-drafts';
import { EditPageClient } from './edit-page-client';

beforeEach(() => {
  replace.mockReset();
  back.mockReset();
  searchParamsGet.mockReset();
  createDraftMutate.mockReset();
  draftsData.value = { drafts: [] };
  authUser.value = { id: 'me' };
  // Default: `?path=/new/page`, no `page_id`.
  searchParamsGet.mockImplementation((key: string) => (key === 'path' ? '/new/page' : null));
});

afterEach(() => {
  cleanup();
});

/** Drives `createDraft.mutate(input, { onSuccess, onError })`. */
function mutateResolvesWith(pageId: string) {
  createDraftMutate.mockImplementation((_input, opts) => {
    opts.onSuccess({ pageId });
  });
}
function mutateRejectsWith(err: unknown) {
  createDraftMutate.mockImplementation((_input, opts) => {
    opts.onError(err);
  });
}

describe('CreatePageEditor (_edit?path=)', () => {
  it('201: creates a draft and replaces the URL with the page-id editor route', async () => {
    mutateResolvesWith('draft-1');
    render(<EditPageClient />);

    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
    expect(createDraftMutate).toHaveBeenCalledWith({ path: '/new/page' }, expect.anything());
    expect(replace).toHaveBeenCalledWith('/_edit?page_id=draft-1');
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

  it('does not POST a second draft under StrictMode double-invoked effects', async () => {
    mutateResolvesWith('draft-1');
    render(
      <StrictMode>
        <EditPageClient />
      </StrictMode>,
    );

    await waitFor(() => expect(replace).toHaveBeenCalled());
    // StrictMode mounts → unmounts → remounts the effect; the
    // `startedRef` guard keeps the POST to exactly one.
    expect(createDraftMutate).toHaveBeenCalledTimes(1);
  });
});
