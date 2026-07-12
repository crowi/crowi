'use client';

import { m } from '@paraglide/messages.js';
import { Pager } from '@/components/ui/pager';

interface SearchPagerProps {
  page: number;
  total: number;
  limit: number;
  onPageChange: (page: number) => void;
}

export function SearchPager({ page, total, limit, onPageChange }: SearchPagerProps) {
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return <Pager mode="numbered" page={page} totalPages={totalPages} onPageChange={onPageChange} ariaLabel={m['search.pager.aria_label']()} />;
}
