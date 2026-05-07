'use client';

import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { m } from '@/paraglide/messages.js';

interface LoadingSpinnerProps {
  message?: string;
  /** Vertical padding around the spinner. Defaults to py-16 (page-level). */
  className?: string;
  /** Spinner icon size. Defaults to "lg". */
  size?: 'sm' | 'md' | 'lg';
}

const SIZE_MAP = {
  sm: 'h-4 w-4',
  md: 'h-6 w-6',
  lg: 'h-8 w-8',
} as const;

/**
 * Centered spinner used for full-page / large-area loading states.
 * Mirrors the legacy inline pattern (`flex items-center justify-center py-16`
 * + Loader2 + grey muted message text).
 */
export function LoadingSpinner({ message, className, size = 'lg' }: LoadingSpinnerProps) {
  return (
    <div className={cn('flex items-center justify-center py-16', className)} role="status">
      <Loader2 className={cn(SIZE_MAP[size], 'animate-spin text-primary')} />
      <span className="ml-3 text-muted-foreground">{message ?? m['common.loading']()}</span>
    </div>
  );
}
