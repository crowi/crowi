import type Crowi from 'src/crowi';

import { type RebuildOutcome, RebuildRunner } from './rebuild-runner';
import { backlinkRebuild, rendererRebuild, searchRebuild, storageCopyRebuild } from './rebuilds';

/**
 * RFC-0008 §8.5 — the api-side surface the `@crowi/admin-cli` `rebuild`
 * commands consume.
 *
 * Mirrors `cli-api.ts` (the `migrate` façade): the admin CLI is a separate
 * process that `require`s the api's compiled `dist/`, so it talks to a small
 * stable façade rather than reaching into `rebuild-runner.ts` / `rebuilds/`
 * individually. Every entry point routes through `RebuildRunner` so dry-run /
 * progress / SIGINT / structured logging are shared with `migrate` — but with
 * NO `migrationApplications` coupling (§8.5: rebuilds have no pending/applied
 * concept).
 */

/** Optional progress callback surfaced to the CLI (label + monotonically increasing count). */
export interface RebuildProgress {
  onLabel?: (label: string) => void;
  onIncrement?: (current: number) => void;
}

export interface RebuildSearchOptions {
  dryRun?: boolean;
  progress?: RebuildProgress;
}
export interface RebuildStorageCopyOptions {
  from: string;
  to: string;
  dryRun?: boolean;
  progress?: RebuildProgress;
}
export interface RebuildRendererOptions {
  onlyStale?: boolean;
  dryRun?: boolean;
  progress?: RebuildProgress;
}
export interface RebuildBacklinkOptions {
  dryRun?: boolean;
  progress?: RebuildProgress;
}

/** Façade over the rebuild runner + task registry for the CLI. */
export class RebuildCliApi {
  private readonly crowi: Crowi;

  constructor(crowi: Crowi) {
    this.crowi = crowi;
  }

  private buildRunner(dryRun: boolean | undefined, progress: RebuildProgress | undefined): RebuildRunner {
    let count = 0;
    return new RebuildRunner(this.crowi, {
      dryRun,
      progress: {
        setTotal: () => undefined,
        increment: (delta = 1) => {
          count += delta;
          progress?.onIncrement?.(count);
        },
        setLabel: (label) => progress?.onLabel?.(label),
      },
    });
  }

  rebuildSearch(opts: RebuildSearchOptions = {}): Promise<RebuildOutcome> {
    return this.buildRunner(opts.dryRun, opts.progress).run(searchRebuild);
  }

  rebuildStorageCopy(opts: RebuildStorageCopyOptions): Promise<RebuildOutcome> {
    return this.buildRunner(opts.dryRun, opts.progress).run(storageCopyRebuild({ from: opts.from, to: opts.to }));
  }

  rebuildRenderer(opts: RebuildRendererOptions = {}): Promise<RebuildOutcome> {
    return this.buildRunner(opts.dryRun, opts.progress).run(rendererRebuild({ onlyStale: opts.onlyStale ?? false }));
  }

  rebuildBacklink(opts: RebuildBacklinkOptions = {}): Promise<RebuildOutcome> {
    return this.buildRunner(opts.dryRun, opts.progress).run(backlinkRebuild);
  }
}

/** Convenience factory used by the CLI's `require(dist/migration/rebuild-api)`. */
export function createRebuildCliApi(crowi: Crowi): RebuildCliApi {
  return new RebuildCliApi(crowi);
}
