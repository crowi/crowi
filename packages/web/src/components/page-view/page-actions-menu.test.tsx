import type { PageWithRevision } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPageShareUrl } from '@/lib/build-page-share-url';

const { useToggleBookmark } = vi.hoisted(() => ({ useToggleBookmark: vi.fn() }));
const { useToggleWatch } = vi.hoisted(() => ({ useToggleWatch: vi.fn() }));
const { useDeletePage } = vi.hoisted(() => ({ useDeletePage: vi.fn() }));

vi.mock('@/lib/use-bookmark', () => ({ useToggleBookmark }));
vi.mock('@/lib/use-watch', () => ({ useToggleWatch, useWatchStatus: vi.fn() }));
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
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PageActionsMenu — copy-link menu item (compact dotmenu)', () => {
  it('copies buildPageShareUrl(page._id) — regression: previously hand-rolled `${origin}/${id}` outside the canonical helper', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const page = makePage();
    render(<PageActionsMenu page={page} compact isAuthenticated />);

    // Radix opens the menu on pointerdown; jsdom needs an explicit PointerEvent.
    const trigger = screen.getByLabelText(m['page.action_more']());
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(trigger);

    const copyItem = screen.getByRole('menuitem', { name: m['page.share.link_label']() });
    fireEvent.click(copyItem);

    expect(writeText).toHaveBeenCalledWith(buildPageShareUrl(page._id));
  });
});
