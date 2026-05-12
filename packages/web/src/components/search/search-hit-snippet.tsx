'use client';

import { useMemo } from 'react';
import { sanitiseSnippet } from '@/lib/sanitise-snippet';

interface SearchHitSnippetProps {
  snippet: string;
  className?: string;
}

export function SearchHitSnippet({ snippet, className }: SearchHitSnippetProps) {
  const safe = useMemo(() => sanitiseSnippet(snippet), [snippet]);
  return (
    <p
      className={
        className ?? 'mt-1 text-sm text-muted-foreground line-clamp-3 [&_mark]:bg-yellow-200/70 [&_mark]:text-foreground [&_mark]:rounded-sm [&_mark]:px-0.5'
      }
      // safe: `safe` was passed through sanitiseSnippet
      dangerouslySetInnerHTML={{ __html: safe }}
    />
  );
}
