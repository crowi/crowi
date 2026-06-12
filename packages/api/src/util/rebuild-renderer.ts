import type Crowi from 'src/crowi';

/**
 * RFC-0008 §8.5 — `crowi-admin rebuild renderer`.
 *
 * Regenerate cached rendered HTML for pages (the `PluginRenderCache`
 * collection populated by `src/renderer/` + plugin render scopes). This is a
 * derived-data rebuild: version-independent, runnable any time (§3).
 *
 * NOT YET IMPLEMENTED (planner-confirmed: no legacy implementation exists —
 * unlike `rebuild search`, which ported `runSearchRebuild`). Phase 4 only
 * registers the dispatcher entry so `rebuild --help` lists the full surface;
 * the actual rebuild is left as explicit work.
 *
 * TODO(rfc-0008): implement. The shape should mirror `runSearchRebuild`:
 *   - resolve the active renderer scopes (`crowi.getRenderer()` /
 *     the `PluginRenderCache` model registered by `src/renderer/index.ts`),
 *   - with `--only-stale`, re-render only pages whose cache entry is older
 *     than the page's `updatedAt` / current revision,
 *   - otherwise drop + repopulate the cache,
 *   - fan work out through `runner.mapBounded` for embed-plugin rate limits,
 *   - honour `ctx.dryRun` (report candidate count, write nothing).
 */
export interface RendererRebuildOptions {
  /** Only re-render pages whose cached HTML is stale. */
  onlyStale: boolean;
}

export interface RendererRebuildSummary {
  rerendered: number;
  skipped: number;
}

export async function runRendererRebuild(_crowi: Crowi, _opts: RendererRebuildOptions): Promise<RendererRebuildSummary> {
  throw new Error('rebuild renderer is not implemented yet (RFC-0008 §8.5). No legacy implementation exists to port; see util/rebuild-renderer.ts TODO.');
}
