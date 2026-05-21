'use client';

import { useMutation } from '@tanstack/react-query';
import { apiClientV2 } from './api-client';

/**
 * Render `body` to mdast via POST /api/v2/pages/preview.
 *
 * Why a mutation, not a query: previewing is a write-shaped fire-and-
 * react event — the caller debounces `body` and triggers the call
 * explicitly each time. Casting it as a query would force us to use
 * `body` as part of the queryKey (which churns aggressively as the
 * user types) and gain none of react-query's caching benefit (the
 * AST is single-use, consumed immediately by the preview pane).
 *
 * The mutation throws on non-200 so the preview pane can fall back
 * to a "Preview failed" message; transient 401s self-recover via the
 * apiClientV2 fetch wrapper's refresh dance.
 *
 * RFC-0006 Phase 4 Batch 4 — switched from `apiClient.pagePreview.*`
 * (ts-rest) to `apiClientV2.pages.preview.$post` (hc<AppType>).
 */
export function usePreview() {
  return useMutation({
    mutationFn: async (body: string): Promise<unknown> => {
      const response = await apiClientV2.pages.preview.$post({ json: { body } });
      if (!response.ok) {
        throw new Error('Failed to render preview');
      }
      const data = await response.json();
      return data.renderedAst;
    },
  });
}
