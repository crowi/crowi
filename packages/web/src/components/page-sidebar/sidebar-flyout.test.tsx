import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarFlyout } from './sidebar-flyout';

const { pathname } = vi.hoisted(() => ({ pathname: { value: '/some/page' } }));
vi.mock('next/navigation', () => ({
  usePathname: () => pathname.value,
}));

// The panel's contents are covered by their own tests; this file is about
// the open/close machine, so both are stubbed down to markers.
vi.mock('./sidebar-body', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sidebar-body')>()),
  SidebarBody: ({ path }: { path: string }) => <div data-testid="sidebar-body">{path}</div>,
}));

const openButton = () => screen.getByRole('button', { name: 'サイドバーを開く' });
const panel = () => screen.queryByRole('dialog');

// `useMediaQuery` caches one MediaQueryList per query in a ref and re-reads
// `.matches` off that same object, so a stub whose `matches` was fixed at
// construction could never report the viewport widening. A live getter can.
const rail = { matches: false };

beforeEach(() => {
  pathname.value = '/some/page';
  rail.matches = false;
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        get matches() {
          return rail.matches;
        },
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
});

afterEach(cleanup);

describe('SidebarFlyout', () => {
  it('opens on click and closes on a second click', () => {
    render(createElement(SidebarFlyout, { path: '/some/page' }));

    expect(panel()).toBeNull();
    fireEvent.click(openButton());
    expect(panel()).not.toBeNull();
    expect(screen.getByTestId('sidebar-body')).toHaveTextContent('/some/page');

    fireEvent.click(openButton());
    expect(panel()).toBeNull();
  });

  it('opens when a mouse enters the trigger and retracts once the pointer leaves', () => {
    vi.useFakeTimers();
    try {
      render(createElement(SidebarFlyout, { path: '/some/page' }));

      fireEvent.pointerEnter(openButton(), { pointerType: 'mouse' });
      expect(panel()).not.toBeNull();

      fireEvent.pointerLeave(openButton(), { pointerType: 'mouse' });
      // Still open during the grace window — the pointer may be crossing the
      // gap towards the panel.
      expect(panel()).not.toBeNull();
      act(() => vi.advanceTimersByTime(500));
      expect(panel()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a hover-opened panel that the pointer moved into', () => {
    vi.useFakeTimers();
    try {
      render(createElement(SidebarFlyout, { path: '/some/page' }));

      fireEvent.pointerEnter(openButton(), { pointerType: 'mouse' });
      fireEvent.pointerLeave(openButton(), { pointerType: 'mouse' });
      const content = panel();
      if (content === null) throw new Error('expected the panel to be open');
      fireEvent.pointerEnter(content, { pointerType: 'mouse' });

      act(() => vi.advanceTimersByTime(500));
      expect(panel()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not open on touch, where the tap that follows would close it again', () => {
    render(createElement(SidebarFlyout, { path: '/some/page' }));

    fireEvent.pointerEnter(openButton(), { pointerType: 'touch' });
    expect(panel()).toBeNull();

    // The tap itself still opens it.
    fireEvent.click(openButton());
    expect(panel()).not.toBeNull();
  });

  it('pins a hover-opened panel when the trigger is clicked, rather than toggling it shut', () => {
    vi.useFakeTimers();
    try {
      render(createElement(SidebarFlyout, { path: '/some/page' }));

      fireEvent.pointerEnter(openButton(), { pointerType: 'mouse' });
      fireEvent.click(openButton());
      expect(panel()).not.toBeNull();

      // Pinned means the pointer leaving no longer retracts it.
      fireEvent.pointerLeave(openButton(), { pointerType: 'mouse' });
      act(() => vi.advanceTimersByTime(500));
      expect(panel()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes on Escape', () => {
    render(createElement(SidebarFlyout, { path: '/some/page' }));

    fireEvent.click(openButton());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(panel()).toBeNull();
  });

  it('closes when a navigation lands on a new path', () => {
    const { rerender } = render(createElement(SidebarFlyout, { path: '/some/page' }));

    fireEvent.click(openButton());
    expect(panel()).not.toBeNull();

    pathname.value = '/some/other-page';
    rerender(createElement(SidebarFlyout, { path: '/some/other-page' }));
    expect(panel()).toBeNull();
  });

  it('closes when the viewport widens far enough for the rail to take over', () => {
    const { rerender } = render(createElement(SidebarFlyout, { path: '/some/page' }));

    fireEvent.click(openButton());
    expect(panel()).not.toBeNull();

    rail.matches = true;
    rerender(createElement(SidebarFlyout, { path: '/some/page' }));
    expect(panel()).toBeNull();
  });
});
