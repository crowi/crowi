'use client';

import type { Pager as PagerDto } from '@crowi/api-contract';
import { Pager } from '@/components/ui/pager';

interface PaginationProps {
  pager: PagerDto;
  limit: number;
  onPageChange: (offset: number) => void;
}

export function Pagination({ pager, limit, onPageChange }: PaginationProps) {
  const currentPage = Math.floor(pager.offset / limit) + 1;

  return (
    <Pager
      mode="prev-next"
      page={currentPage}
      hasPrev={pager.prev !== null}
      hasNext={pager.next !== null}
      onPrev={() => pager.prev !== null && onPageChange(pager.prev)}
      onNext={() => pager.next !== null && onPageChange(pager.next)}
    />
  );
}
