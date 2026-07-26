import type { PresenceViewer } from '@crowi/api-contract';
import { overwriteGetLocale } from '@paraglide/runtime.js';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { matchMediaImpl } from '@/lib/test-utils/mocks';
import type { PresenceStatus, UsePresenceResult } from '@/lib/use-presence';
import { LivePresenceRow } from './live-presence-row';
import { MobilePresenceCard } from './mobile-presence-card';

// `LivePresenceRow` now takes the `usePresence` result as a prop (hoisted
// to the parent so the expanded + compact rows share one WebSocket), so
// the test feeds it presence values directly — no hook mock required.

function viewer(userId: string, overrides: Partial<PresenceViewer> = {}): PresenceViewer {
  return {
    userId,
    username: userId,
    displayName: `User ${userId}`,
    avatarUrl: null,
    isEditing: false,
    joinedAt: 1_000,
    ...overrides,
  };
}

function makePresence(
  viewers: PresenceViewer[],
  selfUserId: string | null,
  status: PresenceStatus = 'connected',
  hasViewersForConnection = true,
): UsePresenceResult {
  return { viewers, selfUserId, status, pageUpdatedSeq: { current: 0 }, hasViewersForConnection };
}

afterEach(() => {
  cleanup();
});

describe('LivePresenceRow', () => {
  // The row wrapper always renders (it reserves a fixed height to avoid
  // layout shift); only its *content* is conditional.
  // live-presence-row is a layout-reservation div with no accessible role;
  // getByTestId is used to reach it for childElementCount checks.
  it('reserves the row but shows no content when the only viewer is the current user', () => {
    render(<LivePresenceRow presence={makePresence([viewer('me')], 'me')} />);
    expect(screen.getByTestId('live-presence-row').childElementCount).toBe(0);
  });

  it('reserves the row but shows no content when there are no viewers at all', () => {
    render(<LivePresenceRow presence={makePresence([], 'me')} />);
    expect(screen.getByTestId('live-presence-row').childElementCount).toBe(0);
  });

  it('reserves the row but shows no content when the presence WebSocket is in error state', () => {
    // Even with other viewers present, an error status hides the
    // content so the rest of the page degrades gracefully.
    render(<LivePresenceRow presence={makePresence([viewer('me'), viewer('alice')], 'me', 'error')} />);
    expect(screen.getByTestId('live-presence-row').childElementCount).toBe(0);
  });

  it('renders content in the row when another viewer is present', () => {
    render(<LivePresenceRow presence={makePresence([viewer('me'), viewer('alice')], 'me')} />);
    expect(screen.getByTestId('live-presence-row').childElementCount).toBeGreaterThan(0);
  });

  it('renders the editing badge for a viewer with the editor open', () => {
    render(<LivePresenceRow presence={makePresence([viewer('me'), viewer('alice', { isEditing: true })], 'me')} />);
    // The ✏️ corner badge carries role="img" and an aria-label with the editing
    // user's display name. BoringAvatar SVGs also have role="img" but carry no
    // accessible name, so filtering by name=/.+/ isolates the editing badges.
    const badges = screen.getAllByRole('img', { name: /.+/ });
    expect(badges.length).toBeGreaterThan(0);
    expect(badges.some((b) => /User alice/.test(b.getAttribute('aria-label') ?? ''))).toBe(true);
  });

  it('renders no editing badge when nobody is editing', () => {
    render(<LivePresenceRow presence={makePresence([viewer('me'), viewer('alice')], 'me')} />);
    // Editing badges are the only role="img" elements with an accessible name;
    // BoringAvatar SVGs have role="img" but no aria-label. When nobody edits,
    // no named img role element exists.
    expect(screen.queryAllByRole('img', { name: /.+/ })).toHaveLength(0);
  });

  it('folds surplus viewers into a [+N] overflow button', () => {
    // 5 inline avatars max → 8 viewers leaves 3 in overflow.
    const viewers = ['me', 'a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => viewer(id));
    render(<LivePresenceRow presence={makePresence(viewers, 'me')} />);
    // The overflow trigger is labelled with the hidden count.
    expect(screen.getByText('+3')).toBeTruthy();
  });

  it('does not render a [+N] button when viewers fit inline', () => {
    const viewers = ['me', 'a', 'b'].map((id) => viewer(id));
    render(<LivePresenceRow presence={makePresence(viewers, 'me')} />);
    expect(screen.queryByText(/^\+\d+$/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// MobilePresenceCard — feature-mobile-presence-card
// ---------------------------------------------------------------------------

/** Fires the track's own filtered `transitionend` (element + property). */
function fireTrackTransitionEnd() {
  fireEvent.transitionEnd(screen.getByTestId('mobile-presence-card-slot'), { propertyName: 'grid-template-rows' });
}

function trackClassName() {
  return screen.getByTestId('mobile-presence-card-slot').className;
}

function cardButton() {
  return screen.queryByRole('button', { name: /viewing now|閲覧中/ });
}

/** Advances the fake clock inside `act()` — a bare `vi.advanceTimersByTime`
 * fires the `setTimeout` callback (and any `setLifecycle` it calls)
 * outside React's batching, so the resulting DOM update is not guaranteed
 * to have flushed by the time the next assertion runs. */
function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** Makes `useMediaQuery('(prefers-reduced-motion: reduce)')` report a match,
 * so the card takes its synchronous no-animation path. */
function mockReducedMotion() {
  return vi.spyOn(window, 'matchMedia').mockImplementation(matchMediaImpl((query) => query.includes('prefers-reduced-motion')));
}

/** Flow height the mocked card slot reports while expanded. */
const SLOT_HEIGHT = 88;

/**
 * jsdom reports an all-zero rect for every element, so the card's
 * measure-before/measure-after scroll compensation would always see a
 * zero delta. Give the slot a real geometry: `SLOT_HEIGHT` while its
 * track carries the expanded (`grid-rows-[1fr]`) class, 0 while
 * collapsed, anchored at `slotTop` px from the viewport top. Returns the
 * `window.scrollBy` spy the compensation is expected to call.
 *
 * `nativeAnchoring` models a Blink/Gecko engine that already adjusted the
 * scroll offset for the height change (WebKit — iOS Safari — does not):
 * the slot's bottom edge, i.e. the flow position of the body below it,
 * stays put and its top edge moves instead.
 */
function mockSlotGeometry(slotTop: number, { nativeAnchoring = false }: { nativeAnchoring?: boolean } = {}) {
  const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
  const emptyRect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function getRect(this: Element): DOMRect {
    const el = this as HTMLElement;
    if (el.dataset?.testid !== 'mobile-presence-card-slot') return emptyRect;
    const height = el.className.includes('grid-rows-[1fr]') ? SLOT_HEIGHT : 0;
    const top = nativeAnchoring ? slotTop - height : slotTop;
    return { ...emptyRect, top, bottom: top + height, height, y: top } as DOMRect;
  });
  return scrollBy;
}

describe('MobilePresenceCard', () => {
  // The two presence shapes every lifecycle test toggles between: the
  // self-only state that collapses the card away, and the "someone else is
  // here too" state that expands it.
  const selfOnly = makePresence([viewer('me')], 'me');
  const withOther = makePresence([viewer('me'), viewer('alice')], 'me');

  beforeEach(() => {
    vi.useFakeTimers();
    overwriteGetLocale(() => 'ja');
  });

  afterEach(() => {
    act(() => {
      vi.runOnlyPendingTimers();
    });
    vi.useRealTimers();
    vi.restoreAllMocks();
    cleanup();
  });

  describe('default variant', () => {
    it('self-only collapse: does not render the card button when the only viewer is self', () => {
      render(<MobilePresenceCard presence={selfOnly} />);
      expect(cardButton()).toBeNull();
    });

    it('shows the card with 2 viewers (self + 1 other)', () => {
      render(<MobilePresenceCard presence={withOther} />);
      expect(cardButton()).toBeTruthy();
      expect(screen.getByText('2 人が現在閲覧中')).toBeTruthy();
    });

    it('shows the natural-language count for 4+ viewers, self included', () => {
      const viewers = ['me', 'a', 'b', 'c'].map((id) => viewer(id));
      render(<MobilePresenceCard presence={makePresence(viewers, 'me')} />);
      expect(screen.getByText('4 人が現在閲覧中')).toBeTruthy();
    });

    it('caps avatars at 3 and folds the rest into a non-interactive +N badge', () => {
      const viewers = ['me', 'a', 'b', 'c', 'd'].map((id) => viewer(id));
      render(<MobilePresenceCard presence={makePresence(viewers, 'me')} />);
      // +2 overflow (5 viewers - 3 shown). Decorative — no button/role.
      expect(screen.getByText('+2')).toBeTruthy();
    });

    it('renders the editing badge for a viewer with the editor open', () => {
      render(<MobilePresenceCard presence={makePresence([viewer('me'), viewer('alice', { isEditing: true })], 'me')} />);
      // The avatar stack is `aria-hidden` (spec: decorative — the button's
      // own accessible name is the only thing that must be announced), so
      // the badge must be looked up with `hidden: true` to opt back into
      // the aria-hidden subtree rather than asserting it is reachable via
      // the normal accessibility tree.
      const badges = screen.getAllByRole('img', { name: /.+/, hidden: true });
      expect(badges.some((b) => /User alice/.test(b.getAttribute('aria-label') ?? ''))).toBe(true);
    });

    it('renders the ja count text by default and the en count text under the en locale', () => {
      const { unmount } = render(<MobilePresenceCard presence={withOther} />);
      expect(screen.getByText('2 人が現在閲覧中')).toBeTruthy();
      unmount();

      overwriteGetLocale(() => 'en');
      render(<MobilePresenceCard presence={withOther} />);
      expect(screen.getByText('2 viewing now')).toBeTruthy();
    });

    it('shows Live (color + text) when connected and this connection has received a viewers frame', () => {
      render(<MobilePresenceCard presence={makePresence([viewer('me'), viewer('alice')], 'me', 'connected', true)} />);
      expect(screen.getByText('Live')).toBeTruthy();
    });

    it('shows neutral "Reconnecting…" text (not Live) while reconnecting, keeping the last known viewers', () => {
      render(<MobilePresenceCard presence={makePresence([viewer('me'), viewer('alice')], 'me', 'reconnecting', false)} />);
      expect(cardButton()).toBeTruthy();
      expect(screen.getByText('再接続中…')).toBeTruthy();
      expect(screen.queryByText('Live')).toBeNull();
    });

    it('shows neutral "Reconnecting…" text while connecting (retry attempt) too', () => {
      render(<MobilePresenceCard presence={makePresence([viewer('me'), viewer('alice')], 'me', 'connecting', false)} />);
      expect(cardButton()).toBeTruthy();
      expect(screen.getByText('再接続中…')).toBeTruthy();
    });

    it('collapses (exits) on a terminal error, even with other viewers present', () => {
      const { rerender } = render(<MobilePresenceCard presence={makePresence([viewer('me'), viewer('alice')], 'me', 'connected', true)} />);
      expect(cardButton()).toBeTruthy();

      rerender(<MobilePresenceCard presence={makePresence([viewer('me'), viewer('alice')], 'me', 'error', false)} />);
      // Exit is animated (not instant) — advance past the fallback window.
      advance(300);
      expect(cardButton()).toBeNull();
    });

    it('opens the viewer Sheet on tap, listing every current viewer', () => {
      render(<MobilePresenceCard presence={withOther} />);
      const button = cardButton();
      if (!button) throw new Error('expected the card button to render');
      fireEvent.click(button);
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByText('User alice')).toBeTruthy();
    });

    it('AC: false->true before the 200ms exit completes does not unmount the still-visible card (generation guard)', () => {
      const { rerender } = render(<MobilePresenceCard presence={withOther} />);
      expect(cardButton()).toBeTruthy();

      // Self-only — exit starts (mounted stays true, visible flips false).
      rerender(<MobilePresenceCard presence={selfOnly} />);
      expect(cardButton()).toBeTruthy(); // still mounted mid-exit
      expect(trackClassName()).toContain('grid-rows-[0fr]');

      // Another viewer re-joins before the exit transition would ever
      // settle (no timer advanced, no transitionend fired) — must stay
      // mounted and flip back to the expanded track size.
      rerender(<MobilePresenceCard presence={withOther} />);
      expect(cardButton()).toBeTruthy();
      expect(trackClassName()).toContain('grid-rows-[1fr]');

      // No stray unmount even once the ORIGINAL fallback window would
      // have elapsed.
      advance(300);
      expect(cardButton()).toBeTruthy();
    });

    it('filters transitionend by property — an unrelated property on the track does not complete the exit', () => {
      const { rerender } = render(<MobilePresenceCard presence={withOther} />);
      rerender(<MobilePresenceCard presence={selfOnly} />);
      expect(cardButton()).toBeTruthy();

      fireEvent.transitionEnd(screen.getByTestId('mobile-presence-card-slot'), { propertyName: 'opacity' });
      expect(cardButton()).toBeTruthy(); // not unmounted by the wrong property

      // The fallback timer was not cleared by the filtered event, so the
      // exit still completes once it elapses.
      advance(300);
      expect(cardButton()).toBeNull();
    });

    it('filters transitionend by target — a bubbled transitionend from a descendant does not complete the exit', () => {
      const { rerender } = render(<MobilePresenceCard presence={withOther} />);
      rerender(<MobilePresenceCard presence={selfOnly} />);
      const button = cardButton();
      if (!button) throw new Error('expected the card button to still be mounted mid-exit');

      fireEvent.transitionEnd(button, { propertyName: 'grid-template-rows' });
      expect(cardButton()).toBeTruthy(); // target mismatch — no-op

      advance(300);
      expect(cardButton()).toBeNull();
    });

    it('completes the exit immediately on the correctly filtered transitionend, without waiting for the fallback timer', () => {
      const { rerender } = render(<MobilePresenceCard presence={withOther} />);
      rerender(<MobilePresenceCard presence={selfOnly} />);
      expect(cardButton()).toBeTruthy();

      fireTrackTransitionEnd();
      expect(cardButton()).toBeNull();
    });

    it('a fallback timer completes the exit when transitionend never fires', () => {
      const { rerender } = render(<MobilePresenceCard presence={withOther} />);
      rerender(<MobilePresenceCard presence={selfOnly} />);
      expect(cardButton()).toBeTruthy();

      advance(279);
      expect(cardButton()).toBeTruthy();
      advance(1);
      expect(cardButton()).toBeNull();
    });

    it('JS-detected reduced motion unmounts synchronously on exit, without a timer or transitionend', () => {
      const matchMediaSpy = mockReducedMotion();

      const { rerender } = render(<MobilePresenceCard presence={withOther} />);
      expect(cardButton()).toBeTruthy();

      rerender(<MobilePresenceCard presence={selfOnly} />);
      // No `vi.advanceTimersByTime` — reduced motion must unmount
      // synchronously, in the same render pass as the visibility flip.
      expect(cardButton()).toBeNull();

      matchMediaSpy.mockRestore();
    });
  });

  // The reading position the AC protects is in the BODY, which is always
  // below this slot — so the compensation must run whenever the slot's
  // height change displaces on-screen body content, INCLUDING while the
  // card itself is visible. (The earlier implementation skipped any
  // viewport-intersecting slot, which let the paragraph a reader was on
  // jump by the slot height whenever the card was partly on screen.)
  describe('default variant — reading-position compensation', () => {
    it('scrolls by the slot delta when the card enters while the reader has scrolled past it', () => {
      const scrollBy = mockSlotGeometry(-400);
      const { rerender } = render(<MobilePresenceCard presence={selfOnly} />);

      rerender(<MobilePresenceCard presence={withOther} />);
      fireTrackTransitionEnd();

      expect(scrollBy).toHaveBeenCalledWith(0, SLOT_HEIGHT);
    });

    it('scrolls back by the slot delta when the card exits', () => {
      const scrollBy = mockSlotGeometry(-400);
      const { rerender } = render(<MobilePresenceCard presence={withOther} />);

      rerender(<MobilePresenceCard presence={selfOnly} />);
      fireTrackTransitionEnd();

      expect(scrollBy).toHaveBeenCalledWith(0, -SLOT_HEIGHT);
    });

    it('compensates even when the card is only PARTLY scrolled out of view', () => {
      const scrollBy = mockSlotGeometry(-20);
      const { rerender } = render(<MobilePresenceCard presence={selfOnly} />);

      rerender(<MobilePresenceCard presence={withOther} />);
      fireTrackTransitionEnd();

      expect(scrollBy).toHaveBeenCalledWith(0, SLOT_HEIGHT);
    });

    it('compensates when the card is fully visible but body content below it is on screen', () => {
      const scrollBy = mockSlotGeometry(120);
      const { rerender } = render(<MobilePresenceCard presence={selfOnly} />);

      rerender(<MobilePresenceCard presence={withOther} />);
      fireTrackTransitionEnd();

      expect(scrollBy).toHaveBeenCalledWith(0, SLOT_HEIGHT);
    });

    it('does not scroll when the slot starts below the fold — nothing on screen moves', () => {
      // jsdom's default `window.innerHeight` is 768.
      const scrollBy = mockSlotGeometry(window.innerHeight + 40);
      const { rerender } = render(<MobilePresenceCard presence={selfOnly} />);

      rerender(<MobilePresenceCard presence={withOther} />);
      fireTrackTransitionEnd();

      expect(scrollBy).not.toHaveBeenCalled();
    });

    it('does not double-compensate when the engine already scroll-anchored the change', () => {
      const scrollBy = mockSlotGeometry(-400, { nativeAnchoring: true });
      const { rerender } = render(<MobilePresenceCard presence={selfOnly} />);

      rerender(<MobilePresenceCard presence={withOther} />);
      fireTrackTransitionEnd();

      expect(scrollBy).not.toHaveBeenCalled();
    });

    it('compensates via the fallback timer when transitionend never fires', () => {
      const scrollBy = mockSlotGeometry(-400);
      const { rerender } = render(<MobilePresenceCard presence={selfOnly} />);

      rerender(<MobilePresenceCard presence={withOther} />);
      advance(300);

      expect(scrollBy).toHaveBeenCalledWith(0, SLOT_HEIGHT);
    });

    it('does not compensate under reduced motion (the unmount is synchronous — no transition to correct)', () => {
      const scrollBy = mockSlotGeometry(-400);
      mockReducedMotion();

      const { rerender } = render(<MobilePresenceCard presence={withOther} />);
      rerender(<MobilePresenceCard presence={selfOnly} />);
      advance(300);

      expect(scrollBy).not.toHaveBeenCalled();
    });
  });

  describe('compact variant', () => {
    it('renders nothing when self-only', () => {
      const { container } = render(<MobilePresenceCard presence={selfOnly} variant="compact" />);
      expect(container.firstChild).toBeNull();
    });

    it('shows a Live · N trigger when connected and Live-eligible', () => {
      render(<MobilePresenceCard presence={makePresence([viewer('me'), viewer('alice')], 'me', 'connected', true)} variant="compact" />);
      expect(screen.getByText('Live')).toBeTruthy();
      expect(screen.getByText('2')).toBeTruthy();
    });

    it('shows a neutral N trigger (no Live text) while reconnecting', () => {
      render(<MobilePresenceCard presence={makePresence([viewer('me'), viewer('alice')], 'me', 'reconnecting', false)} variant="compact" />);
      expect(screen.queryByText('Live')).toBeNull();
      expect(screen.getByText('2')).toBeTruthy();
    });

    it('opens the viewer Sheet on tap', () => {
      render(<MobilePresenceCard presence={withOther} variant="compact" />);
      fireEvent.click(screen.getByRole('button'));
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByText('User alice')).toBeTruthy();
    });
  });
});
