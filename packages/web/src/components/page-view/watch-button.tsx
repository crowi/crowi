'use client';

import { Bell, BellOff, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToggleWatch, useWatchStatus } from '@/lib/use-watch';
import { m } from '@paraglide/messages.js';

interface WatchButtonProps {
  pageId: string;
}

export function WatchButton({ pageId }: WatchButtonProps) {
  const { isLoading } = useWatchStatus(pageId);
  const { watching, toggle, isPending, isError, error } = useToggleWatch(pageId);

  if (isLoading) {
    return (
      <Button variant="ghost" size="icon-sm" disabled aria-label={m['page.watch_loading_aria']()} className="text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
      </Button>
    );
  }

  const ariaLabel = watching ? m['page.watch_aria_remove']() : m['page.watch_aria_add']();
  const Icon = isPending ? Loader2 : watching ? Bell : BellOff;

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={() => toggle()}
      disabled={isPending}
      aria-label={ariaLabel}
      aria-pressed={watching}
      title={isError && error instanceof Error ? error.message : ariaLabel}
      className={watching ? 'text-primary hover:text-primary' : 'text-muted-foreground hover:text-foreground'}
    >
      <Icon className={`h-4 w-4 ${isPending ? 'animate-spin' : ''} ${watching && !isPending ? 'fill-current' : ''}`} />
    </Button>
  );
}
