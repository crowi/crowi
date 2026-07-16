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

vi.mock('@/lib/use-bookmark', () => ({ useToggleBookmark }));
vi.mock('@/lib/use-watch', () => ({ useToggleWatch, useWatchStatus: vi.fn() }));
vi.mock('@/lib/use-app-info', () => ({ useAppInfo }));
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
