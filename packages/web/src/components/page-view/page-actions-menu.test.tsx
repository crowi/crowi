import type { PageWithRevision } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPageShareUrl } from '@/lib/build-page-share-url';

const { useToggleBookmark } = vi.hoisted(() => ({ useToggleBookmark: vi.fn() }));
const { useToggleWatch } = vi.hoisted(() => ({ useToggleWatch: vi.fn() }));
// M-6 (foldSocial's LikeMenuItem, exercised by the artifact-page "keeps
// Like" case below) — mocked like `portal-header.test.tsx` does, since
// `useToggleLike` calls `useQueryClient()` and this file has no real
// `QueryClientProvider`.
const { useToggleLike } = vi.hoisted(() => ({ useToggleLike: vi.fn() }));
const { useDeletePage } = vi.hoisted(() => ({ useDeletePage: vi.fn() }));
// `ShareDialog` → `SharePanelContent` calls `useAppInfo()` (a `useQuery`);
// mock it like `page-header.test.tsx` does so opening the share Dialog
// doesn't need a real `QueryClientProvider`.
const { useAppInfo } = vi.hoisted(() => ({ useAppInfo: vi.fn() }));
// "Copy Markdown" audit test (below) only needs to observe the clipboard
// call, not a real toast render — stub `notify` like `use-like.test.ts` does.
const { notifyInfo, notifyError } = vi.hoisted(() => ({ notifyInfo: vi.fn(), notifyError: vi.fn() }));
// RFC-0020's "Download HTML" action — `apiFetch` is mocked, everything else from
// `@/lib/api-client` (`apiClient`, `apiOrigin`, ...) stays real: `use-page-
// mutations` (imported via `vi.importActual` below) imports from this module,
// and a bare `{ apiFetch }` replacement would leave it `undefined`.
const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('@/lib/use-bookmark', () => ({ useToggleBookmark }));
vi.mock('@/lib/use-watch', () => ({ useToggleWatch, useWatchStatus: vi.fn() }));
vi.mock('@/lib/use-like', () => ({ useToggleLike }));
vi.mock('@/lib/use-app-info', () => ({ useAppInfo }));
vi.mock('@/lib/notify', () => ({ notify: { info: notifyInfo, error: notifyError } }));
vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return { ...actual, apiFetch };
});
// `DeletePageDialog` is always mounted (not gated by its own `open` prop —
// only its Radix Dialog content is) and calls `useDeletePage()` unconditionally;
// keep every other export real (`useRenamePage` / `useRenameSubtree` are only
// invoked once the (never-opened, in this test) rename dialog form mounts).
vi.mock('@/lib/use-page-mutations', async () => {
  const actual = await vi.importActual<typeof import('@/lib/use-page-mutations')>('@/lib/use-page-mutations');
  return { ...actual, useDeletePage };
});
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }));

import { PageActionsMenu } from './page-actions-menu';

function makePage(overrides: Partial<PageWithRevision> = {}): PageWithRevision {
  return {
    _id: 'page-copy-1',
    path: '/docs/guide/example',
    revision: {
      _id: 'rev-1',
      path: '/docs/guide/example',
      body: '# hi',
      format: 'markdown',
      createdAt: '2026-05-01T00:00:00.000Z',
      contentType: 'markdown',
    },
    creator: null,
    lastUpdateUser: null,
    commentCount: 0,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-10T00:00:00.000Z',
    likerCount: 0,
    seenUsersCount: 0,
    ...overrides,
  } as PageWithRevision;
}

beforeEach(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // Radix dropdown primitives call these in jsdom, which lacks them.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};

  useToggleBookmark.mockReturnValue({ isBookmarked: false, toggle: vi.fn(), isPending: false, isError: false, error: null });
  useToggleWatch.mockReturnValue({ watching: false, toggle: vi.fn(), isPending: false, isError: false, error: null });
  useToggleLike.mockReturnValue({ toggle: vi.fn(), isPending: false, isError: false, error: null });
  useDeletePage.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false, error: null, reset: vi.fn() });
  useAppInfo.mockReturnValue({ data: { title: 'Crowi' } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Opens the compact dotmenu, ready for the "URLをコピー" item to be found/clicked. */
function openCompactMenu(page: PageWithRevision) {
  render(<PageActionsMenu page={page} compact isAuthenticated />);
  // Radix opens the menu on pointerdown; jsdom needs an explicit PointerEvent.
  const trigger = screen.getByLabelText(m['page.action_more']());
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(trigger);
}

/**
 * jsdom does not implement `URL.createObjectURL` / `revokeObjectURL`, so both
 * the "Download Markdown" and "Download HTML" suites stub them the same way
 * (and no-op the anchor click) to let `saveBlobAsDownload`'s happy path run
 * without throwing before there's anything to assert. Call from `beforeEach`
 * and call the returned `restore` from `afterEach`.
 */
function stubDownloadPrimitives(mockUrl: string) {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const createObjectURL = vi.fn(() => mockUrl);
  const revokeObjectURL = vi.fn();
  URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;
  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const restore = () => {
    clickSpy.mockRestore();
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  };
  return { createObjectURL, revokeObjectURL, clickSpy, restore };
}

describe('PageActionsMenu — share menu item (compact dotmenu)', () => {
  it('labels the item "Copy URL" — not the old, wrong "Title + URL" label', () => {
    openCompactMenu(makePage());

    expect(screen.getByRole('menuitem', { name: m['page.share.menu_copy_url']() })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: m['page.share.link_label']() })).not.toBeInTheDocument();
  });

  it('opens a share Dialog and auto-copies buildPageShareUrl(page._id) the instant it opens — regression: previously copied silently with no modal/feedback', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const page = makePage();
    openCompactMenu(page);
    fireEvent.click(screen.getByRole('menuitem', { name: m['page.share.menu_copy_url']() }));

    // The DropdownMenuItem's onSelect closes the dotmenu and flips `isShareOpen`;
    // the Dialog + its auto-copy confirmation land asynchronously.
    expect(await screen.findByText(m['page.share.url_copied']())).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(buildPageShareUrl(page._id));
  });

  it('shows the same "title + URL" / Markdown rows as the PC popover, with the same copyable strings', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const page = makePage();
    openCompactMenu(page);
    fireEvent.click(screen.getByRole('menuitem', { name: m['page.share.menu_copy_url']() }));
    await screen.findByText(m['page.share.url_copied']());

    const idUrl = buildPageShareUrl(page._id);
    expect(screen.getByText(m['page.share.link_label']())).toBeInTheDocument();
    expect(screen.getByText(m['page.share.markdown_label']())).toBeInTheDocument();
    expect(screen.getByDisplayValue(`Crowi ${page.path} ${idUrl}`)).toBeInTheDocument();
    expect(screen.getByDisplayValue(`[${page.path}](${idUrl})`)).toBeInTheDocument();

    // Each row copies its own value, independent of the auto-copied id URL.
    writeText.mockClear();
    const [shareLinkCopyButton, markdownCopyButton] = screen.getAllByRole('button', { name: m['page.share.copy']() });
    fireEvent.click(shareLinkCopyButton);
    expect(writeText).toHaveBeenCalledWith(`Crowi ${page.path} ${idUrl}`);

    fireEvent.click(markdownCopyButton);
    expect(writeText).toHaveBeenCalledWith(`[${page.path}](${idUrl})`);
  });

  it('opens the Dialog without crashing when the clipboard write rejects (insecure context / denied) — no confirmation shown, rows still usable', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.assign(navigator, { clipboard: { writeText } });

    const page = makePage();
    openCompactMenu(page);
    fireEvent.click(screen.getByRole('menuitem', { name: m['page.share.menu_copy_url']() }));

    // The panel still renders (rows selectable for manual copy) even though
    // the silent auto-copy attempt failed — no "copied" confirmation appears.
    expect(await screen.findByText(m['page.share.link_label']())).toBeInTheDocument();
    expect(screen.queryByText(m['page.share.url_copied']())).not.toBeInTheDocument();
  });
});

describe('PageActionsMenu — "Download Markdown" action (feature-page-markdown-download)', () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let clickSpy: ReturnType<typeof vi.spyOn>;
  let restoreDownloadPrimitives: () => void;

  beforeEach(() => {
    ({ createObjectURL, revokeObjectURL, clickSpy, restore: restoreDownloadPrimitives } = stubDownloadPrimitives('blob:mock-url'));
  });

  afterEach(() => {
    restoreDownloadPrimitives();
  });

  it('shows "Download markdown" immediately after "Copy markdown", with no separator between them (AC-1, AC-13 position)', () => {
    openCompactMenu(makePage());

    const labels = screen.getAllByRole('menuitem').map((item) => item.textContent);
    const copyIndex = labels.indexOf(m['page.action_copy_markdown']());
    const downloadIndex = labels.indexOf(m['page.action_download_markdown']());
    expect(copyIndex).toBeGreaterThanOrEqual(0);
    expect(downloadIndex).toBe(copyIndex + 1);
  });

  it('creates an object URL for the body and clicks a download-attributed anchor named from the page path (AC-2, AC-3)', async () => {
    const captured: { anchor: { hrefAttr: string | null; download: string } | null } = { anchor: null };
    clickSpy.mockImplementation(function mockClick(this: HTMLAnchorElement) {
      captured.anchor = { hrefAttr: this.getAttribute('href'), download: this.download };
    });

    const page = makePage({
      path: '/foo/bar',
      revision: { _id: 'rev-1', path: '/foo/bar', body: '# hi', format: 'markdown', createdAt: '2026-05-01T00:00:00.000Z', contentType: 'markdown' },
    });
    openCompactMenu(page);
    fireEvent.click(screen.getByRole('menuitem', { name: m['page.action_download_markdown']() }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('text/markdown;charset=utf-8');
    await expect(blob.text()).resolves.toBe('# hi');
    expect(captured.anchor).not.toBeNull();
    expect(captured.anchor?.hrefAttr).toBe('blob:mock-url');
    expect(captured.anchor?.download).toBe('bar.md');
    // No success toast (D-3) — the browser's own download UI is the feedback.
    expect(notifyInfo).not.toHaveBeenCalled();
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('revokes the object URL after a successful download (AC-12, success path)', () => {
    openCompactMenu(makePage());
    fireEvent.click(screen.getByRole('menuitem', { name: m['page.action_download_markdown']() }));

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('does nothing and shows no notification when the body is empty (AC-10)', () => {
    const page = makePage({
      revision: { _id: 'rev-1', path: '/docs/guide/example', body: '', format: 'markdown', createdAt: '2026-05-01T00:00:00.000Z', contentType: 'markdown' },
    });
    openCompactMenu(page);
    fireEvent.click(screen.getByRole('menuitem', { name: m['page.action_download_markdown']() }));

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(notifyInfo).not.toHaveBeenCalled();
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('shows an error notification and still revokes the object URL when the download throws (AC-11, AC-12 exception path)', () => {
    clickSpy.mockImplementation(() => {
      throw new Error('download failed');
    });

    openCompactMenu(makePage());
    fireEvent.click(screen.getByRole('menuitem', { name: m['page.action_download_markdown']() }));

    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(notifyError).toHaveBeenCalledWith(m['page.markdown_download_failed']());
    // The URL was obtained before the throw, so it must still be released.
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  it('shows a single error notification, without escaping the component, when revokeObjectURL itself throws (AC-11, AC-12 revoke-failure path)', () => {
    revokeObjectURL.mockImplementation(() => {
      throw new Error('revoke failed');
    });

    openCompactMenu(makePage());
    expect(() => {
      fireEvent.click(screen.getByRole('menuitem', { name: m['page.action_download_markdown']() }));
    }).not.toThrow();

    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(notifyError).toHaveBeenCalledWith(m['page.markdown_download_failed']());
    // The click that actually delivers the file already happened before
    // revoke was attempted — the cleanup failure alone must not undo that.
    expect(clickSpy).toHaveBeenCalledTimes(1);
    // Regression guard: the shared `saveBlobAsDownload` helper must retry
    // the revoke once on failure, swallowing the second failure.
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });
});

describe('PageActionsMenu — "Download HTML" action for an artifact page (RFC-0020, AC-CH-4)', () => {
  function makeArtifactPage(overrides: Partial<PageWithRevision> = {}): PageWithRevision {
    return makePage({
      revision: {
        _id: 'rev-artifact-1',
        path: '/docs/guide/example',
        body: '<!doctype html><html><body>hi</body></html>',
        format: 'artifact',
        createdAt: '2026-05-01T00:00:00.000Z',
        contentType: 'artifact',
      },
      ...overrides,
    });
  }

  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let clickSpy: ReturnType<typeof vi.spyOn>;
  let restoreDownloadPrimitives: () => void;

  beforeEach(() => {
    ({ createObjectURL, revokeObjectURL, clickSpy, restore: restoreDownloadPrimitives } = stubDownloadPrimitives('blob:mock-artifact-url'));
  });

  afterEach(() => {
    restoreDownloadPrimitives();
  });

  it('hides Copy markdown and Portalize, shows Download HTML, and keeps the generic items (M-6: History/Rename/Delete)', () => {
    openCompactMenu(makeArtifactPage());

    expect(screen.queryByRole('menuitem', { name: m['page.action_copy_markdown']() })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: m['page.action_download_markdown']() })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: m['page.action_portalize']() })).toBeNull();
    expect(screen.getByRole('menuitem', { name: m['page.action_download_html']() })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: m['page.action_history']() })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: m['page.action_rename']() })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: m['page.action_delete']() })).toBeTruthy();
  });

  it('keeps Watch and Share (compact-folded) for an artifact page (M-6)', () => {
    // `openCompactMenu` renders with `compact isAuthenticated` — the same
    // props that fold Watch / Bookmark / Copy-link into the dotmenu for a
    // Markdown page. None of the M-1..M-5 artifact branches touch this
    // `compact` block, so it must still appear unchanged.
    openCompactMenu(makeArtifactPage());

    expect(screen.getByRole('menuitem', { name: m['page.watch_label']() })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: m['page.share.menu_copy_url']() })).toBeTruthy();
  });

  it('keeps Like (foldSocial-folded) for an artifact page (M-6)', () => {
    // `foldSocial` (the portal header's fold set) is the only place Like
    // appears as a dotmenu item — exercise it directly rather than via
    // `openCompactMenu`.
    render(<PageActionsMenu page={makeArtifactPage()} foldSocial isAuthenticated isLiked={false} />);
    const trigger = screen.getByLabelText(m['page.action_more']());
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(trigger);

    expect(screen.getByRole('menuitem', { name: m['page.like_label']() })).toBeTruthy();
  });

  it('fetches the delivery route with the displayed revision id and saves the bytes as an octet-stream blob via an object-URL anchor (AC-2/AC-3-equivalent, AC-CH-4)', async () => {
    const bytes = new TextEncoder().encode('<!doctype html><html></html>').buffer;
    apiFetch.mockResolvedValue({ ok: true, arrayBuffer: async () => bytes } as unknown as Response);
    const captured: { anchor: { hrefAttr: string | null; download: string } | null } = { anchor: null };
    clickSpy.mockImplementation(function mockClick(this: HTMLAnchorElement) {
      captured.anchor = { hrefAttr: this.getAttribute('href'), download: this.download };
    });

    const page = makeArtifactPage({ _id: 'page-artifact-1', path: '/foo/bar' });
    openCompactMenu(page);
    fireEvent.click(screen.getByRole('menuitem', { name: m['page.action_download_html']() }));

    await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith(`/api/pages/${page._id}/artifact-download?revision=rev-artifact-1`);
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('application/octet-stream');
    expect(captured.anchor).not.toBeNull();
    // An object-URL `<a download>` save, never a navigation to the server URL
    // (which would 401 — `/pages/*` doesn't accept the cookie fallback).
    expect(captured.anchor?.hrefAttr).toBe('blob:mock-artifact-url');
    expect(captured.anchor?.download).toBe('bar.html');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-artifact-url');
    expect(notifyError).not.toHaveBeenCalled();
  });

  it.each([
    ['401 (unauthenticated)', 401],
    ['404 (not found)', 404],
  ])('shows a failure toast and creates no blob/anchor/revoke when the response is not ok — %s', async (_label, status) => {
    apiFetch.mockResolvedValue({ ok: false, status, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response);

    openCompactMenu(makeArtifactPage());
    fireEvent.click(screen.getByRole('menuitem', { name: m['page.action_download_html']() }));

    await vi.waitFor(() => expect(notifyError).toHaveBeenCalledWith(m['page.artifact_download_failed']()));
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(clickSpy).not.toHaveBeenCalled();
    // Nothing was ever created, so nothing must be revoked either — the
    // `!response.ok` branch returns before any blob/URL work starts.
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it('shows a failure toast and creates no blob/anchor/revoke when the fetch itself rejects', async () => {
    apiFetch.mockRejectedValue(new Error('network down'));

    openCompactMenu(makeArtifactPage());
    fireEvent.click(screen.getByRole('menuitem', { name: m['page.action_download_html']() }));

    await vi.waitFor(() => expect(notifyError).toHaveBeenCalledWith(m['page.artifact_download_failed']()));
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(clickSpy).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it('shows a failure toast and still revokes the object URL when the anchor click throws after a successful fetch (saveBlobAsDownload retry path)', async () => {
    const bytes = new TextEncoder().encode('<!doctype html><html></html>').buffer;
    apiFetch.mockResolvedValue({ ok: true, arrayBuffer: async () => bytes } as unknown as Response);
    clickSpy.mockImplementation(() => {
      throw new Error('click failed');
    });

    openCompactMenu(makeArtifactPage());
    fireEvent.click(screen.getByRole('menuitem', { name: m['page.action_download_html']() }));

    await vi.waitFor(() => expect(notifyError).toHaveBeenCalledWith(m['page.artifact_download_failed']()));
    expect(notifyError).toHaveBeenCalledTimes(1);
    // The URL was created before the throw, so `saveBlobAsDownload`'s retry
    // path must still release it — same contract as the Markdown path.
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-artifact-url');
  });
});

describe('PageActionsMenu — "Copy Markdown" action (feature-page-link-space-paths Phase 1 audit note, AC 13)', () => {
  it("copies page.revision.body byte-for-byte, including a literal un-re-encoded space-link destination — `handleCopyMarkdown` clipboard-writes the stored body string as-is; it never re-renders or re-parses it, so it is structurally unaffected by this feature's renderer/link-detector/page-path changes", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const body = '# Title\n\nSee [space link](/a b), [percent link](/a%20b) and [plus link](/a+b).';
    const page = makePage({
      revision: { _id: 'rev-1', path: '/docs/guide/example', body, format: 'markdown', createdAt: '2026-05-01T00:00:00.000Z', contentType: 'markdown' },
    });
    openCompactMenu(page);
    fireEvent.click(screen.getByRole('menuitem', { name: m['page.action_copy_markdown']() }));

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(body));
    // Not just "contains" — the exact same string, unencoded/unmodified.
    expect(writeText.mock.calls[0][0]).toBe(body);
  });
});
