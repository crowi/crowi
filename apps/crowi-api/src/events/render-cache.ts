import Debug from 'debug';
import type Crowi from 'src/crowi';

const debug = Debug('crowi:events:render-cache');

/**
 * Phase 4 render-cache invalidation listener. Hooks into `pageEvent`
 * to evict cached embeds whenever a page changes:
 *
 *   - `update` → the saved revision body may include new / removed
 *     `@[tag](url)` matches; we invalidate every cached entry for
 *     the page so the next render re-fills the cache against the
 *     new body. (Plugins are responsible for re-rendering — Phase 4
 *     does not re-render eagerly here. The next page view triggers
 *     the cache miss → render.)
 *
 *   - `delete` → no future renders will ever fire for this page, so
 *     the rows are pure dead weight; we delete them straight away.
 *
 * Failures are logged but never propagated. The save / delete
 * operation itself must not be blocked by a cache-clear failure.
 *
 * `events/index.ts` does NOT register this listener — registration is
 * done from `Crowi.setupRenderer()` because the renderer needs to be
 * constructed first (the cache storage handle lives on
 * `crowi.renderer.cache`).
 */
export function registerRenderCacheInvalidation(crowi: Crowi): void {
  const pageEvent = crowi.event('Page');

  const invalidate = (savedPage: { _id?: unknown } | undefined, reason: 'update' | 'delete') => {
    const renderer = crowi.renderer;
    if (!renderer) return; // boot order means this shouldn't happen
    const rawId = savedPage && (savedPage as { _id?: unknown })._id;
    const pageId = typeof rawId === 'string' ? rawId : rawId != null ? String(rawId) : null;
    if (!pageId) {
      debug('skipping invalidation: pageEvent emit had no resolvable pageId (reason=%s)', reason);
      return;
    }
    Promise.resolve()
      .then(() => renderer.cache.invalidatePage(pageId))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[crowi:render-cache] invalidatePage(${pageId}) on ${reason} failed: ${message}`);
      });
  };

  pageEvent.on('update', (savedPage: unknown) => invalidate(savedPage as { _id?: unknown }, 'update'));
  pageEvent.on('delete', (savedPage: unknown) => invalidate(savedPage as { _id?: unknown }, 'delete'));
}
