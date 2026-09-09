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
 * `closed` / `hover` / `pinned` rather than a boolean: the panel that a
 * pointer opened must retract when the pointer leaves, while the one a
 * click opened must stay until it is dismissed, and only the hover-opened
 * one may skip the focus move (hovering must not steal focus, and hovering
 * away must not paint a focus ring on the trigger).
 */
type Mode = 'closed' | 'hover' | 'pinned';

interface SidebarFlyoutControls {
  open: boolean;
  toggle: () => void;
  hoverOpen: () => void;
  scheduleClose: () => void;
  cancelClose: () => void;
  /** Ref callback every trigger passes to its button — see `triggers` below. */
  registerTrigger: (element: HTMLElement | null) => void;
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
  // Read by Radix's focus callbacks, which fire after `mode` has already
  // moved on (it is `closed` by the time the close handler runs), so the
  // "was this a hover?" answer has to outlive the state it came from.
  const hoverOpened = useRef(false);
  // Every mounted trigger's element. The panel dismisses itself on an
  // outside pointerdown, and a trigger is exactly the place where that
  // would fight the trigger's own click — close, then reopen, so the
  // control could never shut the panel it opened.
  const triggers = useRef(new Set<HTMLElement>());

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
      toggle: () => {
        cancelClose();
        setMode((current) => {
          // A click on a panel the pointer opened means "keep this", not
          // "toggle it shut".
          if (current === 'hover') {
            hoverOpened.current = false;
            return 'pinned';
          }
          if (current === 'pinned') return 'closed';
          hoverOpened.current = false;
          return 'pinned';
        });
      },
      hoverOpen: () => {
        cancelClose();
        setMode((current) => {
          if (current !== 'closed') return current;
          hoverOpened.current = true;
          return 'hover';
        });
      },
      scheduleClose,
      cancelClose,
      registerTrigger: (element) => {
        // A ref callback fires with the element on mount and `null` on
        // unmount, so the set only ever holds triggers that are on the page.
        if (element) triggers.current.add(element);
        else for (const el of triggers.current) if (!el.isConnected) triggers.current.delete(el);
      },
    }),
    [mode, cancelClose, scheduleClose],
  );

  if (!enabled) return children;

  return (
    <SidebarFlyoutContext.Provider value={controls}>
      {children}
      <Sheet
        open={mode !== 'closed'}
        modal={false}
        onOpenChange={(next) => {
          cancelClose();
          // Only an open clears the flag — a click-open is never a hover. On
          // a close it has to survive until `onCloseAutoFocus` reads it, or
          // Esc out of a hover-opened panel would restore focus to a trigger
          // and leave a focus ring on an icon the user only pointed at.
          if (next) hoverOpened.current = false;
          setMode(next ? 'pinned' : 'closed');
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
          onOpenAutoFocus={(event) => {
            if (hoverOpened.current) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            if (hoverOpened.current) event.preventDefault();
          }}
          // Detached panel rather than a flush-to-the-edge drawer: inset from
          // the viewport on every side, rounded, and carrying the shared
          // popover shadow, so it reads as floating above the page instead of
          // being part of its chrome. Height follows the content up to what
          // the viewport leaves, and the tree scrolls inside past that —
          // `min-h-0` on the scroller because a flex child otherwise refuses
          // to shrink below its content and would overflow the rounded frame.
          className="min-[1440px]:hidden top-20 bottom-auto left-3 h-auto max-h-[calc(100vh-6.5rem)] w-64 max-w-[calc(100vw-1.5rem)] gap-0 overflow-hidden rounded-xl border p-0"
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
