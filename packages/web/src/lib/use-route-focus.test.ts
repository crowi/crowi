import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const { usePathname } = vi.hoisted(() => ({ usePathname: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname }));

import { MAIN_CONTENT_ID, useRouteFocus } from './use-route-focus';

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

  it('does not re-focus on a rerender with the same pathname', () => {
    const { rerender } = renderHook(() => useRouteFocus());

    usePathname.mockReturnValue('/second');
    rerender();
    expect(focusSpy).toHaveBeenCalledTimes(1);

    // Same pathname value — the effect's dependency did not change.
    rerender();
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when #main-content is not in the document', () => {
    document.body.removeChild(main);

    const { rerender } = renderHook(() => useRouteFocus());
    usePathname.mockReturnValue('/second');
    expect(() => rerender()).not.toThrow();

    document.body.appendChild(main);
  });
});
