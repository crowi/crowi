'use client';

import { Bell, BellOff, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToggleWatch, useWatchStatus } from '@/lib/use-watch';
import { m } from '@/paraglide/messages.js';

interface WatchButtonProps {
  pageId: string;
}

export function WatchButton({ pageId }: WatchButtonProps) {
  const { isLoading } = useWatchStatus(pageId);
  const { watching, toggle, isPending, isError, error } = useToggleWatch(pageId);

  // Avoid rendering with a misleading default while the initial fetch is in
  // flight — the user shouldn't see "Watch" flash to "Watching".
  if (isLoading) {
    return (
      <Button variant="outline" size="sm" disabled aria-label={m['page.watch_loading_aria']()}>
        <Loader2 className="h-4 w-4 mr-1 animate-spin" />
        {m['page.watch_label']()}
      </Button>
    );
  }

  const label = watching ? m['page.watch_label_done']() : m['page.watch_label']();
  const ariaLabel = watching ? m['page.watch_aria_remove']() : m['page.watch_aria_add']();

  return (
    <Button
      variant={watching ? 'default' : 'outline'}
      size="sm"
      onClick={() => toggle()}
      disabled={isPending}
      aria-label={ariaLabel}
      aria-pressed={watching}
      title={isError && error instanceof Error ? error.message : undefined}
    >
      {isPending ? (
        <Loader2 className="h-4 w-4 mr-1 animate-spin" />
      ) : watching ? (
        <Bell className="h-4 w-4 mr-1 fill-current" />
      ) : (
        <BellOff className="h-4 w-4 mr-1" />
      )}
      {label}
    </Button>
  );
}
