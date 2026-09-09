import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { matchMediaImpl } from '@/lib/test-utils/mocks';
import { SidebarFlyoutProvider, SidebarFlyoutTrigger } from './sidebar-flyout';

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
const openButtons = () => screen.queryAllByRole('button', { name: 'サイドバーを開く' });
const panel = () => screen.queryByRole('dialog');
const panels = () => screen.queryAllByRole('dialog');

/** The shape every call site has: a provider somewhere above, triggers inside. */
function flyout(path = '/some/page', triggerCount = 1) {
  return (
    <SidebarFlyoutProvider path={path} enabled>
      {Array.from({ length: triggerCount }, (_, i) => (
        <SidebarFlyoutTrigger key={i} />
      ))}
    </SidebarFlyoutProvider>
  );
}

// Flipped mid-test to play the viewport widening past the rail breakpoint;
// `matchMediaImpl` re-asks on every read, so the change is picked up.
const rail = { matches: false };

beforeEach(() => {
  pathname.value = '/some/page';
  rail.matches = false;
  vi.spyOn(window, 'matchMedia').mockImplementation(matchMediaImpl(() => rail.matches));
  // The hover grace window is the only timer here, and every test drives it
  // with synchronous `fireEvent` / `rerender` — no `findBy` / `waitFor` that
  // a faked clock would stall.
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

/** Advance past the grace window; the timer's setState needs an act() flush. */
const settleHover = () => act(() => vi.advanceTimersByTime(500));

describe('SidebarFlyout', () => {
  it('opens on click and closes on a second click', () => {
    render(flyout());

    expect(panel()).toBeNull();
    fireEvent.click(openButton());
    expect(panel()).not.toBeNull();
    expect(screen.getByTestId('sidebar-body')).toHaveTextContent('/some/page');

    fireEvent.click(openButton());
    expect(panel()).toBeNull();
  });

  it('stays closed when the trigger merely appears under a pointer that never moved', () => {
    // Dismissing the full-screen mobile search reveals this trigger under the
    // cursor that just pressed its back button — `pointerenter` fires there
    // with no movement at all, and opening on it hands the reader a panel
    // they did not ask for.
    render(flyout());

    fireEvent.pointerEnter(openButton(), { pointerType: 'mouse' });
    fireEvent.pointerOver(openButton(), { pointerType: 'mouse' });
    expect(panel()).toBeNull();
  });

  it('opens when a mouse moves onto the trigger and retracts once the pointer leaves', () => {
    render(flyout());

    fireEvent.pointerMove(openButton(), { pointerType: 'mouse' });
    expect(panel()).not.toBeNull();

    fireEvent.pointerLeave(openButton(), { pointerType: 'mouse' });
    // Still open during the grace window — the pointer may be crossing the
    // gap towards the panel.
    expect(panel()).not.toBeNull();
    settleHover();
    expect(panel()).toBeNull();
  });

  it('keeps a hover-opened panel that the pointer moved into', () => {
    render(flyout());

    fireEvent.pointerMove(openButton(), { pointerType: 'mouse' });
    fireEvent.pointerLeave(openButton(), { pointerType: 'mouse' });
    fireEvent.pointerEnter(screen.getByRole('dialog'), { pointerType: 'mouse' });

    settleHover();
    expect(panel()).not.toBeNull();
  });

  it('does not open on touch, where the tap that follows would close it again', () => {
    render(flyout());

    fireEvent.pointerMove(openButton(), { pointerType: 'touch' });
    expect(panel()).toBeNull();

    // The tap itself still opens it.
    fireEvent.click(openButton());
    expect(panel()).not.toBeNull();
  });

  it('pins a hover-opened panel when the trigger is clicked, rather than toggling it shut', () => {
    render(flyout());

    fireEvent.pointerMove(openButton(), { pointerType: 'mouse' });
    fireEvent.click(openButton());
    expect(panel()).not.toBeNull();

    // Pinned means the pointer leaving no longer retracts it.
    fireEvent.pointerLeave(openButton(), { pointerType: 'mouse' });
    settleHover();
    expect(panel()).not.toBeNull();
  });

  it('closes on Escape', () => {
    render(flyout());

    fireEvent.click(openButton());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(panel()).toBeNull();
  });

  it('closes when a navigation lands on a new path', () => {
    const { rerender } = render(flyout());

    fireEvent.click(openButton());
    expect(panel()).not.toBeNull();

    pathname.value = '/some/other-page';
    rerender(flyout('/some/other-page'));
    expect(panel()).toBeNull();
  });

  it('closes when the viewport widens far enough for the rail to take over', () => {
    const { rerender } = render(flyout());

    fireEvent.click(openButton());
    expect(panel()).not.toBeNull();

    rail.matches = true;
    rerender(flyout());
    expect(panel()).toBeNull();
  });

  it('shows nothing on a route the provider disables', () => {
    render(
      <SidebarFlyoutProvider path="/some/page" enabled={false}>
        <SidebarFlyoutTrigger />
      </SidebarFlyoutProvider>,
    );

    expect(openButtons()).toHaveLength(0);
  });

  it('gives two triggers one shared panel rather than one each', () => {
    // The app header and the compact page header both carry a trigger, and
    // both are mounted while scrolled. Two panels would stack pixel-for-
    // pixel, so dismissing the visible one would leave the other behind.
    render(flyout('/some/page', 2));

    const [headerTrigger, compactTrigger] = openButtons();
    fireEvent.click(headerTrigger);
    expect(panels()).toHaveLength(1);

    // The second trigger reports the same state and closes what the first
    // opened — an outside-pointerdown on a trigger must not fight its click.
    expect(compactTrigger.getAttribute('aria-expanded')).toBe('true');
    fireEvent.pointerDown(compactTrigger);
    fireEvent.click(compactTrigger);
    expect(panels()).toHaveLength(0);
  });
});
