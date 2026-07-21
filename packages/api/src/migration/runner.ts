import os from 'node:os';
import Debug from 'debug';

import type Crowi from 'src/crowi';
import type { MigrationApplicationModel, MigrationResult } from 'src/models/migration-application';

import type {
  DetectReport,
  MigrationContext,
  MigrationDb,
  MigrationDefinition,
  MigrationLogger,
  ProgressReporter,
  RewritePageBodyOptions,
  StageResult,
} from './types';

const debug = Debug('crowi:migration:runner');

/**
 * RFC-0008 §4.3 — the shared migration runner.
 *
 * Both the `migrate` and `rebuild` namespaces route through this one runner
 * so dry-run, progress, bounded concurrency, structured logging, safe SIGINT
 * interruption, and Yjs invalidation are implemented once. It also owns the
 * pending-vs-recorded reconciliation table (§6.2) and the append to the
 * `migrationApplications` audit log.
 */

/** How the framework decides to handle an unapplied preflight migration at boot (§4.2.7). */
export type PreflightUnappliedPolicy = 'block' | 'warn';

export interface RunnerOptions {
  /** When true, stages no-op and only `detect` runs (§8.2). */
  dryRun?: boolean;
  /** Bound on concurrent in-flight units a stage may schedule (default 8). */
  concurrency?: number;
  /** Identifies who triggered the run for the audit log ('boot-auto' | admin-cli@host). */
  appliedBy?: string;
  /** Optional progress sink; defaults to a no-op reporter. */
  progress?: ProgressReporter;
  /** Optional logger; defaults to a `debug`/console-backed logger. */
  logger?: MigrationLogger;
  /**
   * Live force-reload broadcast, available ONLY in the api (boot) process.
   * Left undefined by the admin CLI (§4.3.1).
   */
  broadcastForceReload?: (pageIds: string[]) => Promise<void>;
}

/** Outcome of running (or probing) a single migration. */
export interface MigrationRunOutcome {
  id: string;
  result: MigrationResult;
  durationMs: number;
  stats: Record<string, unknown>;
  /** True when the run was aborted by SIGINT before completing all stages. */
  interrupted?: boolean;
}

/** A no-op progress reporter — used by boot / tests that don't render progress. */
export const noopProgress: ProgressReporter = {
  setTotal: () => undefined,
  increment: () => undefined,
  setLabel: () => undefined,
};

/** Default logger: structured lines via `debug`, warnings/errors to console. */
function defaultLogger(): MigrationLogger {
  return {
    info: (message, ...args) => debug(message, ...args),
    debug: (message, ...args) => debug(message, ...args),
    warn: (message, ...args) => console.warn(`[crowi:migration] ${message}`, ...args),
    error: (message, ...args) => console.error(`[crowi:migration] ${message}`, ...args),
  };
}

/**
 * Builds the per-run `MigrationContext` from the booted Crowi instance.
 * `broadcastForceReload` is wired through only when the caller (api boot)
 * supplies it; the admin CLI leaves it undefined.
 */
function buildContext(
  crowi: Crowi,
  opts: Required<Pick<RunnerOptions, 'dryRun' | 'progress' | 'logger'>> & Pick<RunnerOptions, 'broadcastForceReload'>,
): MigrationContext {
  const db = crowi.getMongo().connection.db as MigrationDb;

  const rewritePageBody = async (pageId: string, newBody: string, options?: RewritePageBodyOptions): Promise<void> => {
    if (opts.dryRun) return;
    const Page = crowi.model('Page');
    const User = crowi.model('User');
    const page = await Page.findById(pageId).exec();
    if (!page) {
      opts.logger.warn(`rewritePageBody: page ${pageId} not found, skipping`);
      return;
    }
    // Route through the updatePage-equivalent path: it repoints
    // currentRevision and nulls yjsState / yjsCheckpointAt (page.ts), so the
    // next onLoadDocument rebuilds the Y.Doc from the new body (§4.3.1).
    const actingUserId = options?.userId ?? page.lastUpdateUser?.toString?.() ?? page.creator?.toString?.();
    const user = actingUserId ? await User.findById(actingUserId).exec() : null;
    // preserveTimestamps: a body-rewrite migration is a non-destructive,
    // forward-only fixup. It must NOT bump the page's `updatedAt` (which would
    // reorder recently-updated lists) nor overwrite `lastUpdateUser` with the
    // migration bot. Preserving in place (rather than bumping then restoring)
    // also keeps the search index consistent: the `update` event fires with the
    // original `updatedAt`, so `indexPageInSearch` indexes the original value
    // and never diverges from Mongo (RFC-0008 follow-up — see the migration spec).
    await Page.updatePage(page, newBody, user, { preserveTimestamps: true });
  };

  const invalidateYjsPersistence = async (pageIds: string[]): Promise<void> => {
    if (opts.dryRun || pageIds.length === 0) return;
    const Page = crowi.model('Page');
    // Persistence-layer only: null the snapshot so the next onLoadDocument
    // rebuilds from the current revision. No revision is pushed here (this is
    // the no-body-rewrite case, e.g. after an out-of-band data fix).
    await Page.updateMany({ _id: { $in: pageIds } }, { $set: { yjsState: null, yjsCheckpointAt: null } }).exec();
  };

  return {
    db,
    crowi,
    logger: opts.logger,
    dryRun: opts.dryRun,
    progress: opts.progress,
    rewritePageBody,
    invalidateYjsPersistence,
    broadcastForceReload: opts.broadcastForceReload,
  };
}

/**
 * Resolve a runner's effective options, filling in defaults.
 */
function resolveOptions(
  opts: RunnerOptions,
): Required<Pick<RunnerOptions, 'dryRun' | 'concurrency' | 'appliedBy' | 'progress' | 'logger'>> & Pick<RunnerOptions, 'broadcastForceReload'> {
  return {
    dryRun: opts.dryRun ?? false,
    concurrency: opts.concurrency ?? 8,
    appliedBy: opts.appliedBy ?? `admin-cli@${os.hostname()}`,
    progress: opts.progress ?? noopProgress,
    logger: opts.logger ?? defaultLogger(),
    broadcastForceReload: opts.broadcastForceReload,
  };
}

/**
 * RFC-0008 §4.3 — the shared runner *core*.
 *
 * Holds the booted Crowi, the resolved options, the per-run
 * `MigrationContext` (dry-run / progress / logger / Yjs invalidation), the
 * SIGINT-aware abort flag, and the bounded-concurrency limiter. This is the
 * "shared infrastructure" both namespaces ride on: `migrate` adds the
 * `migrationApplications` reconciliation/record path on top (`MigrationRunner`
 * below), while `rebuild` rides on the core alone with **no** audit-log
 * coupling (`RebuildRunner` in `rebuild-runner.ts`).
 *
 * Keeping the record path out of the core is deliberate (§8.5: rebuilds have
 * "no pending/applied concept"): a rebuild can never accidentally append to
 * `migrationApplications`, and `MigrationRunner.apply` carries no `if (rebuild)`
 * branch — the two namespaces are distinct subclasses, not flags on one path.
 */
export class MigrationRunnerCore {
  protected readonly crowi: Crowi;
  protected readonly opts: ReturnType<typeof resolveOptions>;
  private readonly ctx: MigrationContext;
  protected abortRequested = false;
  private sigintHandler: (() => void) | null = null;

  constructor(crowi: Crowi, options: RunnerOptions = {}) {
    this.crowi = crowi;
    this.opts = resolveOptions(options);
    this.ctx = buildContext(crowi, this.opts);
  }

  /** True once a SIGINT has been received; long stages should wind down. */
  get aborted(): boolean {
    return this.abortRequested;
  }

  /** The shared per-run context handed to migration / rebuild callbacks. */
  get context(): MigrationContext {
    return this.ctx;
  }

  get concurrency(): number {
    return this.opts.concurrency;
  }

  /**
   * Install a SIGINT handler so an in-progress run can stop between
   * stages / units instead of leaving Mongo in an arbitrary state. Returns
   * a disposer; safe to call when no handler is desired (tests pass none).
   */
  installSigintHandler(): () => void {
    if (this.sigintHandler) return () => this.removeSigintHandler();
    const handler = () => {
      this.abortRequested = true;
      this.opts.logger.warn('SIGINT received — finishing the current unit then stopping safely…');
      // Uninstall immediately: `process.on('SIGINT', ...)` disables Node's
      // default terminate-on-SIGINT behavior for as long as ANY listener
      // stays registered, so leaving this one in place would silently
      // swallow a second Ctrl-C instead of letting it fall through to the
      // default (immediate exit) — the one signal an impatient operator
      // needs when "finish the current unit" is taking too long.
      this.removeSigintHandler();
    };
    this.sigintHandler = handler;
    process.on('SIGINT', handler);
    return () => this.removeSigintHandler();
  }

  private removeSigintHandler(): void {
    if (this.sigintHandler) {
      process.off('SIGINT', this.sigintHandler);
      this.sigintHandler = null;
    }
  }

  /**
   * Run a bounded-concurrency map over `items`, respecting the SIGINT abort
   * flag (stops scheduling new work once aborted). Exposed so a stage's `fn`
   * or a rebuild task can fan out per-document work through the shared
   * concurrency limiter.
   */
  async mapBounded<T>(items: readonly T[], worker: (item: T, index: number) => Promise<void>): Promise<{ processed: number; interrupted: boolean }> {
    const limit = Math.max(1, this.opts.concurrency);
    let cursor = 0;
    let processed = 0;
    const runWorker = async (): Promise<void> => {
      while (cursor < items.length && !this.abortRequested) {
        const index = cursor++;
        await worker(items[index], index);
        processed++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runWorker));
    return { processed, interrupted: this.abortRequested };
  }
}

/**
 * The `migrate`-namespace runner. Adds the §6.2 reconciliation rules and the
 * `migrationApplications` audit-log append on top of the shared core. The
 * `rebuild` namespace does NOT extend this — it rides the core directly so it
 * stays free of any applied/pending semantics (§8.5).
 */
export class MigrationRunner extends MigrationRunnerCore {
  /** Cheap pending probe. Never writes; safe to call on every boot (§4.2.1). */
  async isPending(def: MigrationDefinition): Promise<boolean> {
    return def.isPending(this.context);
  }

  /** Rich, optional report for `plan`. Returns null when the migration has no `detect`. */
  async detect(def: MigrationDefinition): Promise<DetectReport | null> {
    if (!def.detect) return null;
    return def.detect(this.context);
  }

  /**
   * Apply a single migration through the framework's reconciliation rules
   * (§6.2): inspection (`isPending`) is the source of truth; the recorded
   * state only affects which `result` label we append.
   *
   *  - pending + no record    → run → `applied`
   *  - pending + applied      → re-run (warn) → `re-applied`
   *  - not pending + no record→ `detected-clean`
   *  - not pending + applied  → no-op (consistent), no new record
   *
   * Appends one `migrationApplications` row per run (except the consistent
   * no-op case). `dryRun` runs `detect`/probe only and records nothing.
   */
  async apply(def: MigrationDefinition): Promise<MigrationRunOutcome> {
    const MigrationApplication = this.crowi.model('MigrationApplication') as MigrationApplicationModel;
    const startedAt = Date.now();

    const pending = await this.isPending(def);
    const latest = await MigrationApplication.latestFor(def.id);
    const recordedApplied = latest?.result === 'applied' || latest?.result === 're-applied';

    // not pending + applied → consistent; nothing to do, no new record.
    if (!pending && recordedApplied) {
      this.opts.logger.debug(`${def.id}: not pending and already applied — skipping`);
      return { id: def.id, result: 'applied', durationMs: 0, stats: {} };
    }

    // not pending + no record → record detected-clean (fresh install path §9.2).
    if (!pending) {
      const durationMs = Date.now() - startedAt;
      if (!this.opts.dryRun) {
        await this.recordApplication(MigrationApplication, def, 'detected-clean', durationMs, {});
      }
      this.opts.logger.info(`${def.id}: detected-clean (nothing to migrate)`);
      return { id: def.id, result: 'detected-clean', durationMs, stats: {} };
    }

    // pending: trust inspection. If already recorded applied, this is a
    // re-run (§6.2) — log a warning and proceed.
    const result: MigrationResult = recordedApplied ? 're-applied' : 'applied';
    if (recordedApplied) {
      this.opts.logger.warn(`${def.id}: recorded as applied but inspection says pending — re-applying (trusting inspection, §6.2)`);
    }

    if (this.opts.dryRun) {
      // Dry-run: run detect for a preview, run no stages, record nothing.
      const report = await this.detect(def);
      this.opts.logger.info(`${def.id}: dry-run — ${report?.summary ?? 'details unavailable (no detect)'}`);
      return { id: def.id, result, durationMs: Date.now() - startedAt, stats: report?.counts ?? {} };
    }

    const stats: Record<string, unknown> = {};
    let interrupted = false;
    try {
      for (const stage of def.stages) {
        if (this.abortRequested) {
          interrupted = true;
          break;
        }
        this.opts.progress.setLabel(`${def.id}:${stage.name}`);
        this.opts.logger.info(`${def.id}: stage ${stage.name} …`);
        const stageResult: StageResult = await stage.fn(this.context);
        stats[stage.name] = { transformed: stageResult.transformed ?? 0, ...(stageResult.stats ?? {}) };
      }
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const message = err instanceof Error ? err.message : String(err);
      await this.recordApplication(MigrationApplication, def, 'failed', durationMs, stats, message);
      throw err;
    }

    const durationMs = Date.now() - startedAt;
    if (interrupted) {
      // Partial completion: record what we did so the next run's
      // reconciliation has the audit trail; isPending will still report
      // pending so the remaining work re-runs.
      await this.recordApplication(MigrationApplication, def, result, durationMs, { ...stats, interrupted: true });
      this.opts.logger.warn(`${def.id}: interrupted by SIGINT after partial completion — re-run to finish`);
      return { id: def.id, result, durationMs, stats, interrupted: true };
    }

    await this.recordApplication(MigrationApplication, def, result, durationMs, stats);
    this.opts.logger.info(`${def.id}: ${result} (${durationMs}ms)`);
    return { id: def.id, result, durationMs, stats };
  }

  private async recordApplication(
    MigrationApplication: MigrationApplicationModel,
    def: MigrationDefinition,
    result: MigrationResult,
    durationMs: number,
    stats: Record<string, unknown>,
    error?: string,
  ): Promise<void> {
    await MigrationApplication.record({
      migrationId: def.id,
      fromVersion: def.fromVersion,
      toVersion: def.toVersion,
      layer: def.layer,
      result,
      durationMs,
      stats,
      appliedBy: this.opts.appliedBy,
      error,
    });
  }
}
