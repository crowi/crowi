'use client';

import { useMutation } from '@tanstack/react-query';
import { apiClient } from './api-client';

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
 * apiClient's refresh dance.
 */
export function usePreview() {
  return useMutation({
    mutationFn: async (body: string): Promise<unknown> => {
      const result = await apiClient.pagePreview.previewPage({ body: { body } });
      if (result.status === 200) {
        return result.body.renderedAst;
      }
      throw new Error('Failed to render preview');
    },
  });
}
