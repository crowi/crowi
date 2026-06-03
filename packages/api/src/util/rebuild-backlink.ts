import type Crowi from 'src/crowi';

/**
 * RFC-0008 §8.5 — `crowi-admin rebuild backlink`.
 *
 * Rebuild the backlink index across all pages (the `Backlink` collection,
 * which maps fromPage/fromRevision → toPage by scanning page bodies). This is
 * a derived-data rebuild: version-independent, runnable any time (§3).
 *
 * NOT YET IMPLEMENTED (planner-confirmed: no legacy implementation exists as a
 * CLI command). Phase 4 only registers the dispatcher entry so `rebuild --help`
 * lists the full surface; the actual rebuild is left as explicit work.
 *
 * TODO(rfc-0008): implement. The primitive already exists on the model —
 * `Backlink.createByAllPages()` (models/backlink.ts) drops + recreates the
 * whole index. The rebuild wrapper should:
 *   - iterate published pages through `runner.mapBounded` rather than the
 *     model's all-at-once helper, so progress + SIGINT + concurrency are
 *     honoured on large installs,
 *   - report a candidate count and write nothing when `ctx.dryRun` is true.
 */
export interface BacklinkRebuildSummary {
  pagesScanned: number;
  backlinksWritten: number;
}

export async function runBacklinkRebuild(_crowi: Crowi): Promise<BacklinkRebuildSummary> {
  throw new Error('rebuild backlink is not implemented yet (RFC-0008 §8.5). No legacy implementation exists to port; see util/rebuild-backlink.ts TODO.');
}
