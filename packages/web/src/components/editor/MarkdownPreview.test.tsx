import { m } from '@paraglide/messages.js';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `usePreview` itself is covered by `use-preview.test.ts`; mocked here so
// this file controls exactly when each call's promise settles.
const { mutateAsync } = vi.hoisted(() => ({ mutateAsync: vi.fn() }));
vi.mock('@/lib/use-preview', () => ({ usePreview: () => ({ mutateAsync }) }));

import { MarkdownPreview } from './MarkdownPreview';

const DEBOUNCE_MS = 250;

beforeEach(() => {
  vi.useFakeTimers();
  mutateAsync.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/**
 * feature-plugin-renderer-mermaid spec §7 item 8/12 — proves
 * `MarkdownPreview.tsx` needs NO change for the `use-preview.ts`
 * AbortController wiring: its existing `stale` cleanup flag already
 * ignores a superseded request's rejection (an aborted fetch rejects the
 * SAME way a network failure would) instead of surfacing the "Preview
 * failed" error state.
 */
describe('MarkdownPreview — stale-guard on a superseded (aborted) preview request', () => {
  it('does not show the error state when a request superseded by a `source` change later rejects with an AbortError', async () => {
    let rejectFirst: ((reason?: unknown) => void) | undefined;
    const firstCall = new Promise<unknown>((_resolve, reject) => {
      rejectFirst = reject;
    });
    mutateAsync.mockReturnValueOnce(firstCall);
    mutateAsync.mockReturnValueOnce(new Promise(() => {})); // second call never settles in this test

    const { rerender } = render(<MarkdownPreview source="first" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync).toHaveBeenNthCalledWith(1, 'first');

    // `source` changes before the first request settles — React runs the
    // effect cleanup (sets `stale = true` on the FIRST effect's closure)
    // synchronously as part of this re-render, exactly as
    // `use-preview.ts`'s own AbortController fires around the same time.
    rerender(<MarkdownPreview source="second" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });
    expect(mutateAsync).toHaveBeenCalledTimes(2);
    expect(mutateAsync).toHaveBeenNthCalledWith(2, 'second');

    // The superseded (first) request now rejects — as an aborted preview
    // fetch would (`use-preview.ts`'s AbortController.abort()).
    await act(async () => {
      rejectFirst?.(new DOMException('The operation was aborted.', 'AbortError'));
      await firstCall.catch(() => undefined);
    });

    // No "Preview failed" text — the stale flag's early-return in
    // `.catch()` swallowed it before `setErrored(true)` could run.
    expect(screen.queryByText(m['edit.preview_failed']())).not.toBeInTheDocument();
  });
});
