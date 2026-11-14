'use client';

import { m } from '@paraglide/messages.js';
import { Expand, Minimize } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { useWideViewport, WIDE_VIEWPORT_QUERY } from '@/lib/use-wide-viewport';
import { cn } from '@/lib/utils';
import { focusMainContent } from '@/lib/use-route-focus';
import { useReadingWidth } from './reading-width-provider';

/** Switches between the standard and the full reading width; the header and the compact bar share one state. */
export function ReadingWidthToggle({ compact = false }: { compact?: boolean }) {
  const { preference, setPreference } = useReadingWidth();
  const ref = useRef<HTMLButtonElement>(null);
  const isWide = useWideViewport();
  const isFull = preference === 'full';
  const label = isFull ? m['page.reading_width_restore']() : m['page.reading_width_expand']();

  // Below 768px the control is hidden by CSS; focus left on it would be stranded.
  // This covers the case where React sees the viewport change first; the
  // `onBlur` below covers the browser clearing focus from the hidden control
  // before React re-renders.
  useLayoutEffect(() => {
    if (!isWide && ref.current && document.activeElement === ref.current) focusMainContent();
  }, [isWide]);

  return (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      size="icon-sm"
      data-reading-width-toggle=""
      data-compact={compact ? 'true' : undefined}
      onBlur={(event) => {
        // A connected toggle that loses focus while the viewport is narrow was hidden under it, not left by the reader.
        if (event.currentTarget.isConnected && !window.matchMedia(WIDE_VIEWPORT_QUERY).matches) focusMainContent();
      }}
      aria-pressed={isFull}
      aria-label={label}
      title={label}
      onClick={() => {
        // Safari does not focus a button on click; the focus must be here before the layout changes.
        ref.current?.focus({ preventScroll: true });
        setPreference(isFull ? 'standard' : 'full');
      }}
      className={cn('shrink-0 text-muted-foreground hover:text-foreground max-md:hidden print:hidden', isFull && 'bg-accent text-foreground')}
    >
      {isFull ? <Minimize className="h-4 w-4" /> : <Expand className="h-4 w-4" />}
    </Button>
  );
}
