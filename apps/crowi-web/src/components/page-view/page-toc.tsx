'use client';

import { useEffect, useState } from 'react';
import type { TocEntryResponse } from '@crowi/api-contract';
import { cn } from '@/lib/utils';

interface PageTocProps {
  toc: TocEntryResponse[];
}

// Scroll-spy uses getBoundingClientRect rather than IntersectionObserver
// so the highlight stays on the last-passed heading even when the reader
// stops between two headings (IO can leave activeId unset there).
export function PageToc({ toc }: PageTocProps) {
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    if (toc.length < 2) return;

    const headings = toc
      .map((entry) => ({ id: entry.anchorId, el: document.getElementById(entry.anchorId) }))
      .filter((h): h is { id: string; el: HTMLElement } => h.el !== null);

    if (headings.length === 0) return;

    let rafId: number | null = null;

    const compute = () => {
      rafId = null;
      // Switch on the heading reaching the sticky-header edge
      // (scroll-mt-24 = 6rem) rather than the viewport top.
      const offset = 100;
      let current = headings[0].id;
      for (const h of headings) {
        const top = h.el.getBoundingClientRect().top;
        if (top - offset <= 0) {
          current = h.id;
        } else {
          break;
        }
      }
      setActiveId(current);
    };

    const onScroll = () => {
      if (rafId === null) rafId = requestAnimationFrame(compute);
    };

    compute();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [toc]);

  if (toc.length < 2) return null;

  // Normalize indent: the shallowest heading sits at indent 0 even if
  // the page only uses h2/h3 (no h1) — common when the site renders
  // the page title separately.
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
