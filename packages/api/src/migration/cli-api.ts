import type Crowi from 'src/crowi';
import type { MigrationApplicationModel } from 'src/models/migration-application';

import { createRegistry, type MigrationRegistry } from './registry';
import { MigrationRunner, type RunnerOptions } from './runner';
import type { DetectReport, MigrationDefinition, MigrationLayer } from './types';

/**
 * RFC-0008 §8 — the api-side surface the `@crowi/admin-cli` `migrate` /
 * `rebuild` commands consume.
 *
 * The admin CLI is a separate, lightweight process that `require`s the api's
 * compiled `dist/` (see `commands/*.ts` `loadApi()` rationale). Rather than
 * have the CLI reach into `registry.ts` / `runner.ts` individually, this
 * module exposes a small, stable façade so the CLI's structural types stay
 * narrow and the framework internals can evolve without touching the CLI.
 *
 * No live Hocuspocus handle is wired here: the CLI runs preflight migrations
 * mongo-only, so `broadcastForceReload` is intentionally absent (§4.3.1).
 */

/** One row in `migrate list` / `migrate plan`. */
export interface MigrationSummary {
  id: string;
  fromVersion: string;
  toVersion: string;
  layer: MigrationLayer;
  description: string;
}

export interface MigrationPlanEntry extends MigrationSummary {
  pending: boolean;
  /** `detect` report when the migration provides one, else null. */
  detail: DetectReport | null;
}

export interface MigrationStatusEntry {
  migrationId: string;
  result: string;
  appliedAt: Date;
  durationMs?: number;
  appliedBy?: string;
}

export interface MigrationStatus {
  latestTarget: string | null;
  recent: MigrationStatusEntry[];
  pendingPreflight: number;
  pendingBoot: number;
}

function toSummary(def: MigrationDefinition): MigrationSummary {
  return {
    id: def.id,
    fromVersion: def.fromVersion,
    toVersion: def.toVersion,
    layer: def.layer,
    description: def.description,
  };
}

/**
 * Façade over the registry + runner for the CLI. Constructed against a
 * booted (`initForCli`) Crowi instance.
 */
export class MigrationCliApi {
  private readonly crowi: Crowi;
  private readonly registry: MigrationRegistry;

  constructor(crowi: Crowi, registry: MigrationRegistry = createRegistry()) {
    this.crowi = crowi;
    this.registry = registry;
  }

  /** `migrate list` — all registered migrations in order. */
  list(): MigrationSummary[] {
    return this.registry.all().map(toSummary);
  }

  /** The latest reachable target version (or null when registry is empty). */
  latestTarget(): string | null {
    return this.registry.latestTarget();
  }

  private buildRunner(options: RunnerOptions = {}): MigrationRunner {
    return new MigrationRunner(this.crowi, options);
  }

  /**
   * `migrate plan` — pending migrations + (where available) a `detect`
   * preview. `allLayers` extends from preflight-only (default) to both
   * layers (§4.2.2).
   */
  async plan(options: { allLayers?: boolean } = {}): Promise<MigrationPlanEntry[]> {
    const runner = this.buildRunner();
    const layers: MigrationLayer[] = options.allLayers ? ['boot', 'preflight'] : ['preflight'];
    const entries: MigrationPlanEntry[] = [];
    for (const layer of layers) {
      for (const def of this.registry.byLayer(layer)) {
        const pending = await runner.isPending(def);
        const detail = pending ? await runner.detect(def) : null;
        entries.push({ ...toSummary(def), pending, detail });
      }
    }
    return entries;
  }

  /**
   * `migrate apply` — apply pending preflight migrations (or both layers
   * with `allLayers`), in order. `dryRun` runs detect only. A single `id`
   * narrows to one migration. Returns per-migration outcomes.
   */
  async apply(
    options: { allLayers?: boolean; dryRun?: boolean; id?: string; continueOnError?: boolean } = {},
  ): Promise<{ id: string; result: string; durationMs: number }[]> {
    const runner = this.buildRunner({ dryRun: options.dryRun });
    const dispose = runner.installSigintHandler();
    const layers: MigrationLayer[] = options.allLayers ? ['boot', 'preflight'] : ['preflight'];
    const targets: MigrationDefinition[] = [];
    for (const layer of layers) {
      for (const def of this.registry.byLayer(layer)) {
        if (options.id && def.id !== options.id) continue;
        targets.push(def);
      }
    }

    const outcomes: { id: string; result: string; durationMs: number }[] = [];
    try {
      for (const def of targets) {
        try {
          const outcome = await runner.apply(def);
          outcomes.push({ id: outcome.id, result: outcome.result, durationMs: outcome.durationMs });
        } catch (err) {
          if (!options.continueOnError) throw err;
          outcomes.push({ id: def.id, result: 'failed', durationMs: 0 });
        }
        if (runner.aborted) break;
      }
    } finally {
      dispose();
    }
    return outcomes;
  }

  /** `migrate status` — recent applications + pending counts. */
  async status(recentLimit = 10): Promise<MigrationStatus> {
    const runner = this.buildRunner();
    const MigrationApplication = this.crowi.model('MigrationApplication') as MigrationApplicationModel;
    const recentDocs = await MigrationApplication.recent(recentLimit);

    let pendingPreflight = 0;
    for (const def of this.registry.byLayer('preflight')) {
      if (await runner.isPending(def)) pendingPreflight++;
    }
    let pendingBoot = 0;
    for (const def of this.registry.byLayer('boot')) {
      if (await runner.isPending(def)) pendingBoot++;
    }

    return {
      latestTarget: this.registry.latestTarget(),
      recent: recentDocs.map(
        (d): MigrationStatusEntry => ({
          migrationId: d.migrationId,
          result: d.result,
          appliedAt: d.appliedAt,
          durationMs: d.durationMs,
          appliedBy: d.appliedBy,
        }),
      ),
      pendingPreflight,
      pendingBoot,
    };
  }
}

/** Convenience factory used by the CLI's `require(dist/migration/cli-api)`. */
export function createMigrationCliApi(crowi: Crowi): MigrationCliApi {
  return new MigrationCliApi(crowi);
}
