'use client';

import { useState } from 'react';
import type { TocEntryResponse } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { ChevronDown, List } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { TocList } from './page-toc';

interface PageTocMenuProps {
  toc: TocEntryResponse[];
  /** Shared scroll-spy active id (computed once in `PageView`). */
  activeId: string | null;
}

/**
 * Collapsed TOC for narrow viewports (< 1280px) where the right rail is
 * hidden: a "目次" button in the page header that opens a popover with
 * the same entries + active highlight as the rail. Persists down to
 * mobile so the table of contents stays reachable at every width below
 * the rail breakpoint. Returns null below 2 entries (nothing to show).
 */
export function PageTocMenu({ toc, activeId }: PageTocMenuProps) {
  const [open, setOpen] = useState(false);
  if (toc.length < 2) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="shrink-0 gap-1 text-muted-foreground hover:text-foreground" aria-label={m['page.toc_label']()}>
          <List className="h-4 w-4" />
          <span>{m['page.toc_label']()}</span>
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[70vh] w-72 overflow-y-auto">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{m['page.toc_heading']()}</div>
        {/* Close the popover on navigation so the jump target isn't hidden behind it. */}
        <TocList toc={toc} activeId={activeId} onNavigate={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
