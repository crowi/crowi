'use client';

import type { ListPagesSort } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { ArrowDownAZ, ArrowUpDown, Clock, FilePlus2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

export type SortOrder = 'asc' | 'desc';

/**
 * The page-list sort options surfaced in the dropdown. Each fixes both
 * the field and a sensible direction: dates are newest-first, name is
 * A→Z. The `key` is the radio value (so the active option shows a check).
 */
const SORT_OPTIONS: { key: string; sort: ListPagesSort; order: SortOrder; icon: LucideIcon; label: () => string }[] = [
  { key: 'updatedAt:desc', sort: 'updatedAt', order: 'desc', icon: Clock, label: () => m['page_list.sort_updated']() },
  { key: 'createdAt:desc', sort: 'createdAt', order: 'desc', icon: FilePlus2, label: () => m['page_list.sort_created']() },
  { key: 'path:asc', sort: 'path', order: 'asc', icon: ArrowDownAZ, label: () => m['page_list.sort_name']() },
];

interface PageSortMenuProps {
  sort: ListPagesSort;
  order: SortOrder;
  onChange: (next: { sort: ListPagesSort; order: SortOrder }) => void;
}

/**
 * Compact sort control for a page listing — a ghost trigger showing the
 * active option, opening a radio menu of "更新日時順 / 作成日時順 / 名前の順".
 */
export function PageSortMenu({ sort, order, onChange }: PageSortMenuProps) {
  const activeKey = `${sort}:${order}`;
  const active = SORT_OPTIONS.find((o) => o.key === activeKey) ?? SORT_OPTIONS[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-muted-foreground hover:text-foreground" aria-label={m['page_list.sort_aria']()}>
          <ArrowUpDown className="h-3.5 w-3.5" />
          {active.label()}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={activeKey}
          onValueChange={(value) => {
            const next = SORT_OPTIONS.find((o) => o.key === value);
            if (next) onChange({ sort: next.sort, order: next.order });
          }}
        >
          {SORT_OPTIONS.map((option) => {
            const Icon = option.icon;
            return (
              <DropdownMenuRadioItem key={option.key} value={option.key}>
                <Icon className="mr-2 h-4 w-4" />
                {option.label()}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
