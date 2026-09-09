'use client';

import { m } from '@paraglide/messages.js';
import { PanelLeft } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useMediaQuery } from '@/lib/use-media-query';
import { cn } from '@/lib/utils';
import { SIDEBAR_RAIL_QUERY, SidebarBody } from './sidebar-body';
import { SIDEBAR_SCROLLER_ATTR } from './sidebar-scroll';

/**
 * How long the panel survives the pointer leaving it or a trigger. The two
 * are not DOM siblings — a trigger sits in a header and the panel is
 * portalled to `<body>` — so no shared ancestor can hover-group them, and
 * crossing the gap between them fires `pointerleave` before `pointerenter`.
 * This grace window is that bridge.
 */
const HOVER_CLOSE_GRACE_MS = 200;

/**
 * `closed` / `hover` / `pinned` rather than a boolean: the panel a pointer
 * opened must retract when the pointer leaves, while the one a click opened
 * must stay until it is dismissed, and only the hover-opened one skips the
 * focus move — pointing at an icon is not a request to be taken there.
 */
type Mode = 'closed' | 'hover' | 'pinned';

interface SidebarFlyoutControls {
  open: boolean;
  toggle: () => void;
  hoverOpen: () => void;
  scheduleClose: () => void;
  cancelClose: () => void;
  /** Ref callback every trigger passes to its button — see `triggers` below. */
  registerTrigger: (element: HTMLElement | null) => (() => void) | undefined;
}

const SidebarFlyoutContext = createContext<SidebarFlyoutControls | null>(null);

/**
 * Owns the one flyout panel and the open state every trigger shares.
 *
 * There is more than one place a trigger belongs — the app header, and the
 * compact page header that replaces it on scroll — and they must not each
 * carry their own panel: two panels can both be open at once (hovering the
 * second while the first is pinned), stacked pixel-for-pixel, so dismissing
 * the one you see leaves the other behind. Hoisting the state to a provider
 * above both headers keeps a single panel with a single answer to "is it
 * open".
 *
 * `enabled` mirrors the rail's own visibility rule: on routes with no
 * sidebar the context is absent, and `SidebarFlyoutTrigger` renders nothing
 * rather than each caller having to repeat the condition.
 */
export function SidebarFlyoutProvider({ path, enabled, children }: { path: string; enabled: boolean; children: React.ReactNode }) {
  const pathname = usePathname();
  const railVisible = useMediaQuery(SIDEBAR_RAIL_QUERY);
  const [mode, setMode] = useState<Mode>('closed');
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Every mounted trigger's element. The panel dismisses itself on an
  // outside pointerdown, and a trigger is exactly the place where that
  // would fight the trigger's own click — close, then reopen, so the
  // control could never shut the panel it opened.
  const triggers = useRef(new Set<HTMLElement>());
  // Kept out of the `controls` memo below so a hover does not hand every
  // mounted trigger a new ref identity (which React answers by detaching
  // and reattaching each one). The returned cleanup is React 19's ref
  // teardown: it runs with the element still in scope, so removal needs no
  // guess about which entry is going away.
  const registerTrigger = useCallback((element: HTMLElement | null) => {
    // React does not pass `null` to a ref callback that returns a cleanup,
    // but the type still permits it for callbacks that do not.
    if (element === null) return;
    triggers.current.add(element);
    return () => {
      triggers.current.delete(element);
    };
  }, []);

  // Following a link inside the panel navigates underneath it; leaving it
  // open over the page just arrived at reads as the click not having
  // worked. Adjusting during render rather than in an effect keeps this to
  // one commit (same pattern as `RevisionDiff`'s pair reset).
  const [seenPathname, setSeenPathname] = useState(pathname);
  if (seenPathname !== pathname) {
    setSeenPathname(pathname);
    if (mode !== 'closed') setMode('closed');
  }

  // Widening past the breakpoint hands navigation back to the rail and takes
  // the triggers away with it (they are CSS-hidden, which is what keeps the
  // desktop first paint free of a flash of them). Without this the panel
  // would linger as an open-but-invisible dialog behind the rail.
  if (railVisible && mode !== 'closed') {
    setMode('closed');
  }

  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      // A click that landed during the grace window has already promoted the
      // panel to `pinned`; only a still-hovering one is ours to close.
      setMode((current) => (current === 'hover' ? 'closed' : current));
    }, HOVER_CLOSE_GRACE_MS);
  }, [cancelClose]);

  useEffect(() => {
    return () => {
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    };
  }, []);

  const controls = useMemo<SidebarFlyoutControls>(
    () => ({
      open: mode !== 'closed',
      // Only a pinned panel toggles shut — a click on one the pointer
      // opened means "keep this", not "undo that".
      toggle: () => {
        cancelClose();
        setMode((current) => (current === 'pinned' ? 'closed' : 'pinned'));
      },
      hoverOpen: () => {
        cancelClose();
        setMode((current) => (current === 'closed' ? 'hover' : current));
      },
      scheduleClose,
      cancelClose,
      registerTrigger,
    }),
    [mode, cancelClose, scheduleClose, registerTrigger],
  );

  // `enabled` flips on any navigation into or out of `/_edit` / `/_history`,
  // so it must not change the shape of what this returns: swapping the
  // returned element's type would unmount and remount the whole (auth) shell
  // beneath it — including the Toaster that is mounted at this level
  // precisely so an editor rerender cannot drop in-flight notifications.
  // Children stay the first child of the same provider either way.
  return (
    <SidebarFlyoutContext.Provider value={enabled ? controls : null}>
      {children}
      {enabled && (
        <Sheet
          open={mode !== 'closed'}
          modal={false}
          // Radix only ever reports a close here: the opening path runs through
          // `DialogTrigger`, and neither trigger is one (see `triggers` above).
          onOpenChange={() => {
            cancelClose();
            setMode('closed');
          }}
        >
          <SheetContent
            side="left"
            aria-describedby={undefined}
            onPointerEnter={cancelClose}
            onPointerLeave={(event) => {
              if (event.pointerType !== 'mouse') return;
              scheduleClose();
            }}
            onPointerDownOutside={(event) => {
              const target = event.target as Node | null;
              if (target === null) return;
              for (const el of triggers.current) {
                if (el.contains(target)) {
                  event.preventDefault();
                  return;
                }
              }
            }}
            // Pointing at an icon must not pull focus out of whatever the
            // reader was doing. Nothing is needed on the close side: with no
            // Radix trigger registered there is no element it would restore
            // focus to.
            onOpenAutoFocus={(event) => {
              if (mode === 'hover') event.preventDefault();
            }}
            // Detached panel rather than a flush-to-the-edge drawer: inset from
            // the viewport on every side, rounded, and carrying the shared
            // popover shadow, so it reads as floating above the page instead of
            // being part of its chrome. Height follows the content up to what
            // the viewport leaves, and the tree scrolls inside past that —
            // `min-h-0` on the scroller because a flex child otherwise refuses
            // to shrink below its content and would overflow the rounded frame.
            className="top-20 bottom-auto left-3 h-auto max-h-[calc(100vh-6.5rem)] w-64 max-w-[calc(100vw-1.5rem)] gap-0 overflow-hidden rounded-xl border p-0"
          >
            {/* Gives the corner ✕ a row of its own — on touch a trigger sits
              underneath the panel, so that button is the reachable way back. */}
            <div className="flex h-12 shrink-0 items-center border-b px-4">
              <SheetTitle className="text-sm font-medium text-muted-foreground">{m['sidebar.flyout_title']()}</SheetTitle>
            </div>
            <div
              // Same contract as the rail: the tree scrolls its own container to
              // keep the current node in view, and finds it by this attribute.
              {...{ [SIDEBAR_SCROLLER_ATTR]: '' }}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3"
            >
              <SidebarBody path={path} />
            </div>
          </SheetContent>
        </Sheet>
      )}
    </SidebarFlyoutContext.Provider>
  );
}

/**
 * The control that brings the sidebar back below the rail breakpoint.
 *
 * `PageSidebar`'s rail needs room beside the centred column and hides under
 * 1440px — which is most laptops — leaving the nav links and the hierarchy
 * tree with no way back. This puts them one hover (or tap) away.
 *
 * `compact` sizes it for the 60px scrolled page-header bar, where it sits
 * beside that bar's scroll-to-top button; the default size matches the app
 * header's other icon buttons. Renders nothing outside a provider, i.e. on
 * routes that have no sidebar to open.
 */
export function SidebarFlyoutTrigger({ compact = false, className }: { compact?: boolean; className?: string }) {
  const controls = useContext(SidebarFlyoutContext);
  if (controls === null) return null;
  // Destructured rather than read as `controls.x` in the JSX below: passing
  // `controls.registerTrigger` straight into `ref=` makes the compiler's ref
  // analysis treat every other read off `controls` as a ref access during
  // render too.
  const { open, toggle, hoverOpen, scheduleClose, registerTrigger } = controls;

  return (
    <button
      ref={registerTrigger}
      type="button"
      aria-label={m['sidebar.toggle']()}
      aria-expanded={open}
      aria-haspopup="dialog"
      onClick={toggle}
      onPointerEnter={(event) => {
        // Touch fires `pointerenter` immediately before `click`, so without
        // this gate a tap would open on enter and the click would toggle it
        // straight back shut.
        if (event.pointerType !== 'mouse') return;
        hoverOpen();
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== 'mouse') return;
        scheduleClose();
      }}
      className={cn(
        'min-[1440px]:hidden shrink-0 flex items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
        compact ? 'p-1.5' : 'h-9 w-9',
        className,
      )}
    >
      <PanelLeft className={compact ? 'h-4 w-4' : 'h-5 w-5'} />
    </button>
  );
}
