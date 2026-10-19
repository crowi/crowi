import { RotateCw } from 'lucide-react';
import { cn } from '@/lib/utils';

/** A faint icon that surfaces on hover or keyboard focus of the enclosing `group` link, hinting that it reloads the page. */
export function ReloadHint({ className }: { className?: string }) {
  return (
    <RotateCw
      className={cn('h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-60 group-focus-visible:opacity-60', className)}
      aria-hidden
    />
  );
}
