'use client';

import { useMutation } from '@tanstack/react-query';
import { useRef } from 'react';
import { apiClient } from './api-client';

/**
 * Render `body` to mdast via POST /api/pages/preview.
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
 * apiClient fetch wrapper's refresh dance.
 *
 * RFC-0006 Phase 4 Batch 4 — switched from `apiClient.pagePreview.*`
 * (ts-rest) to `apiClient.pages.preview.$post` (`createClient`).
 *
 * feature-plugin-renderer-mermaid spec §7 item 8 — every call aborts
 * whichever previous call is still in flight before issuing its own
 * request, via a `useRef<AbortController | null>` that survives across
 * `mutationFn` invocations (a plain local variable would be re-created
 * per call and could never see the previous controller). The signal
 * rides `apiClient.pages.preview.$post`'s `ClientRequestOptions.init`
 * (`hono`'s `hc` client — see the doc comment on `fetchWithTimeout`,
 * which composes this signal with its own internal timeout signal via
 * `AbortSignal.any`, so `fetchWithTimeout` itself needs no change).
 * `MarkdownPreview.tsx` needs no change either: its existing `stale`
 * cleanup flag is already set before the next debounce fires, so the
 * aborted call's `.catch` bails out early instead of calling
 * `setErrored(true)`.
 *
 * Superseded server-side work is also cut short: the aborted request's
 * `c.req.raw.signal` (`hono/handlers/page-preview.ts`) is threaded
 * through to `RenderContext.signal`, so a still-queued (not yet
 * running) admission-control job for that request is dropped instead
 * of wasting a render slot (`render-admission.ts`, spec §6).
 */
export function usePreview() {
  const controllerRef = useRef<AbortController | null>(null);
  return useMutation({
    mutationFn: async (body: string): Promise<unknown> => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const response = await apiClient.pages.preview.$post({ json: { body } }, { init: { signal: controller.signal } });
      if (!response.ok) {
        throw new Error('Failed to render preview');
      }
      const data = await response.json();
      return data.renderedAst;
    },
  });
}
