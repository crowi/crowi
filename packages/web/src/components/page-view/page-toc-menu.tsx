'use client';

import type { TocEntryResponse } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { ChevronDown, List } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useForceCloseable } from '@/lib/use-force-closeable';
import { cn } from '@/lib/utils';
import { TocList } from './page-toc';

interface PageTocMenuProps {
  toc: TocEntryResponse[];
  /** Shared scroll-spy active id (computed once in `PageView`). */
  activeId: string | null;
  /**
   * Render the trigger at the compact (sticky-header) size — ~0.75rem
   * text + matching icons — so it fits the 60px compact bar's presence
   * row. Defaults to the roomier expanded-header size.
   */
  compact?: boolean;
  /**
   * feature-mobile-presence-card — force-closes the popover while `true`.
   * `PageHeader` sets it from its own `compact` sticky state for the
   * instance rendered inside the EXPANDED subtree; see `useForceCloseable`
   * for why a Portal-rendered overlay needs this even though its trigger's
   * ancestor already goes `inert`.
   */
  forceClose?: boolean;
}

/**
 * Collapsed TOC for narrow viewports (< 1280px) where the right rail is
 * hidden: a "目次" button in the page header that opens a popover with
 * the same entries + active highlight as the rail. Persists down to
 * mobile so the table of contents stays reachable at every width below
 * the rail breakpoint. Returns null below 2 entries (nothing to show).
 */
export function PageTocMenu({ toc, activeId, compact = false, forceClose = false }: PageTocMenuProps) {
  const [open, setOpen] = useForceCloseable(forceClose);

  if (toc.length < 2) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn('shrink-0 text-muted-foreground hover:text-foreground', compact ? 'h-6 gap-0.5 px-1.5 text-xs' : 'h-7 gap-1 px-2')}
          aria-label={m['page.toc_label']()}
        >
          <List className={compact ? 'h-3 w-3' : 'h-4 w-4'} />
          <span>{m['page.toc_label']()}</span>
          <ChevronDown className={cn('opacity-60', compact ? 'h-3 w-3' : 'h-3.5 w-3.5')} />
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
