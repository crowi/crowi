import type { PageWithRevision } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPageShareUrl } from '@/lib/build-page-share-url';

// `SharePanelContent` calls `useAppInfo()` (a `useQuery`); mock it like
// `page-header.test.tsx` does so the popover doesn't need a real
// `QueryClientProvider`.
const { useAppInfo } = vi.hoisted(() => ({ useAppInfo: vi.fn() }));
vi.mock('@/lib/use-app-info', () => ({ useAppInfo }));

import { LinkSharePopover } from './link-share-popover';

function makePage(overrides: Partial<PageWithRevision> = {}): PageWithRevision {
  return {
    _id: 'page-share-1',
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

  useAppInfo.mockReturnValue({ data: { title: 'Crowi' } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Opens the PC/wide share popover, ready for its panel content to be found. */
function openPopover(page: PageWithRevision) {
  render(<LinkSharePopover page={page} />);
  const trigger = screen.getByLabelText(m['page.share.aria_open']());
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(trigger);
}

describe('LinkSharePopover — PC/wide share popover (SharePanelContent regression coverage)', () => {
  it('auto-copies buildPageShareUrl(page._id) the instant the popover opens, and shows the confirmation', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const page = makePage();
    openPopover(page);

    expect(await screen.findByText(m['page.share.url_copied']())).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(buildPageShareUrl(page._id));
  });

  it('shows the "title + URL" and Markdown rows, each copying the same strings the mobile share Dialog copies', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const page = makePage();
    openPopover(page);
    await screen.findByText(m['page.share.url_copied']());

    const idUrl = buildPageShareUrl(page._id);
    expect(screen.getByText(m['page.share.link_label']())).toBeInTheDocument();
    expect(screen.getByText(m['page.share.markdown_label']())).toBeInTheDocument();
    expect(screen.getByDisplayValue(`Crowi ${page.path} ${idUrl}`)).toBeInTheDocument();
    expect(screen.getByDisplayValue(`[${page.path}](${idUrl})`)).toBeInTheDocument();

    writeText.mockClear();
    const [shareLinkCopyButton, markdownCopyButton] = screen.getAllByRole('button', { name: m['page.share.copy']() });
    fireEvent.click(shareLinkCopyButton);
    expect(writeText).toHaveBeenCalledWith(`Crowi ${page.path} ${idUrl}`);

    fireEvent.click(markdownCopyButton);
    expect(writeText).toHaveBeenCalledWith(`[${page.path}](${idUrl})`);
  });

  it('re-fires the auto-copy on every reopen (not just the first open)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const page = makePage();
    render(<LinkSharePopover page={page} />);
    const trigger = screen.getByLabelText(m['page.share.aria_open']());

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(trigger);
    await screen.findByText(m['page.share.url_copied']());
    expect(writeText).toHaveBeenCalledTimes(1);

    // Close (click the trigger again) then reopen.
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(trigger);
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(trigger);

    expect(await screen.findByText(m['page.share.url_copied']())).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledTimes(2);
  });
});
