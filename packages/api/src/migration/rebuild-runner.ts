import type Crowi from 'src/crowi';

import { MigrationRunnerCore, type RunnerOptions } from './runner';
import type { MigrationContext } from './types';

/**
 * RFC-0008 §8.5 — rebuild tasks.
 *
 * A *rebuild* regenerates derived data (search index / render cache /
 * backlinks / a fresh copy of stored objects). Unlike a migration it is
 * **version-independent** and has **no pending/applied concept** — it can run
 * any time, any number of times. Consequently a rebuild MUST NOT touch the
 * `migrationApplications` audit log: it shares the runner's *infrastructure*
 * (dry-run / progress / bounded concurrency / SIGINT / structured logging /
 * the per-run `MigrationContext`) via `MigrationRunnerCore`, but rides none of
 * the migrate-only reconciliation/record path.
 *
 * This split keeps `MigrationRunner.apply` free of any `if (rebuild)` branch
 * (the two namespaces are distinct subclasses of the shared core, not flags on
 * one code path), and makes "rebuilds never write audit rows" a structural
 * guarantee rather than a convention.
 */

/** Outcome of a single rebuild run, surfaced to the CLI for the summary block. */
export interface RebuildOutcome {
  /** Stable task id (e.g. 'search', 'storage-copy'). */
  id: string;
  durationMs: number;
  /** True when SIGINT aborted the run before it finished. */
  interrupted: boolean;
  /** Free-form per-task result detail rendered by the CLI. */
  stats: Record<string, unknown>;
}

/**
 * A rebuild task. Receives the shared `MigrationContext` (dry-run / progress /
 * logger / crowi) plus the owning runner so it can fan work out through the
 * shared bounded-concurrency limiter and consult the SIGINT abort flag. It
 * returns its own per-task stats — there is no audit record and no pending
 * probe (§8.5).
 */
export interface RebuildTask {
  /** Stable identifier for logs / summary (e.g. 'search'). */
  id: string;
  /** Short human-readable description. */
  description: string;
  /** Do the work. MUST no-op writes when `ctx.dryRun` is true. */
  run(ctx: MigrationContext, runner: RebuildRunner): Promise<Record<string, unknown>>;
}

/**
 * Identity helper mirroring `defineMigration` so a rebuild module gets
 * inference from a single import.
 */
export function defineRebuild(task: RebuildTask): RebuildTask {
  return task;
}

/**
 * The `rebuild`-namespace runner. Rides the shared `MigrationRunnerCore`
 * (dry-run / progress / SIGINT / bounded concurrency / Yjs ctx) with **no**
 * `migrationApplications` coupling (§8.5).
 */
export class RebuildRunner extends MigrationRunnerCore {
  constructor(crowi: Crowi, options: RunnerOptions = {}) {
    super(crowi, options);
  }

  /**
   * Run one rebuild task through the shared infrastructure. Installs the
   * SIGINT handler for the duration so a long rebuild can wind down safely,
   * and never appends to the audit log (§8.5).
   */
  async run(task: RebuildTask): Promise<RebuildOutcome> {
    const dispose = this.installSigintHandler();
    const startedAt = Date.now();
    try {
      this.context.logger.info(`rebuild ${task.id}: ${task.description}${this.context.dryRun ? ' (dry-run)' : ''}`);
      this.context.progress.setLabel(`rebuild:${task.id}`);
      const stats = await task.run(this.context, this);
      return { id: task.id, durationMs: Date.now() - startedAt, interrupted: this.aborted, stats };
    } finally {
      dispose();
    }
  }
}
