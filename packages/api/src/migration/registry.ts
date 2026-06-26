import type { MigrationDefinition, MigrationLayer } from './types';
import { allMigrations } from './migrations';

/**
 * RFC-0008 §5.5 — the migration registry.
 *
 * Loads every `MigrationDefinition` from the `migrations/` barrel and
 * exposes them in a stable, deterministic order: by version range, then by
 * `order` within the same range (defaulting to declaration order). There is
 * no cross-migration dependency graph (§5.3) — version range + `order` is
 * the only ordering input.
 *
 * The registry is intentionally a pure, in-memory structure with no DB
 * access; pending determination and application live in `runner.ts`.
 */

/**
 * Parse a version string into a comparable numeric tuple. We only need a
 * total order over the handful of ranges this codebase uses ('1.x', '2.0',
 * '2.1', ...). 'x' / missing minor sorts as 0 so '1.x' precedes '2.0'.
 *
 * This is deliberately lenient (not full semver): migration versions are
 * coarse upgrade milestones, not package versions.
 */
function versionKey(version: string): [number, number] {
  const [majorRaw, minorRaw] = version.split('.');
  const major = Number.parseInt(majorRaw ?? '0', 10);
  const minor = minorRaw === undefined || minorRaw === 'x' ? 0 : Number.parseInt(minorRaw, 10);
  return [Number.isNaN(major) ? 0 : major, Number.isNaN(minor) ? 0 : minor];
}

function compareVersion(a: string, b: string): number {
  const [aMaj, aMin] = versionKey(a);
  const [bMaj, bMin] = versionKey(b);
  if (aMaj !== bMaj) return aMaj - bMaj;
  return aMin - bMin;
}

/**
 * Total order over migrations: by `fromVersion`, then `toVersion`, then
 * `order` (defaulting to the migration's index in the source array so the
 * sort is stable and mirrors declaration order).
 */
function compareMigrations(a: MigrationDefinition, b: MigrationDefinition, indexOf: Map<string, number>): number {
  const fromCmp = compareVersion(a.fromVersion, b.fromVersion);
  if (fromCmp !== 0) return fromCmp;
  const toCmp = compareVersion(a.toVersion, b.toVersion);
  if (toCmp !== 0) return toCmp;
  const aOrder = a.order ?? indexOf.get(a.id) ?? 0;
  const bOrder = b.order ?? indexOf.get(b.id) ?? 0;
  if (aOrder !== bOrder) return aOrder - bOrder;
  return (indexOf.get(a.id) ?? 0) - (indexOf.get(b.id) ?? 0);
}

export class MigrationRegistry {
  private readonly migrations: MigrationDefinition[];

  constructor(defs: MigrationDefinition[]) {
    // Guard against duplicate ids early — ids are stable keys in
    // `migrationApplications`, so a collision would corrupt the audit log.
    const seen = new Set<string>();
    for (const def of defs) {
      if (seen.has(def.id)) {
        throw new Error(`Duplicate migration id in registry: '${def.id}'`);
      }
      seen.add(def.id);
    }

    const indexOf = new Map(defs.map((def, i) => [def.id, i] as const));
    this.migrations = [...defs].sort((a, b) => compareMigrations(a, b, indexOf));
  }

  /** All migrations in version-range + `order` sequence. */
  all(): readonly MigrationDefinition[] {
    return this.migrations;
  }

  /**
   * Migrations of a given layer, in order. The return type narrows by the
   * `layer` literal so `byLayer('preflight')` yields `severity`-bearing
   * definitions (and `byLayer('boot')` ones without).
   */
  byLayer<L extends MigrationLayer>(layer: L): readonly Extract<MigrationDefinition, { layer: L }>[] {
    return this.migrations.filter((m): m is Extract<MigrationDefinition, { layer: L }> => m.layer === layer);
  }

  /** Look up a migration by id, or undefined. */
  get(id: string): MigrationDefinition | undefined {
    return this.migrations.find((m) => m.id === id);
  }

  /** The latest reachable target version across all registered migrations. */
  latestTarget(): string | null {
    if (this.migrations.length === 0) return null;
    return this.migrations.reduce((latest, m) => (compareVersion(m.toVersion, latest) > 0 ? m.toVersion : latest), this.migrations[0].toVersion);
  }
}

/** The default registry built from the `migrations/` barrel. */
export function createRegistry(defs: MigrationDefinition[] = allMigrations): MigrationRegistry {
  return new MigrationRegistry(defs);
}
