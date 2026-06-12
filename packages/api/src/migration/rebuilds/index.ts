import { runBacklinkRebuild } from 'src/util/rebuild-backlink';
import { runRendererRebuild } from 'src/util/rebuild-renderer';
import { runSearchRebuild } from 'src/util/search-rebuild';
import { type StorageCopyProgress, runStorageCopy } from 'src/util/storage-copy';

import { type RebuildTask, defineRebuild } from '../rebuild-runner';

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
