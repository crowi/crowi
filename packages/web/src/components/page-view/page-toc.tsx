'use client';

import { useEffect, useRef, useState } from 'react';
import type { TocEntryResponse } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { cn } from '@/lib/utils';

interface PageTocProps {
  toc: TocEntryResponse[];
  /** Active heading id from `useTocScrollSpy`, lifted to the page so the
   *  rail and the header `PageTocMenu` share a single scroll-spy. */
  activeId: string | null;
}

// Pixel offset above which a heading is considered "passed". Aligned with
// the headings' Tailwind `scroll-mt-24` (= 6rem = 96px) so anchor jumps
// land where the highlight switches.
const SCROLL_SPY_OFFSET_PX = 96;

/**
 * Scroll-spy for the TOC: caches each heading's offsetTop on mount +
 * resize and compares against `window.scrollY` per scroll frame, so the
 * steady-state cost is one number compare per heading.
 * `getBoundingClientRect` reads (which force layout) only run on the
 * resize / mount path. Lifted to a hook so the right-rail `PageToc` and
 * the header `PageTocMenu` can share ONE spy (the page computes it once
 * and passes `activeId` down) instead of each running its own listener.
 */
export function useTocScrollSpy(toc: TocEntryResponse[]): string | null {
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (toc.length < 2) return;

    type Cached = { id: string; top: number };
    let offsets: Cached[] = [];

    const measure = () => {
      offsets = toc
        .map((entry) => {
          const el = document.getElementById(entry.anchorId);
          return el ? { id: entry.anchorId, top: el.offsetTop } : null;
        })
        .filter((x): x is Cached => x !== null);
    };

    const compute = () => {
      rafId = null;
      if (offsets.length === 0) return;

      const scrollY = window.scrollY + SCROLL_SPY_OFFSET_PX;
      let current: string = offsets[0].id;
      for (const h of offsets) {
        if (h.top <= scrollY) current = h.id;
        else break;
      }

      if (current !== activeIdRef.current) {
        activeIdRef.current = current;
        setActiveId(current);
      }
    };

    let rafId: number | null = null;
    const onScroll = () => {
      if (rafId === null) rafId = requestAnimationFrame(compute);
    };
    const onResize = () => {
      measure();
      onScroll();
    };

    measure();
    compute();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
    };
  }, [toc]);

  return activeId;
}

/**
 * Presentational TOC list. Shared by the right-rail `PageToc` and the
 * header `PageTocMenu` so both render identical entries / indentation /
 * active highlight. `onNavigate` lets the menu close its popover when an
 * entry is clicked.
 */
export function TocList({ toc, activeId, onNavigate }: { toc: TocEntryResponse[]; activeId: string | null; onNavigate?: () => void }) {
  // Indent normalization: shallowest heading sits flush at indent 0
  // even when the page only uses h2/h3 (h1 is rendered separately).
  const minLevel = toc.reduce((min, e) => Math.min(min, e.level), 6);

  return (
    <ul className="space-y-0.5 text-sm border-l border-border/60">
      {toc.map((entry) => {
        const indent = Math.max(0, entry.level - minLevel);
        const isActive = activeId === entry.anchorId;
        return (
          <li key={entry.anchorId}>
            <a
              href={`#${entry.anchorId}`}
              onClick={onNavigate}
              className={cn(
                'block py-1 pr-2 transition-colors leading-snug truncate',
                '-ml-px border-l',
                isActive
                  ? 'border-primary text-foreground font-medium'
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:border-foreground/40',
              )}
              style={{ paddingLeft: `${indent * 0.75 + 0.75}rem` }}
              title={entry.text}
            >
              {entry.text}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Right-rail TOC. Rendered as an in-flow sticky `<aside>` inside the
 * page-view's centered `[spacer | content | toc]` flex (see
 * `PageView`); the flex column wrapper owns the responsive show/hide
 * (visible from the 1280px breakpoint up), so this component only owns
 * the sticky positioning + the list. Returns null below 2 entries — a
 * single-heading page has nothing worth a rail.
 */
export function PageToc({ toc, activeId }: PageTocProps) {
  if (toc.length < 2) return null;

  return (
    <aside aria-label={m['page.toc_heading']()} className="sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto">
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">{m['page.toc_heading']()}</div>
      <TocList toc={toc} activeId={activeId} />
    </aside>
  );
}
