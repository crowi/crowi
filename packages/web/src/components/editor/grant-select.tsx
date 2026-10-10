'use client';

import { Globe, Link2, Lock } from 'lucide-react';
import type { Ref } from 'react';
import { PageGrantEnum } from '@crowi/api-contract';
import { GrantChip } from '@/components/grant-chip';
import { grantLabel } from '@/lib/grant-label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { m } from '@paraglide/messages.js';

/**
 * Grant (visibility) selector for the page editor.
 *
 * Only the sub-picker-free grants are offered here:
 *   - PUBLIC     — visible to everyone
 *   - RESTRICTED — anyone with the link
 *   - OWNER      — just the creator
 *
 * GRANT_SPECIFIED (3) requires a full user/group picker UI, which is
 * out of scope for RFC-0005 Phase 2 — see the task report. If a page
 * already carries `grant === SPECIFIED`, the selector renders that
 * value read-only as an extra disabled item so switching it away is
 * still possible without silently dropping the current state.
 */

export interface GrantSelectProps {
  /** Current grant value (Page model constant). `null` / an unrecognised number renders as "cannot be determined" and disables the control. */
  value: number | null;
  /** Called with the chosen grant when the user picks a new option. */
  onChange: (grant: number) => void;
  /** Disables the control (e.g. while a grant mutation is in flight). */
  disabled?: boolean;
  /** `select` is the bordered editor control; `chip` is the header trigger that wraps a muted `GrantChip`. */
  appearance?: 'select' | 'chip';
  /** Controlled open state — only needed by owners that hand focus to a confirmation dialog or force-close the menu. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
  triggerRef?: Ref<HTMLButtonElement>;
}

const SELECTABLE_GRANTS = [
  { grant: PageGrantEnum.PUBLIC, Icon: Globe, label: () => m['edit.grant_public']() },
  { grant: PageGrantEnum.RESTRICTED, Icon: Link2, label: () => m['edit.grant_restricted']() },
  { grant: PageGrantEnum.OWNER, Icon: Lock, label: () => m['edit.grant_owner']() },
] as const;

const KNOWN_GRANTS: readonly number[] = [PageGrantEnum.PUBLIC, PageGrantEnum.RESTRICTED, PageGrantEnum.SPECIFIED, PageGrantEnum.OWNER];

export function GrantSelect({ value, onChange, disabled = false, appearance = 'select', open, onOpenChange, onCloseAutoFocus, triggerRef }: GrantSelectProps) {
  // When an existing page is GRANT_SPECIFIED we cannot offer the full
  // picker, but we must still represent the current value so the
  // <Select> has a matching item — otherwise Radix shows a blank
  // trigger. Render it as a disabled extra option.
  const isSpecified = value === PageGrantEnum.SPECIFIED;
  // An unrecognised value is never defaulted to PUBLIC: that would show a
  // wider audience than the page may actually have.
  const isKnown = value != null && KNOWN_GRANTS.includes(value);
  const isChip = appearance === 'chip';
  const label = grantLabel(value ?? undefined);

  return (
    <Select
      value={isKnown ? String(value) : ''}
      onValueChange={(next) => onChange(Number(next))}
      disabled={disabled || !isKnown}
      open={open}
      onOpenChange={onOpenChange}
    >
      <SelectTrigger
        ref={triggerRef}
        className={
          isChip
            ? 'h-auto w-auto gap-0.5 rounded-full border-0 bg-transparent p-0 shadow-none dark:bg-transparent dark:hover:bg-transparent [&>svg]:hidden'
            : 'h-8 w-auto gap-1.5 text-sm'
        }
        aria-label={isKnown && label != null ? `${m['edit.grant_label']()}: ${label}` : m['edit.grant_label']()}
      >
        {!isKnown ? (
          <span className="text-muted-foreground text-xs">{m['edit.grant_unknown']()}</span>
        ) : isChip ? (
          <GrantChip grant={value} publicTreatment="muted" />
        ) : (
          <SelectValue />
        )}
      </SelectTrigger>
      <SelectContent onCloseAutoFocus={onCloseAutoFocus}>
        {SELECTABLE_GRANTS.map(({ grant, Icon, label }) => (
          <SelectItem key={grant} value={String(grant)}>
            <span className="flex items-center gap-2 whitespace-nowrap">
              <Icon className="h-4 w-4" aria-hidden="true" />
              {label()}
            </span>
          </SelectItem>
        ))}
        {isSpecified && (
          <SelectItem value={String(PageGrantEnum.SPECIFIED)} disabled>
            <span className="flex items-center gap-2 whitespace-nowrap">
              <Lock className="h-4 w-4" aria-hidden="true" />
              {m['edit.grant_specified']()}
            </span>
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}
