import type { mongo } from 'mongoose';
import type Crowi from 'src/crowi';

/** Raw mongo driver database handle, re-exported by mongoose (no direct `mongodb` dep). */
export type MigrationDb = mongo.Db;

/**
 * RFC-0008 Migration Framework — core type definitions.
 *
 * A *migration* is a one-shot, forward-only transformation from one
 * version's data shape to another's, applied at most once per dataset.
 * Two layers are distinguished by `MigrationLayer`:
 *
 *   - `boot`      — lightweight / safe; applied automatically during the
 *                   api boot sequence (`runBootMigrations`).
 *   - `preflight` — heavy / potentially destructive; invoked explicitly
 *                   from `crowi-admin migrate apply` in a maintenance
 *                   window. Boot only *probes* these (via `isPending`) and
 *                   refuses to start when any is unapplied (§4.2.1/§4.2.7).
 *
 * Index building is deliberately NOT modelled here: per §9, unique indexes
 * are declared on schemas and built by Mongoose's autoIndex. A migration's
 * job is to *prepare data* (e.g. dedup) so autoIndex won't hit E11000 —
 * hence there is no `build-index` stage and no `ownedIndexes`.
 */

export type MigrationLayer = 'boot' | 'preflight';

/**
 * Boot-block classification for a `preflight` migration (RFC-0008 §4.2.7
 * amendment / §12.7).
 *
 *   - `blocking`  — an index-impacting / data-integrity migration (e.g.
 *                   `user-unique-prepare`). When pending, boot is refused
 *                   under the `block` policy (downgradeable to a warning via
 *                   `MIGRATION_PREFLIGHT_UNAPPLIED_POLICY=warn`), because
 *                   booting against not-yet-prepared data risks an autoIndex
 *                   E11000 (§9).
 *   - `cosmetic`  — a display-only migration (no data-integrity hazard), e.g.
 *                   the body-rewriting `wikilink-format` or the path-relocating
 *                   `relocate-reserved-api-paths`. When pending it only ever
 *                   warns and boot continues — independent of the global
 *                   policy. This avoids the structural deadlock where new
 *                   content keeps a corpus-scan `isPending` perpetually true
 *                   (§6.1/§6.2) and would otherwise refuse the whole cluster
 *                   forever (BUG 2).
 *
 * `severity` lives only on a `preflight` migration (see the
 * `MigrationDefinition` discriminated union): `boot`-layer migrations are
 * auto-applied and never boot-probed, so they carry no `severity`.
 */
export type MigrationSeverity = 'cosmetic' | 'blocking';

/**
 * Minimal logger surface the runner hands to a migration. Backed by the
 * runner's structured logger (console / `debug`); kept narrow so a
 * migration can't reach into transport details.
 */
export interface MigrationLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

/**
 * Progress sink for long-running stages. The CLI binds this to a live
 * progress line; boot / tests bind it to a no-op or a counter.
 */
export interface ProgressReporter {
  /** Declare the total unit count for the current stage (enables ETA). */
  setTotal(total: number): void;
  /** Advance the processed count by `delta` (default 1). */
  increment(delta?: number): void;
  /** Set a short human-readable label for the current item / sub-step. */
  setLabel(label: string): void;
}

/** Result of a single stage's `fn`. Folded into the migration's `stats`. */
export interface StageResult {
  /** Stage name (echoed for the application record / logs). */
  name: string;
  /** Rows / documents transformed by this stage (0 in dry-run). */
  transformed?: number;
  /** Free-form per-stage stats merged into `migrationApplications.stats`. */
  stats?: Record<string, unknown>;
}

/** Rich, optional report returned by `detect` and shown by `migrate plan`. */
export interface DetectReport {
  /** One-line summary (e.g. "42 duplicate username groups"). */
  summary: string;
  /** Optional structured counts for `--json` consumers. */
  counts?: Record<string, number>;
}

/**
 * Per-run context handed to `isPending` / `detect` / every stage `fn`.
 *
 * The Yjs-invalidation surface is split per §4.3.1:
 *   - `rewritePageBody` / `invalidateYjsPersistence` are *persistence-layer*
 *     operations available in **all layers** (they route through the
 *     `updatePage`-equivalent path: repoint `currentRevision` + null
 *     `yjsState` / `yjsCheckpointAt`, so the next `onLoadDocument` rebuilds
 *     the `Y.Doc` from the body).
 *   - `broadcastForceReload` is a *live* force-reload broadcast available
 *     **only in `layer='boot'`** migrations (api process with a live
 *     Hocuspocus handle). It is `undefined` in preflight (admin CLI is a
 *     separate, mongo-only process — see §4.3.1).
 */
export interface MigrationContext {
  /** Raw mongo driver handle (for index-backed probes / aggregations). */
  db: MigrationDb;
  /** The booted Crowi instance — gives access to `crowi.model(...)`. */
  crowi: Crowi;
  logger: MigrationLogger;
  /** Stages MUST no-op (no writes) when this is true. */
  dryRun: boolean;
  progress: ProgressReporter;

  /**
   * Persistence-layer Yjs invalidation (all layers): rewrite a page's body
   * via the `updatePage`-equivalent path, repointing `currentRevision` and
   * nulling `page.yjsState` / `yjsCheckpointAt`.
   */
  rewritePageBody: (pageId: string, newBody: string, options?: RewritePageBodyOptions) => Promise<void>;

  /**
   * Persistence-layer Yjs invalidation without a body rewrite: null
   * `yjsState` / `yjsCheckpointAt` for the given pages so the next
   * `onLoadDocument` rebuilds from the current revision.
   */
  invalidateYjsPersistence: (pageIds: string[]) => Promise<void>;

  /**
   * Live force-reload broadcast. Present ONLY in `layer='boot'` migrations
   * (api process with a live Hocuspocus handle); `undefined` in preflight.
   */
  broadcastForceReload?: (pageIds: string[]) => Promise<void>;
}

/** Options for `ctx.rewritePageBody`. */
export interface RewritePageBodyOptions {
  /** Acting user id for the new revision (defaults to the page's lastUpdateUser). */
  userId?: string;
}

/** A named, side-effecting transform. Index building is NOT a stage (§9). */
export interface MigrationStage {
  /** Label for logging / progress (e.g. 'dedup-username'). */
  name: string;
  /** Must no-op when `ctx.dryRun` is true. */
  fn: (ctx: MigrationContext) => Promise<StageResult>;
}

/** Fields shared by every migration, independent of `layer`. */
interface MigrationDefinitionBase {
  /** Stable identifier. Convention: dateless kebab-case slug (§5.4). */
  id: string;

  /** Version range this migration covers (e.g. '1.x' → '2.0'). */
  fromVersion: string;
  toVersion: string;

  /** Short, human-readable description (shown by `plan` / `list`). */
  description: string;

  /**
   * Execution order within the same version range. Defaults to registry
   * insertion order when omitted (§5.3).
   */
  order?: number;

  /** Side-effecting transforms, executed in declaration order. */
  stages: MigrationStage[];

  /**
   * REQUIRED. A cheap pending probe — O(1) or index-backed. Called on every
   * boot for every instance (§4.2.1), so it MUST NOT be a full-collection
   * scan. For a `blocking` `preflight` migration under `block`, a false
   * positive refuses boot for the whole cluster (§4.2.7), so authors must
   * write this conservatively (§6.2).
   */
  isPending: (ctx: MigrationContext) => Promise<boolean>;

  /**
   * OPTIONAL. A detailed report for `plan` — may be a full scan. Not called
   * at boot. When omitted, `plan` shows "details unavailable" and relies on
   * the `isPending` verdict.
   */
  detect?: (ctx: MigrationContext) => Promise<DetectReport>;
}

/**
 * A `preflight` migration: heavy / potentially destructive, applied explicitly
 * from `crowi-admin migrate apply`. Boot only *probes* these and, per the
 * REQUIRED `severity`, either refuses boot (`blocking` under `block`) or warns
 * and continues (`cosmetic`, always). `severity` has no default — omitting it
 * is a compile error, so every preflight migration is forced to declare its
 * boot-block risk (§4.2.7 amendment / §12.7).
 */
export interface PreflightMigrationDefinition extends MigrationDefinitionBase {
  layer: 'preflight';
  severity: MigrationSeverity;
}

/**
 * A `boot` migration: lightweight / safe, auto-applied during the boot
 * sequence. It is never boot-probed, so it carries no `severity` — boot-block
 * risk is a `preflight`-only concept.
 */
export interface BootMigrationDefinition extends MigrationDefinitionBase {
  layer: 'boot';
}

/**
 * A migration definition. The `layer` discriminant decides whether a
 * `severity` is required: a `preflight` migration declares one (it gates
 * boot), a `boot` migration does not (auto-applied, never probed).
 */
export type MigrationDefinition = PreflightMigrationDefinition | BootMigrationDefinition;

/**
 * Identity helper that attaches the `MigrationDefinition` type to a literal
 * so migration modules get inference + a single import to depend on. Returns
 * its argument unchanged (no runtime behaviour, mirrors `defineConfig`-style
 * helpers).
 */
export function defineMigration<T extends MigrationDefinition>(def: T): T {
  return def;
}
