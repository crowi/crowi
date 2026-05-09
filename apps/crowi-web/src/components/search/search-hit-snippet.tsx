'use client';

import { useMemo } from 'react';
import { sanitiseSnippet } from '@/lib/sanitise-snippet';

/**
 * Renders a search-result snippet that may contain `<mark>` highlight tokens
 * from the search driver (e.g. Elasticsearch's `highlight` field).
 *
 * Sanitisation lives in `@/lib/sanitise-snippet` (allow-list policy + tests
 * are documented there). This component is the *only* place in the app that
 * passes search-driver markup to `dangerouslySetInnerHTML`, so the trust
 * boundary is small and easy to audit.
 */

interface SearchHitSnippetProps {
  snippet: string;
  className?: string;
}

export function SearchHitSnippet({ snippet, className }: SearchHitSnippetProps) {
  // Memoise per-snippet so re-renders (e.g. on hover state in the parent) do
  // not re-run the regex pass.
  const safe = useMemo(() => sanitiseSnippet(snippet), [snippet]);
  return (
    <p
      className={
        className ?? 'mt-1 text-sm text-muted-foreground line-clamp-3 [&_mark]:bg-yellow-200/70 [&_mark]:text-foreground [&_mark]:rounded-sm [&_mark]:px-0.5'
      }
      // safe to render: `safe` has been passed through `sanitiseSnippet`.
      dangerouslySetInnerHTML={{ __html: safe }}
    />
  );
}
