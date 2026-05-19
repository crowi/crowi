import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useMeasuredHeight, useStickyHeader } from './use-sticky-header';

// ---------------------------------------------------------------------------
// useStickyHeader — compact toggles on `scrollY >= H`
// ---------------------------------------------------------------------------

/** Set the document scroll position and dispatch a `scroll` event. */
function scrollTo(y: number) {
  act(() => {
    Object.defineProperty(window, 'scrollY', { value: y, configurable: true, writable: true });
    window.dispatchEvent(new Event('scroll'));
  });
}

describe('useStickyHeader', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true, writable: true });
  });

  it('starts in the expanded (non-compact) state', () => {
    const { result } = renderHook(() => useStickyHeader(200));
    expect(result.current.compact).toBe(false);
  });

  it('stays expanded while scrollY is below H', () => {
    const { result } = renderHook(() => useStickyHeader(200));
    scrollTo(199);
    expect(result.current.compact).toBe(false);
  });

  it('switches to compact once scrollY reaches H', () => {
    const { result } = renderHook(() => useStickyHeader(200));
    scrollTo(200);
    expect(result.current.compact).toBe(true);
  });

  it('stays compact while scrollY is past H', () => {
    const { result } = renderHook(() => useStickyHeader(200));
    scrollTo(640);
    expect(result.current.compact).toBe(true);
  });

  it('returns to expanded when scrollY drops back below H', () => {
    const { result } = renderHook(() => useStickyHeader(200));
    scrollTo(300);
    expect(result.current.compact).toBe(true);
    scrollTo(120);
    expect(result.current.compact).toBe(false);
  });

  it('never compacts while H is unmeasured (0)', () => {
    const { result } = renderHook(() => useStickyHeader(0));
    scrollTo(5000);
    expect(result.current.compact).toBe(false);
  });

  it('re-evaluates compact when H changes', () => {
    Object.defineProperty(window, 'scrollY', { value: 250, configurable: true, writable: true });
    const { result, rerender } = renderHook(({ h }: { h: number }) => useStickyHeader(h), {
      initialProps: { h: 300 },
    });
    // scrollY 250 < H 300 → expanded.
    expect(result.current.compact).toBe(false);
    // The expanded header reflowed shorter (H 200); 250 >= 200 → compact.
    rerender({ h: 200 });
    expect(result.current.compact).toBe(true);
  });

  it('removes its scroll listener on unmount', () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useStickyHeader(200));
    unmount();
    expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function));
    remove.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// useMeasuredHeight — tracks the expanded header's height H
// ---------------------------------------------------------------------------

let resizeCallbacks: ResizeObserverCallback[] = [];

class MockResizeObserver {
  constructor(cb: ResizeObserverCallback) {
    resizeCallbacks.push(cb);
  }
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

describe('useMeasuredHeight', () => {
  beforeEach(() => {
    resizeCallbacks = [];
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('measures the attached element offsetHeight on mount', () => {
    const node = document.createElement('div');
    Object.defineProperty(node, 'offsetHeight', { value: 240, configurable: true });

    const { result } = renderHook(() => {
      const state = useMeasuredHeight();
      state.ref.current = node;
      return state;
    });

    // Mount effect runs the initial measure.
    act(() => {
      result.current.ref.current = node;
    });
    expect(result.current.height).toBe(240);
  });

  it('re-measures when the element reflows (ResizeObserver fires)', () => {
    const node = document.createElement('div');
    Object.defineProperty(node, 'offsetHeight', { value: 240, configurable: true, writable: true });

    const { result } = renderHook(() => {
      const state = useMeasuredHeight();
      state.ref.current = node;
      return state;
    });
    expect(result.current.height).toBe(240);

    // The expanded header reflowed taller; the observer reports it.
    Object.defineProperty(node, 'offsetHeight', { value: 312, configurable: true, writable: true });
    act(() => {
      for (const cb of resizeCallbacks) cb([], {} as ResizeObserver);
    });
    expect(result.current.height).toBe(312);
  });

  it('stays at 0 when no element is attached', () => {
    const { result } = renderHook(() => useMeasuredHeight());
    expect(result.current.height).toBe(0);
  });
});
