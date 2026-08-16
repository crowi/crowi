import type { PageWithRevision } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPageShareUrl } from '@/lib/build-page-share-url';

const { useToggleBookmark } = vi.hoisted(() => ({ useToggleBookmark: vi.fn() }));
const { useToggleWatch } = vi.hoisted(() => ({ useToggleWatch: vi.fn() }));
const { useDeletePage } = vi.hoisted(() => ({ useDeletePage: vi.fn() }));
// `ShareDialog` → `SharePanelContent` calls `useAppInfo()` (a `useQuery`);
// mock it like `page-header.test.tsx` does so opening the share Dialog
// doesn't need a real `QueryClientProvider`.
const { useAppInfo } = vi.hoisted(() => ({ useAppInfo: vi.fn() }));
// "Copy Markdown" audit test (below) only needs to observe the clipboard
// call, not a real toast render — stub `notify` like `use-like.test.ts` does.
const { notifyInfo, notifyError } = vi.hoisted(() => ({ notifyInfo: vi.fn(), notifyError: vi.fn() }));

vi.mock('@/lib/use-bookmark', () => ({ useToggleBookmark }));
vi.mock('@/lib/use-watch', () => ({ useToggleWatch, useWatchStatus: vi.fn() }));
vi.mock('@/lib/use-app-info', () => ({ useAppInfo }));
vi.mock('@/lib/notify', () => ({ notify: { info: notifyInfo, error: notifyError } }));
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
  // jsdom does not implement these — stub them so `handleDownloadMarkdown`'s
  // happy path doesn't throw before we can assert anything.
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let clickSpy: ReturnType<typeof vi.spyOn>;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    createObjectURL = vi.fn(() => 'blob:mock-url');
    revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    clickSpy.mockRestore();
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
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
      revision: { _id: 'rev-1', path: '/foo/bar', body: '# hi', format: 'markdown', createdAt: '2026-05-01T00:00:00.000Z' },
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
      revision: { _id: 'rev-1', path: '/docs/guide/example', body: '', format: 'markdown', createdAt: '2026-05-01T00:00:00.000Z' },
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
  });
});

describe('PageActionsMenu — "Copy Markdown" action (feature-page-link-space-paths Phase 1 audit note, AC 13)', () => {
  it("copies page.revision.body byte-for-byte, including a literal un-re-encoded space-link destination — `handleCopyMarkdown` clipboard-writes the stored body string as-is; it never re-renders or re-parses it, so it is structurally unaffected by this feature's renderer/link-detector/page-path changes", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const body = '# Title\n\nSee [space link](/a b), [percent link](/a%20b) and [plus link](/a+b).';
    const page = makePage({
      revision: { _id: 'rev-1', path: '/docs/guide/example', body, format: 'markdown', createdAt: '2026-05-01T00:00:00.000Z' },
    });
    openCompactMenu(page);
    fireEvent.click(screen.getByRole('menuitem', { name: m['page.action_copy_markdown']() }));

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(body));
    // Not just "contains" — the exact same string, unencoded/unmodified.
    expect(writeText.mock.calls[0][0]).toBe(body);
  });
});
