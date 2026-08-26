import { PageGrantEnum } from '@crowi/api-contract';
import type { LucideIcon } from 'lucide-react';
import { Link2, Lock } from 'lucide-react';

import { grantLabel } from '@/lib/grant-label';

interface GrantChipProps {
  grant: number;
  publicTreatment?: 'hidden' | 'muted';
}

function grantChipInfo(grant: number): { Icon: LucideIcon; label: string } | null {
  const label = grantLabel(grant);
  if (label == null || grant === PageGrantEnum.PUBLIC) return null;
  return { Icon: grant === PageGrantEnum.RESTRICTED ? Link2 : Lock, label };
}

export function GrantChip({ grant, publicTreatment = 'hidden' }: GrantChipProps) {
  if (grant === PageGrantEnum.PUBLIC) {
    // Public pages omit a visibility signal in headers, but history must name every transition; transparent cannot make that audit detail disappear.
    if (publicTreatment === 'hidden') return null;
    return (
      <span
        data-page-grant={grant}
        className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
      >
        {grantLabel(grant)}
      </span>
    );
  }

  const info = grantChipInfo(grant);
  if (info == null) return null;
  const { Icon, label } = info;

  return (
    <span
      data-page-grant={grant}
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium"
      style={{ borderColor: 'var(--page-grant-accent)', color: 'var(--page-grant-accent)' }}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {label}
    </span>
  );
}
