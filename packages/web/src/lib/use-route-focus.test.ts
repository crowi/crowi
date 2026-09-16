import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const { usePathname } = vi.hoisted(() => ({ usePathname: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname }));

import { MAIN_CONTENT_ID, skipRouteFocusFor, useRouteFocus } from './use-route-focus';

describe('useRouteFocus', () => {
  let main: HTMLElement;
  let focusSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    main = document.createElement('main');
    main.id = MAIN_CONTENT_ID;
    document.body.appendChild(main);
    focusSpy = vi.spyOn(main, 'focus');
    usePathname.mockReturnValue('/first');
  });

  afterEach(() => {
    document.body.removeChild(main);
    focusSpy.mockRestore();
    usePathname.mockReset();
  });

  it('does not focus #main-content on first mount', () => {
    renderHook(() => useRouteFocus());
    expect(focusSpy).not.toHaveBeenCalled();
  });

  // Regression: React StrictMode (dev default) double-invokes effects on
  // mount. A "skip the first render" ref latch is consumed by the first
  // invoke and then the second invoke (same initial pathname) steals focus —
  // producing a spurious focus-visible ring on `#main-content` right after a
  // page load. Focus must key off an actual pathname *change*, so the initial
  // pathname (however many times its effect runs) never focuses.
  it('does not focus #main-content on first mount even under StrictMode double-effect', () => {
    renderHook(() => useRouteFocus(), { wrapper: StrictMode });
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it('focuses exactly once on a route change under StrictMode', () => {
    const { rerender } = renderHook(() => useRouteFocus(), { wrapper: StrictMode });
    expect(focusSpy).not.toHaveBeenCalled();

    usePathname.mockReturnValue('/second');
    rerender();
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it('focuses #main-content once the pathname changes after mount', () => {
    const { rerender } = renderHook(() => useRouteFocus());
    expect(focusSpy).not.toHaveBeenCalled();

    usePathname.mockReturnValue('/second');
    rerender();
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it('focuses again on every subsequent pathname change', () => {
    const { rerender } = renderHook(() => useRouteFocus());

    usePathname.mockReturnValue('/second');
    rerender();
    usePathname.mockReturnValue('/third');
    rerender();

    expect(focusSpy).toHaveBeenCalledTimes(2);
  });

  it('focuses again when navigating back to a previously-visited pathname (A -> B -> A)', () => {
    // Guards against a "visited set" mistake: focus keys off the *immediately
    // previous* pathname, so returning to an earlier value is still a change.
    const { rerender } = renderHook(() => useRouteFocus());

    usePathname.mockReturnValue('/second');
    rerender();
    usePathname.mockReturnValue('/first');
    rerender();

    expect(focusSpy).toHaveBeenCalledTimes(2);
  });

  it('does not re-focus on a rerender with the same pathname', () => {
    const { rerender } = renderHook(() => useRouteFocus());

    usePathname.mockReturnValue('/second');
    rerender();
    expect(focusSpy).toHaveBeenCalledTimes(1);

    // Same pathname value — the effect's dependency did not change.
    rerender();
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  // `/<id>` → the page's own path is part of opening that URL, not a
  // navigation the reader made. Focusing there happens before any input, so
  // the browser draws it as :focus-visible — a ring around the page on arrival.
  it('does not focus on a pathname change announced as part of arriving at a URL', () => {
    const { rerender } = renderHook(() => useRouteFocus(), { wrapper: StrictMode });

    skipRouteFocusFor('/page/path');
    usePathname.mockReturnValue('/page/path');
    rerender();
    expect(focusSpy).not.toHaveBeenCalled();

    // The skipped pathname is now the one to compare against, so merely
    // rendering again on it is not a change either.
    rerender();
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it('focuses on the navigation after a skipped one', () => {
    const { rerender } = renderHook(() => useRouteFocus());

    skipRouteFocusFor('/page/path');
    usePathname.mockReturnValue('/page/path');
    rerender();
    usePathname.mockReturnValue('/another');
    rerender();
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it('still focuses a navigation that arrives instead of the announced redirect', () => {
    // The redirect was superseded (the reader followed a link before it
    // committed): the skip must not be spent on their navigation, nor linger
    // for a later visit to the page it was meant for.
    const { rerender } = renderHook(() => useRouteFocus());

    skipRouteFocusFor('/page/path');
    usePathname.mockReturnValue('/elsewhere');
    rerender();
    expect(focusSpy).toHaveBeenCalledTimes(1);

    usePathname.mockReturnValue('/page/path');
    rerender();
    expect(focusSpy).toHaveBeenCalledTimes(2);
  });

  it('recognises the redirect target in its URL-encoded form', () => {
    const { rerender } = renderHook(() => useRouteFocus());

    skipRouteFocusFor('/メモ/first draft');
    usePathname.mockReturnValue('/%E3%83%A1%E3%83%A2/first+draft');
    rerender();
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it('is a no-op when #main-content is not in the document', () => {
    document.body.removeChild(main);

    const { rerender } = renderHook(() => useRouteFocus());
    usePathname.mockReturnValue('/second');
    expect(() => rerender()).not.toThrow();

    document.body.appendChild(main);
  });
});
