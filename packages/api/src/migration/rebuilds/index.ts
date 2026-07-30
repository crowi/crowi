import { type AttachmentDisplayDerivativesTaskOptions, runAttachmentDisplayDerivativesRebuild } from 'src/util/rebuild-attachment-display-derivatives';
import { runBacklinkRebuild } from 'src/util/rebuild-backlink';
import { runRenderedAstRebuild } from 'src/util/rebuild-rendered-ast';
import { runRendererRebuild } from 'src/util/rebuild-renderer';
import { runSearchRebuild } from 'src/util/search-rebuild';
import { runStorageCopy, type StorageCopyProgress } from 'src/util/storage-copy';

import { defineRebuild, type RebuildTask } from '../rebuild-runner';

/**
 * RFC-0008 §8.5 — the registered rebuild tasks.
 *
 * Each task wires an existing api-side `run*` helper onto the shared
 * `RebuildRunner` so the `--dry-run` / progress / SIGINT / structured-logging
 * conventions are uniform. Tasks carry NO pending/applied state (§8.5): they
 * never read or append `migrationApplications`.
 *
 * `search` and `storage-copy` port the previously top-level `search rebuild` /
 * `storage copy` commands (their core logic stays in `util/`, unchanged);
 * `renderer` and `backlink` are skeletons whose `run*` helpers throw a clear
 * "not implemented" error (no legacy implementation to port).
 */

export const searchRebuild: RebuildTask = defineRebuild({
  id: 'search',
  description: "Rebuild the search index from scratch using the active driver's rebuild().",
  async run(ctx) {
    const summary = await runSearchRebuild(ctx.crowi);
    return { driverName: summary.driverName, pluginName: summary.pluginName };
  },
});

/** Options threaded from the CLI into the storage-copy task via the runner. */
export interface StorageCopyTaskOptions {
  from: string;
  to: string;
}

export function storageCopyRebuild(opts: StorageCopyTaskOptions): RebuildTask {
  return defineRebuild({
    id: 'storage-copy',
    description: `Copy every stored object from '${opts.from}' to '${opts.to}'.`,
    async run(ctx) {
      const summary = await runStorageCopy(ctx.crowi, {
        from: opts.from,
        to: opts.to,
        dryRun: ctx.dryRun,
        onProgress: (event: StorageCopyProgress) => {
          // Bridge the util's per-key callback onto the shared progress sink.
          ctx.progress.increment();
          ctx.progress.setLabel(`${event.stage} ${event.key}`);
        },
      });
      return { ...summary };
    },
  });
}

export interface RendererTaskOptions {
  onlyStale: boolean;
}

export function rendererRebuild(opts: RendererTaskOptions): RebuildTask {
  return defineRebuild({
    id: 'renderer',
    description: 'Regenerate cached rendered HTML for pages. (not implemented)',
    async run(ctx) {
      const summary = await runRendererRebuild(ctx.crowi, { onlyStale: opts.onlyStale });
      return { ...summary };
    },
  });
}

export const backlinkRebuild: RebuildTask = defineRebuild({
  id: 'backlink',
  description: 'Rebuild the backlink index across all pages. (not implemented)',
  async run(ctx) {
    const summary = await runBacklinkRebuild(ctx.crowi);
    return { ...summary };
  },
});

/**
 * RFC-0023 §15 — `rebuild rendered-ast`. Backfills every page's current
 * `Revision.renderedAst` (+ `rendererVersion` + `meta`) after a
 * `RENDERER_PIPELINE_VERSION` bump. Idempotent (eligible count reaches
 * 0), so it fits the rebuild family's "version-independent, runnable
 * any time" contract; the rollout procedure (see the admin guide and
 * `util/rebuild-rendered-ast.ts`'s doc comment) requires a real-write
 * run right after deploying a version bump — pre-deploy verification is
 * `--dry-run` only.
 */
export const renderedAstRebuild: RebuildTask = defineRebuild({
  id: 'rendered-ast',
  description: 'Backfill Revision.renderedAst (+ meta) for current revisions whose stored AST predates the running renderer pipeline.',
  async run(ctx, runner) {
    const summary = await runRenderedAstRebuild(ctx.crowi, ctx, runner);
    return { ...summary };
  },
});

/**
 * feature-image-derivative-optimization Phase 3 — `rebuild
 * attachment-display-derivatives`. The CLI-supplied flags close over the
 * returned task via `opts` (mirrors `storageCopyRebuild`'s `from`/`to`);
 * `ctx`/`runner` (dryRun/concurrency/aborted) flow in the same way every
 * other task gets them. All the actual work lives in
 * `util/rebuild-attachment-display-derivatives.ts` — see its module doc
 * comment for the generate / repair-missing / gc mode split.
 */
export function attachmentDisplayDerivativesRebuild(opts: AttachmentDisplayDerivativesTaskOptions): RebuildTask {
  return defineRebuild({
    id: 'attachment-display-derivatives',
    description: 'Regenerate display-optimized derivative images for attachments.',
    async run(ctx, runner) {
      const stats = await runAttachmentDisplayDerivativesRebuild(ctx.crowi, opts, ctx, runner);
      return { ...stats };
    },
  });
}
