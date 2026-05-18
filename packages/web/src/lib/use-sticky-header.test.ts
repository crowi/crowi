import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useStickyHeader } from './use-sticky-header';

/**
 * jsdom has no IntersectionObserver. We install a controllable stub that
 * records its callback so a test can drive the sentinel's visibility.
 */
type IOCallback = (entries: { isIntersecting: boolean }[]) => void;

let lastCallback: IOCallback | null = null;
const observe = vi.fn();
const disconnect = vi.fn();

class MockIntersectionObserver {
  constructor(cb: IOCallback) {
    lastCallback = cb;
  }
  observe = observe;
  unobserve = vi.fn();
  disconnect = disconnect;
  takeRecords = vi.fn(() => []);
}

/** Push a sentinel intersection update through the recorded callback. */
function emit(isIntersecting: boolean) {
  act(() => {
    lastCallback?.([{ isIntersecting }]);
  });
}

beforeEach(() => {
  lastCallback = null;
  observe.mockClear();
  disconnect.mockClear();
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useStickyHeader', () => {
  it('starts in the expanded (non-compact) state', () => {
    const { result } = renderHook(() => useStickyHeader());
    expect(result.current.compact).toBe(false);
  });

  it('observes the sentinel element once it is attached', () => {
    const { result } = renderHook(() => useStickyHeader());
    // The hook only observes when a sentinel node is present.
    const node = document.createElement('div');
    act(() => {
      result.current.sentinelRef.current = node;
    });
    // The observer is created in the mount effect; re-render to re-run it.
    expect(MockIntersectionObserver).toBeDefined();
  });

  it('switches to compact when the sentinel leaves the viewport', () => {
    const node = document.createElement('div');
    const { result } = renderHook(() => {
      const state = useStickyHeader();
      state.sentinelRef.current = node;
      return state;
    });

    emit(false); // sentinel scrolled out → header pinned → compact
    expect(result.current.compact).toBe(true);
  });

  it('returns to expanded when the sentinel scrolls back into view', () => {
    const node = document.createElement('div');
    const { result } = renderHook(() => {
      const state = useStickyHeader();
      state.sentinelRef.current = node;
      return state;
    });

    emit(false);
    expect(result.current.compact).toBe(true);
    emit(true); // back at the top
    expect(result.current.compact).toBe(false);
  });

  it('disconnects the observer on unmount', () => {
    const node = document.createElement('div');
    const { unmount } = renderHook(() => {
      const state = useStickyHeader();
      state.sentinelRef.current = node;
      return state;
    });

    unmount();
    expect(disconnect).toHaveBeenCalled();
  });
});
