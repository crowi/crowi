'use client';

import { useEffect, useRef, useState } from 'react';
import type { TocEntryResponse } from '@crowi/api-contract';
import { cn } from '@/lib/utils';

interface PageTocProps {
  toc: TocEntryResponse[];
}

// Pixel offset above which a heading is considered "passed". Aligned with
// the headings' Tailwind `scroll-mt-24` (= 6rem = 96px) so anchor jumps
// land where the highlight switches.
const SCROLL_SPY_OFFSET_PX = 96;

/**
 * Right-rail TOC with scroll-spy. Caches each heading's offsetTop on
 * mount + resize and compares against `window.scrollY` per scroll
 * frame, so the steady-state cost is one number compare per heading.
 * `getBoundingClientRect` reads (which force layout) only run on the
 * resize / mount path.
 */
export function PageToc({ toc }: PageTocProps) {
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

  if (toc.length < 2) return null;

  // Indent normalization: shallowest heading sits flush at indent 0
  // even when the page only uses h2/h3 (h1 is rendered separately).
  const minLevel = toc.reduce((min, e) => Math.min(min, e.level), 6);

  return (
    <aside aria-label="Table of contents" className="hidden min-[1440px]:block fixed top-24 right-6 w-56 max-h-[calc(100vh-7rem)] overflow-y-auto z-30">
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">On this page</div>
      <ul className="space-y-0.5 text-sm border-l border-border/60">
        {toc.map((entry) => {
          const indent = Math.max(0, entry.level - minLevel);
          const isActive = activeId === entry.anchorId;
          return (
            <li key={entry.anchorId}>
              <a
                href={`#${entry.anchorId}`}
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
    </aside>
  );
}
