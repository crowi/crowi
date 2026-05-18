'use client';

import { Globe, Link2, Lock } from 'lucide-react';
import { PageGrantEnum } from '@crowi/api-contract';
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

interface GrantSelectProps {
  /** Current grant value (Page model constant). */
  value: number;
  /** Called with the chosen grant when the user picks a new option. */
  onChange: (grant: number) => void;
  /** Disables the control (e.g. while a grant mutation is in flight). */
  disabled?: boolean;
}

const SELECTABLE_GRANTS = [
  { grant: PageGrantEnum.PUBLIC, Icon: Globe, label: () => m['edit.grant_public']() },
  { grant: PageGrantEnum.RESTRICTED, Icon: Link2, label: () => m['edit.grant_restricted']() },
  { grant: PageGrantEnum.OWNER, Icon: Lock, label: () => m['edit.grant_owner']() },
] as const;

export function GrantSelect({ value, onChange, disabled = false }: GrantSelectProps) {
  // When an existing page is GRANT_SPECIFIED we cannot offer the full
  // picker, but we must still represent the current value so the
  // <Select> has a matching item — otherwise Radix shows a blank
  // trigger. Render it as a disabled extra option.
  const isSpecified = value === PageGrantEnum.SPECIFIED;

  return (
    <Select value={String(value)} onValueChange={(next) => onChange(Number(next))} disabled={disabled}>
      <SelectTrigger className="h-8 w-auto gap-1.5 text-sm" aria-label={m['edit.grant_label']()}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {SELECTABLE_GRANTS.map(({ grant, Icon, label }) => (
          <SelectItem key={grant} value={String(grant)}>
            <span className="flex items-center gap-2">
              <Icon className="h-4 w-4" aria-hidden="true" />
              {label()}
            </span>
          </SelectItem>
        ))}
        {isSpecified && (
          <SelectItem value={String(PageGrantEnum.SPECIFIED)} disabled>
            <span className="flex items-center gap-2">
              <Lock className="h-4 w-4" aria-hidden="true" />
              {m['edit.grant_specified']()}
            </span>
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}
