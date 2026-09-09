'use client';

import { m } from '@paraglide/messages.js';
import { PanelLeft } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { useMediaQuery } from '@/lib/use-media-query';
import { SIDEBAR_RAIL_QUERY, SidebarBody } from './sidebar-body';
import { SIDEBAR_SCROLLER_ATTR } from './sidebar-scroll';

/**
 * How long the panel survives the pointer leaving it or the trigger. The
 * two are not DOM siblings — the trigger sits in the header and the panel
 * is portalled to `<body>` — so no shared ancestor can hover-group them,
 * and crossing the gap between them fires `pointerleave` before
 * `pointerenter`. This grace window is that bridge.
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

/**
 * Header control that brings the sidebar back below the rail breakpoint.
 *
 * `PageSidebar`'s rail needs room beside the centred column and hides under
 * 1440px — which is most laptops — leaving the nav links and the hierarchy
 * tree with no way back. This puts them one hover (or tap) away: the same
 * `SidebarBody`, in a panel that floats over the content instead of
 * displacing it.
 *
 * Non-modal on purpose. A hover-opened panel must not trap focus, lock
 * background scroll or dim the page — and Radix renders no overlay at all
 * when `modal={false}`, so nothing here has to suppress one. Esc,
 * dismiss-on-outside-pointerdown (with the trigger itself excluded, so its
 * click still toggles rather than closing and reopening), the portal and
 * focus restore all still come from Radix.
 */
export function SidebarFlyout({ path }: { path: string }) {
  const pathname = usePathname();
  const railVisible = useMediaQuery(SIDEBAR_RAIL_QUERY);
  const [mode, setMode] = useState<Mode>('closed');
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read by Radix's focus callbacks, which fire after `mode` has already
  // moved on (it is `closed` by the time the close handler runs), so the
  // "was this a hover?" answer has to outlive the state it came from.
  const hoverOpened = useRef(false);

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
  // the trigger away with it (both are CSS-hidden, which is what keeps the
  // desktop first paint free of a flash of this button). Without this the
  // panel would linger as an open-but-invisible dialog behind the rail.
  if (railVisible && mode !== 'closed') {
    setMode('closed');
  }

  const cancelClose = () => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      // A click that landed during the grace window has already promoted the
      // panel to `pinned`; only a still-hovering one is ours to close.
      setMode((current) => (current === 'hover' ? 'closed' : current));
    }, HOVER_CLOSE_GRACE_MS);
  };

  useEffect(() => {
    return () => {
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    };
  }, []);

  return (
    <Sheet
      open={mode !== 'closed'}
      modal={false}
      onOpenChange={(next) => {
        cancelClose();
        // Only an open clears the flag — a click-open is never a hover. On a
        // close it has to survive until `onCloseAutoFocus` reads it, or Esc
        // out of a hover-opened panel would restore focus to the trigger and
        // leave a focus ring on an icon the user only pointed at.
        if (next) hoverOpened.current = false;
        setMode(next ? 'pinned' : 'closed');
      }}
    >
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label={m['sidebar.toggle']()}
          onClick={(event) => {
            cancelClose();
            if (mode === 'hover') {
              // Radix would read this as "open → toggle shut". A click on a
              // panel the pointer opened means "keep it", so suppress the
              // toggle (Radix skips its own handler once the event is
              // default-prevented) and promote it instead.
              event.preventDefault();
              hoverOpened.current = false;
              setMode('pinned');
            }
          }}
          onPointerEnter={(event) => {
            // Touch fires `pointerenter` immediately before `click`, so
            // without this gate a tap would open on enter and the click
            // would toggle it straight back shut.
            if (event.pointerType !== 'mouse') return;
            cancelClose();
            setMode((current) => {
              if (current !== 'closed') return current;
              hoverOpened.current = true;
              return 'hover';
            });
          }}
          onPointerLeave={(event) => {
            if (event.pointerType !== 'mouse') return;
            scheduleClose();
          }}
          // Once the header's centred column has a gutter wide enough to
          // hold it (36px button + gap needs ~44px, which `max-w-4xl`'s
          // gutter reaches at about 950px), the button leaves the flow and
          // hangs off the left of the cluster, so the logo stays exactly
          // where it sits with no sidebar control at all. Narrower than
          // that there is nowhere to hang it without pushing it off-screen,
          // so it goes back in the flow and the logo shifts instead —
          // better a logo that moves than a control that cannot be reached.
          className="min-[1440px]:hidden flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground min-[960px]:absolute min-[960px]:top-1/2 min-[960px]:right-full min-[960px]:mr-1 min-[960px]:-translate-y-1/2"
        >
          <PanelLeft className="h-5 w-5" />
        </button>
      </SheetTrigger>

      <SheetContent
        side="left"
        aria-describedby={undefined}
        onPointerEnter={cancelClose}
        onPointerLeave={(event) => {
          if (event.pointerType !== 'mouse') return;
          scheduleClose();
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
        {/* Gives the corner ✕ a row of its own — on touch the trigger sits
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
  );
}
