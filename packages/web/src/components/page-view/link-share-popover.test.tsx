import type { PageWithRevision } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
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

  it('clears the pending 1500ms copy-confirmation reset timer on unmount (repro: an uncleared setTimeout fired after jsdom teardown and crashed with "window is not defined" in CI)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    // Spy (without replacing behavior) on setTimeout/clearTimeout so the
    // specific timer id the 1500ms reset schedules can be identified —
    // there are other unrelated setTimeout/clearTimeout calls in
    // React/Radix/jsdom during mount and unmount, so asserting
    // "clearTimeout was called at all" would pass even without the fix;
    // only the matching id proves THIS timer was cleared.
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    const page = makePage();
    const { unmount } = render(<LinkSharePopover page={page} />);
    const trigger = screen.getByLabelText(m['page.share.aria_open']());
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(trigger);

    // Auto-copy on mount schedules the reset timer only once its
    // clipboard-write promise resolves.
    await screen.findByText(m['page.share.url_copied']());
    const resetTimerCallIndex = setTimeoutSpy.mock.calls.findIndex((call) => call[1] === 1500);
    expect(resetTimerCallIndex).toBeGreaterThanOrEqual(0);
    const resetTimerId = setTimeoutSpy.mock.results[resetTimerCallIndex].value;
    clearTimeoutSpy.mockClear();

    // Unmount well before the 1500ms reset would fire. The bug this
    // reproduces: the old code never cleared this specific timer, so it
    // outlived the component (and, in a real test run, could outlive the
    // whole jsdom environment) and later crashed calling setCopiedKey
    // against a `window` that no longer existed.
    unmount();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(resetTimerId);

    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });

  it('does not schedule a reset timer for a clipboard write that resolves after the panel has already unmounted', async () => {
    // A deferred (manually-resolved) promise stands in for a clipboard
    // write that is still pending when the panel unmounts — the unmount
    // cleanup can only clear a timer that already exists when it runs; a
    // `copy()` call resuming AFTER that cleanup ran would otherwise
    // schedule a brand new timer nothing can ever clear again.
    let resolveWriteText!: () => void;
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveWriteText = resolve;
        }),
    );
    Object.assign(navigator, { clipboard: { writeText } });

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const page = makePage();
    const { unmount } = render(<LinkSharePopover page={page} />);
    const trigger = screen.getByLabelText(m['page.share.aria_open']());
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(trigger);

    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    unmount();
    setTimeoutSpy.mockClear();

    // Let the write "complete" now that the panel is gone.
    resolveWriteText();
    await Promise.resolve();
    await Promise.resolve();

    expect(setTimeoutSpy.mock.calls.some((call) => call[1] === 1500)).toBe(false);

    setTimeoutSpy.mockRestore();
  });

  it('still shows the copy confirmation under React.StrictMode (repro: isMountedRef was set false by the dev-mode fake unmount/remount and never reset true)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const page = makePage();
    render(<LinkSharePopover page={page} />, { wrapper: StrictMode });
    const trigger = screen.getByLabelText(m['page.share.aria_open']());
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(trigger);

    expect(await screen.findByText(m['page.share.url_copied']())).toBeInTheDocument();
  });
});
