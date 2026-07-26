'use client';

import { Eye } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { m } from '@paraglide/messages.js';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { applyVisibility, completeExit, createExitLifecycleState, type ExitLifecycleState } from '@/lib/presence-card-exit';
import { applyScrollCompensation, computeScrollCompensation, measureSlot, shouldCompensate, type SlotMeasurement } from '@/lib/preserve-scroll-anchor';
import { useForceCloseable } from '@/lib/use-force-closeable';
import { useMediaQuery } from '@/lib/use-media-query';
import type { UsePresenceResult } from '@/lib/use-presence';
import { cn } from '@/lib/utils';
import { PresenceAvatarVisual, PresenceViewerList } from './live-presence-row';

/**
 * feature-mobile-presence-card — the mobile (< 768px) live-presence UI.
 *
 * Two variants sharing this one component (see spec §"やること" / §"接続
 * 状態と可視性" / §"self-only の折りたたみと安定したレイアウト"):
 *
 *   - `default` — placed right after `MetaChipRow` in the expanded mobile
 *     header. A single ≥48px button: up to {@link MAX_MOBILE_AVATARS}
 *     avatars (decorative, `aria-hidden`) + `+N`, a self-inclusive
 *     natural-language count, and a Live/Reconnecting indicator that is
 *     never color-only. Tapping opens the (only) interactive surface —
 *     the viewer `Sheet`. Self-only collapses the WHOLE slot (card +
 *     divider + the margin that would otherwise come from the parent's
 *     `space-y-5`) via an animated `grid-template-rows` track, with an
 *     exit-lifecycle generation guard, a filtered `transitionend`, a
 *     generation-tagged fallback timer, and a JS-detected
 *     `prefers-reduced-motion` synchronous-unmount path (see
 *     `presence-card-exit.ts`). Off-screen enter/exit is compensated with
 *     `window.scrollBy` so the reader's scroll position never jumps (see
 *     `preserve-scroll-anchor.ts`).
 *   - `compact` — the short `Live · N` / neutral trigger inside the 60px
 *     sticky bar. No animation (the compact bar itself mounts/unmounts
 *     the whole row fresh every time it appears), just an immediate
 *     hide/show on self-only.
 *
 * Desktop (`md`+) is untouched — `LivePresenceRow` still owns that strip
 * (`hidden md:flex`), and this component is only ever rendered from
 * mobile-only (`md:hidden`) wrappers in `page-header.tsx`.
 */

/** Inline avatars before overflow folds into a non-interactive `+N` badge
 * — smaller than `LivePresenceRow`'s desktop `MAX_VISIBLE_AVATARS` (5):
 * this is a single compact button, not a wide strip. */
const MAX_MOBILE_AVATARS = 3;

/** Matches the `duration-200` CSS class on the animated track below. */
const EXIT_TRANSITION_MS = 200;
/** Safety margin over the CSS duration for the fallback timer / settle
 * timer, in case `transitionend` never fires (backgrounded tab, an
 * ancestor going `display: none` mid-transition, etc). */
const EXIT_FALLBACK_MS = EXIT_TRANSITION_MS + 80;

/** SSR snapshot is `false` (assume motion is fine) — `useMediaQuery`
 * corrects it on hydration if the user's OS preference says otherwise. */
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export type MobilePresenceCardVariant = 'default' | 'compact';

interface MobilePresenceCardProps {
  presence: UsePresenceResult;
  /** @default 'default' */
  variant?: MobilePresenceCardVariant;
  /**
   * feature-mobile-presence-card — force-closes the viewer Sheet while
   * `true`; see `useForceCloseable` for why a Portal-rendered overlay
   * needs this even though `PageHeader`'s placeholder already goes
   * `inert`. Meaningful for the `default` variant only: the `compact`
   * instance remounts fresh every time the sticky bar appears, so it
   * never carries stale open state across a transition.
   */
  forceClose?: boolean;
  /**
   * `default` variant only — fires whenever the self-only collapse
   * enter/exit CSS transition starts (`true`) or settles (`false`), so
   * `PageHeader` can freeze `useStickyHeader`'s compact threshold to the
   * transition-start `H` for the duration (the animating slot is itself
   * part of the expanded header's flow height).
   */
  onTransitionStateChange?: (transitioning: boolean) => void;
}

export function MobilePresenceCard({ presence, variant = 'default', forceClose = false, onTransitionStateChange }: MobilePresenceCardProps) {
  const { viewers, selfUserId, status, hasViewersForConnection } = presence;

  // The card exits (or never shows) both when nobody else is here AND
  // when the connection has terminally errored — an auto-retry in
  // progress (`'connecting'` / `'reconnecting'`) keeps showing the last
  // known viewers in a neutral state instead (spec §"接続状態と可視性").
  const hasOthers = status !== 'error' && viewers.some((v) => v.userId !== selfUserId);
  // `connected` alone only proves the transport handshake finished — the
  // green `Live` state also needs a viewers frame on THIS connection.
  const isLive = status === 'connected' && hasViewersForConnection;
  const statusLabel = isLive ? m['page.presence_card_live']() : m['page.presence_card_reconnecting']();
  const countText = m['page.presence_card_viewing_now']({ count: viewers.length });
  const ariaLabel = m['page.presence_card_aria']({ count: viewers.length, status: statusLabel });

  const visibleAvatars = viewers.slice(0, MAX_MOBILE_AVATARS);
  const overflowCount = viewers.length - visibleAvatars.length;

  const [sheetOpen, setSheetOpen] = useForceCloseable(forceClose);

  // The sheet body is identical for both variants — only the trigger
  // differs — so it is built once here and slotted into either branch.
  const viewerSheetContent = (
    <SheetContent side="bottom" aria-describedby={undefined}>
      <SheetHeader>
        <SheetTitle>{m['page.presence_sheet_title']()}</SheetTitle>
      </SheetHeader>
      <div className="max-h-[60vh] overflow-y-auto">
        <PresenceViewerList viewers={viewers} selfUserId={selfUserId} />
      </div>
    </SheetContent>
  );

  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);

  // --- exit-lifecycle + scroll-anchor state (default variant only; kept
  // hooked up unconditionally — see rules-of-hooks — but inert for
  // `compact`, which never renders the animated track). ---
  const [lifecycle, setLifecycleState] = useState<ExitLifecycleState>(() => createExitLifecycleState(hasOthers));
  // Mirrors `lifecycle` for synchronous reads from callbacks/effects
  // (timers, the transitionend handler) — written ONLY inside
  // `setLifecycle` below (never during render, which `react-hooks/refs`
  // forbids), in lockstep with the `setLifecycleState` call, so it never
  // drifts from the rendered state.
  const lifecycleRef = useRef<ExitLifecycleState>(lifecycle);
  const setLifecycle = useCallback((next: ExitLifecycleState) => {
    lifecycleRef.current = next;
    setLifecycleState(next);
  }, []);

  const trackRef = useRef<HTMLDivElement>(null);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const beforeMeasurementRef = useRef<SlotMeasurement | null>(null);
  const prevHasOthersRef = useRef(hasOthers);

  const onTransitionStateChangeRef = useRef(onTransitionStateChange);
  useEffect(() => {
    onTransitionStateChangeRef.current = onTransitionStateChange;
  });
  const notifyTransitioning = useCallback((value: boolean) => {
    onTransitionStateChangeRef.current?.(value);
  }, []);

  const settleScrollCompensation = useCallback(() => {
    const el = trackRef.current;
    const before = beforeMeasurementRef.current;
    beforeMeasurementRef.current = null;
    if (!el || !before || typeof window === 'undefined') return;
    const after = measureSlot(el);
    const delta = computeScrollCompensation(before, after);
    // The slot's top edge does not move (nothing above it changes), so the
    // pre-transition `top` is the geometry the whole transition happened
    // under — no second `getBoundingClientRect` needed here.
    if (shouldCompensate(before.top, delta, window.innerHeight)) {
      applyScrollCompensation(delta);
    }
  }, []);

  const clearPendingTimers = useCallback(() => {
    if (fallbackTimerRef.current !== null) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
    if (enterTimerRef.current !== null) {
      clearTimeout(enterTimerRef.current);
      enterTimerRef.current = null;
    }
  }, []);

  // React to `hasOthers` flips (self-only collapse toggling, or a
  // terminal `error` forcing an exit).
  useEffect(() => {
    if (prevHasOthersRef.current === hasOthers) return;
    prevHasOthersRef.current = hasOthers;

    if (trackRef.current) {
      // t=0 of this transition — before any animation frame has run, so
      // this equals the pre-transition (settled) height. See
      // `preserve-scroll-anchor.ts`'s module doc.
      beforeMeasurementRef.current = measureSlot(trackRef.current);
    }
    clearPendingTimers();

    const { state, scheduleFallback } = applyVisibility(lifecycleRef.current, hasOthers, reducedMotion);
    setLifecycle(state);

    if (reducedMotion) {
      // Synchronous — no CSS transition plays, nothing to settle later,
      // and no scroll compensation (spec explicitly excludes reduced
      // motion from the compensation path).
      beforeMeasurementRef.current = null;
      notifyTransitioning(false);
      return;
    }

    notifyTransitioning(true);
    if (scheduleFallback !== null) {
      // Exiting — generation-tagged fallback, the safety net behind the
      // filtered `transitionend` handler below.
      const generation = scheduleFallback;
      fallbackTimerRef.current = setTimeout(() => {
        fallbackTimerRef.current = null;
        setLifecycle(completeExit(lifecycleRef.current, generation));
        settleScrollCompensation();
        notifyTransitioning(false);
      }, EXIT_FALLBACK_MS);
    } else {
      // Entering — no unmount risk, so no generation guard is needed; a
      // plain timer (backed up by the same `transitionend` handler) is
      // enough to settle the scroll compensation and clear the freeze.
      enterTimerRef.current = setTimeout(() => {
        enterTimerRef.current = null;
        settleScrollCompensation();
        notifyTransitioning(false);
      }, EXIT_FALLBACK_MS);
    }
  }, [hasOthers, reducedMotion, clearPendingTimers, notifyTransitioning, settleScrollCompensation, setLifecycle]);

  // Unmount (page navigation) — cancel any pending timer; never settles
  // scroll compensation from here (spec: unmount is not compensated).
  useEffect(() => {
    return () => {
      clearPendingTimers();
    };
  }, [clearPendingTimers]);

  const handleTrackTransitionEnd = useCallback(
    (event: React.TransitionEvent<HTMLDivElement>) => {
      // Filtered: only the track's OWN `grid-template-rows` transition —
      // a bubbled transitionend from a descendant, or an unrelated
      // property, must never drive lifecycle/scroll-compensation logic.
      if (event.target !== trackRef.current || event.propertyName !== 'grid-template-rows') return;
      const wasExiting = fallbackTimerRef.current !== null;
      clearPendingTimers();
      if (wasExiting) {
        setLifecycle(completeExit(lifecycleRef.current, lifecycleRef.current.generation));
      }
      settleScrollCompensation();
      notifyTransitioning(false);
    },
    [clearPendingTimers, settleScrollCompensation, notifyTransitioning, setLifecycle],
  );

  if (variant === 'compact') {
    if (!hasOthers) return null;
    return (
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetTrigger
          className="inline-flex h-7 items-center gap-1.5 rounded-full bg-muted px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/70"
          aria-label={ariaLabel}
        >
          <span aria-hidden="true" className={cn('h-1.5 w-1.5 shrink-0 rounded-full', isLive ? 'bg-crowi-success' : 'bg-muted-foreground/50')} />
          {isLive && <span className="font-semibold text-crowi-success">{m['page.presence_card_live']()}</span>}
          <span aria-hidden="true">·</span>
          <Eye className="h-3.5 w-3.5" aria-hidden="true" />
          {viewers.length}
        </SheetTrigger>
        {viewerSheetContent}
      </Sheet>
    );
  }

  return (
    <div
      ref={trackRef}
      data-testid="mobile-presence-card-slot"
      // `mt-0!` cancels the parent `space-y-5`'s automatic top margin for
      // this child — that margin is moved INSIDE the track (the `pt-5`
      // below) so it animates as part of the same clipped track instead
      // of appearing/disappearing as a sudden 20px jump (spec
      // §"self-only の折りたたみと安定したレイアウト").
      className={cn(
        'mt-0! grid md:hidden transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none',
        lifecycle.visible ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
      )}
      onTransitionEnd={handleTrackTransitionEnd}
    >
      <div className="min-h-0 overflow-hidden">
        {lifecycle.mounted && (
          <div className="pt-5">
            <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
              <SheetTrigger asChild>
                <button
                  type="button"
                  aria-label={ariaLabel}
                  className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-border bg-secondary px-4 py-2.5 text-left text-foreground transition-colors hover:bg-secondary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="flex shrink-0 items-center -space-x-2" aria-hidden="true">
                    {visibleAvatars.map((viewer) => (
                      <span key={viewer.userId} className="rounded-full ring-2 ring-secondary">
                        <PresenceAvatarVisual viewer={viewer} />
                      </span>
                    ))}
                    {overflowCount > 0 && (
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground ring-2 ring-secondary">
                        +{overflowCount}
                      </span>
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{countText}</span>
                  <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium">
                    <span aria-hidden="true" className={cn('h-2 w-2 rounded-full', isLive ? 'bg-crowi-success' : 'bg-muted-foreground/50')} />
                    <span className={isLive ? 'text-crowi-success' : 'text-muted-foreground'}>{statusLabel}</span>
                  </span>
                </button>
              </SheetTrigger>
              {viewerSheetContent}
            </Sheet>
            <div className="mt-5 border-t border-border" data-testid="mobile-presence-card-divider" />
          </div>
        )}
      </div>
    </div>
  );
}
