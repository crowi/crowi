import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCopyFeedback } from './use-copy-feedback';

/**
 * jsdom does not implement the Clipboard API, so `navigator.clipboard` is
 * `undefined` by default — that IS the "insecure origin" case under test.
 * Tests that need the happy/reject path install a fake `writeText` and
 * restore the original value in `afterEach` so the absence doesn't leak
 * (or persist) across tests.
 */
function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.assign(navigator, { clipboard: { writeText } });
}

function unstubClipboard() {
  Object.assign(navigator, { clipboard: undefined });
}

beforeEach(() => {
  vi.useFakeTimers();
  unstubClipboard();
});

afterEach(() => {
  unstubClipboard();
  vi.useRealTimers();
  cleanup();
});

describe('useCopyFeedback', () => {
  it('sets an "unavailable" failure when navigator.clipboard does not exist, without throwing', () => {
    const { result } = renderHook(() => useCopyFeedback());

    act(() => {
      result.current.copy('hello');
    });

    expect(result.current.copied).toBe(false);
    expect(result.current.failed).toBe('unavailable');
  });

  it('sets a "rejected" failure when writeText rejects', async () => {
    stubClipboard(() => Promise.reject(new Error('denied')));
    const { result } = renderHook(() => useCopyFeedback());

    await act(async () => {
      result.current.copy('hello');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.copied).toBe(false);
    expect(result.current.failed).toBe('rejected');
  });

  it('never sets copied and failed at the same time', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const { result } = renderHook(() => useCopyFeedback());

    await act(async () => {
      result.current.copy('hello');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.copied).toBe(true);
    expect(result.current.failed).toBeNull();
  });

  it('lowers the failure flag after the same feedback window as success', () => {
    const { result } = renderHook(() => useCopyFeedback(1500));

    act(() => {
      result.current.copy('hello');
    });
    expect(result.current.failed).toBe('unavailable');

    act(() => {
      vi.advanceTimersByTime(1499);
    });
    expect(result.current.failed).toBe('unavailable');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.failed).toBeNull();
    expect(result.current.copied).toBe(false);
  });

  it('resets a stale failure the moment a new copy operation starts', async () => {
    const { result } = renderHook(() => useCopyFeedback(1500));

    act(() => {
      result.current.copy('hello');
    });
    expect(result.current.failed).toBe('unavailable');

    const writeText = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    stubClipboard(writeText);

    act(() => {
      result.current.copy('hello again');
    });

    expect(result.current.failed).toBeNull();
    expect(result.current.copied).toBe(false);
  });

  it('resets a stale success the moment a new copy operation starts', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const { result } = renderHook(() => useCopyFeedback(1500));

    await act(async () => {
      result.current.copy('hello');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.copied).toBe(true);

    // A still-pending second write lets the assertion below observe the
    // synchronous reset before anything settles it either way.
    stubClipboard(() => new Promise<void>(() => {}));

    act(() => {
      result.current.copy('hello again');
    });

    expect(result.current.copied).toBe(false);
    expect(result.current.failed).toBeNull();
  });

  it('delivers the failure to the caller instead of swallowing it (does not throw, does not stay silently false)', () => {
    const { result } = renderHook(() => useCopyFeedback());

    expect(result.current.failed).toBeNull();

    act(() => {
      result.current.copy('hello');
    });

    expect(result.current.failed).not.toBeNull();
  });

  it('ignores a settlement from a superseded attempt instead of overwriting a newer one', async () => {
    let rejectFirst: ((reason?: unknown) => void) | undefined;
    const writeText = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockImplementationOnce(() => Promise.resolve());
    stubClipboard(writeText);
    const { result } = renderHook(() => useCopyFeedback());

    act(() => {
      result.current.copy('first');
    });
    act(() => {
      result.current.copy('second');
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.copied).toBe(true);
    expect(result.current.failed).toBeNull();

    await act(async () => {
      rejectFirst?.(new Error('stale'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.copied).toBe(true);
    expect(result.current.failed).toBeNull();
  });

  it('invalidates a pending attempt even when the next call is a no-op empty-text call', async () => {
    let resolveFirst: (() => void) | undefined;
    const writeText = vi.fn().mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    stubClipboard(writeText);
    const { result } = renderHook(() => useCopyFeedback(1500));

    act(() => {
      result.current.copy('hello');
    });

    act(() => {
      result.current.copy('');
    });

    expect(result.current.copied).toBe(false);
    expect(result.current.failed).toBeNull();

    await act(async () => {
      resolveFirst?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.copied).toBe(false);
    expect(result.current.failed).toBeNull();
  });

  it('drops a writeText settlement that arrives after unmount instead of leaking a reset timer', async () => {
    let resolveWrite: (() => void) | undefined;
    const writeText = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    stubClipboard(writeText);
    const { result, unmount } = renderHook(() => useCopyFeedback());

    act(() => {
      result.current.copy('hello');
    });

    unmount();

    await act(async () => {
      resolveWrite?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(vi.getTimerCount()).toBe(0);
  });
});
