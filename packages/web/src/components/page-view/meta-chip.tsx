'use client';

import type { LucideIcon } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface MetaChipProps {
  icon: LucideIcon;
  count: number;
  label: string;
  /**
   * Click handler. Ignored when `count === 0` — a zero-count chip is
   * rendered greyed and non-interactive (RFC-0005 "Zero-count behaviour").
   */
  onClick?: () => void;
  /**
   * Tooltip shown when the chip is disabled (`count === 0`), e.g.
   * "No likes yet". Required so a zero-count chip still explains itself.
   */
  emptyTooltip: string;
  /** Accessible name for the active (clickable) chip. */
  ariaLabel: string;
}

/**
 * RFC-0005 Phase 3 — uniform `[icon][count][label]` meta-row chip.
 *
 * Two visual states:
 *   - count > 0: a clickable pill with a subtle hover lift.
 *   - count === 0: greyed, non-interactive; hovering shows `emptyTooltip`
 *     ("No likes yet" etc.) so the row layout stays stable instead of
 *     the chip disappearing.
 */
export function MetaChip({ icon: Icon, count, label, onClick, emptyTooltip, ariaLabel }: MetaChipProps) {
  const isDisabled = count === 0;

  if (isDisabled) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="inline-flex items-center gap-1.5 rounded-full bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground/60 cursor-default"
            aria-disabled="true"
          >
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="font-medium tabular-nums">{count}</span>
            <span>{label}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>{emptyTooltip}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full bg-muted/60 px-2.5 py-1 text-xs text-muted-foreground',
        'transition-colors hover:bg-muted hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="font-medium tabular-nums">{count}</span>
      <span>{label}</span>
    </button>
  );
}
