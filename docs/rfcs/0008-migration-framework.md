# RFC-0008: Migration Framework

- Status: Draft
- Created: 2026-06-03
- Supersedes: None
- Related: RFC-0004 (Page Status), `feature-user-identity-uniqueness`

---

## §0 Summary

Crowi's existing admin operations (`wikilink-migrate` / `migrate-wikilink` / `search-rebuild` / `storage-copy`, etc.) and boot-time incremental migrations (`migrateConfig` / `runAwsConfigMigration` / the RFC-0004 page status backfill) are reorganized under a single **migration framework**.

The admin CLI is split into **two command namespaces**:

- `crowi-admin migrate ...` — **one-shot migrations** (forward-only; gating conditions for reaching a target version)
- `crowi-admin rebuild ...` — **operational rebuilds** (regeneration of derived data; can be run any time, any number of times)

The `migrate` namespace is further divided into a **boot-auto layer** and a **preflight layer**: lightweight, safe migrations run automatically during the boot sequence, while heavy or destructive migrations must be invoked explicitly from the admin CLI. Pending state is determined by **data inspection** as the source of truth; an applied-record collection is maintained separately as an **append-only audit log**.

---

## §1 Background / Motivation

### §1.1 Problems with the current command surface

Admin operations have been added ad hoc, one at a time, whenever a need arose:

- `wikilink-migrate` / `migrate-wikilink` (the naming itself is inconsistent)
- `search-rebuild`
- `storage-copy`
- (planned) `renderer:rebuild` / `revisions-schema-unify` / `prepare-unique`

These conflate two fundamentally different kinds of operation: **one-shot data migrations required to reach a target version**, and **operational regeneration of derived data**. There is no shared design: naming, arguments, dry-run support, and idempotency vary per command, and operators have no consistent basis for deciding what to run and when.

### §1.2 Boot-time incremental migrations already exist

Meanwhile, the boot init sequence in `packages/api/src/crowi/index.ts` already contains several migration steps:

- `migrateConfig`
- `runAwsConfigMigration`
- The RFC-0004 page status backfill

These already amount to "booting v2 = progressively migrating the connected DB," but this is **not formalized as a framework**. Each new migration requires direct edits to the boot code, with no shared registration surface, ordering, application record, dry-run, or testing.

### §1.3 The v1→v2 upgrade as the largest use case

The discussion around `feature-user-identity-uniqueness` made the in-place v1→v2 upgrade runbook concrete:

1. v1 stays up (with a maintenance window or read-only mode if needed).
2. v2 is brought up, pointed at the v1 mongo (or a restored copy for rollback safety). `REDIS` and storage are configured. The web installer is not opened (and would be rejected as `already_installed` anyway).
3. The admin CLI is used to run **preflight** checks against mongo before go-live:
   - `crowi-admin migrate plan` to see what needs to be done
   - Execute as needed to resolve
4. Start v2 (boot's automatic migrations run) → smoke-test → cut traffic over.

In other words, **the migration framework is the implementation substrate for the v1→v2 upgrade guide**. Without it, upgrade procedures degrade into oral tradition in the runbook, with no reproducibility or testability.

### §1.4 The autoIndex problem

Mongoose attempts to build any index declared on a schema at boot time (`autoIndex: true`). When a v1→v2 transition introduces a **new index with a unique constraint**, starting v2 with duplicate data still present causes **boot to fail with E11000**. This was surfaced by the uniqueness work, but the same hazard applies to any future migration that adds a unique constraint. The framework must define **how to safely sequence index-building migrations**.

---

## §2 Goals / Non-Goals

### §2.1 Goals

- Consolidate scattered admin operations under two namespaces: `crowi-admin migrate ...` and `crowi-admin rebuild ...`.
- Let operators inspect, ahead of time, **which version-to-version transition** each migration covers and **what will happen** when it runs.
- Make **plan / dry-run → apply** the framework's default flow.
- Formalize the **two-layer split** between boot-auto and explicit preflight.
- Define a standard pattern for **index construction that does not rely on autoIndex**.
- Consolidate existing boot migrations (`migrateConfig`, etc.) under the framework.
- Reach a state where the v1→v2 upgrade procedure is expressible as a reproducible runbook in terms of framework commands.

### §2.2 Non-Goals

- **Plugin-provided migrations**: out of scope for v1. The framework only manages migrations shipped with core (revisited in §12).
- **General-purpose recovery tooling** such as merging two arbitrary users (e.g. `crowi-admin user merge <from> <to>`) is out of scope.
- **Version-specific upgrade procedures** beyond v1→v2 are deferred to a separate upgrade guide document. This RFC focuses on framework design.
- **Rollback (down migrations)** is not provided. The framework is forward-only; rollback is handled at the operational level via mongo snapshot/restore.

---

## §3 Terminology

- **Migration**: A one-shot, forward-only transformation from one version's data shape to another's, applied at most once for a given dataset. Lives under the `migrate` namespace.
- **Rebuild task**: A regeneration of derived data. Independent of version; can be run any time, any number of times. Lives under the `rebuild` namespace.
- **Layer**: Distinguishes whether a migration runs automatically during the boot sequence (`boot`) or only when invoked from the admin CLI (`preflight`).
- **Pending**: The "should be applied but hasn't been" state. In this RFC, pending is judged by **data inspection** (§6).
- **Applied**: There is a record in the `migrationApplications` collection (§7). Judged independently of pending.
- **Stage**: An internal step that composes a migration (`detect` / `transform` / `build-index`, etc.).

---

## §4 Overall architecture

### §4.1 Two command namespaces

```
crowi-admin migrate ...       # (A) one-shot migrations (forward-only)
  plan       [--to <ver>] [--preflight-only] [--id <id>]
  apply      [--dry-run] [--id <id>]
  status
  list

crowi-admin rebuild ...       # (B) operational rebuilds (any time, any number of times)
  renderer   [--only-stale] [--dry-run]
  search     [--dry-run]
  backlink   [--dry-run]
  storage-copy <args>         # existing storage-copy relocated under rebuild
```

**Removed commands** (no compatibility aliases — full removal):

- `wikilink-migrate` / `migrate-wikilink` → `crowi-admin migrate apply --id wikilink-format`
- `search-rebuild` → `crowi-admin rebuild search`
- `renderer:rebuild` → `crowi-admin rebuild renderer`
- `storage-copy` → `crowi-admin rebuild storage-copy`

Aliases are intentionally not provided. Part of the motivation for this RFC is to eliminate the unsystematic command surface that accreted over time; keeping aliases would let the old design persist semantically.

### §4.2 Two layers under `migrate`

Each migration declares a **`layer`**:

| layer | When it runs | Examples | Characteristics |
|---|---|---|---|
| `boot` | Detected and applied automatically by the framework during the application boot sequence | `migrateConfig`, `runAwsConfigMigration`, `page-status-default` | Lightweight, safe, short-running. Operators don't need to know they exist. |
| `preflight` | Invoked explicitly from the admin CLI (boot does not run them, but **does detect** unapplied ones) | `prepare-unique`, `wikilink-format`, `revisions-schema-unify` | Heavy, potentially destructive, long-running. Run during a maintenance window before go-live. |

#### §4.2.1 Boot sequence behavior

```
1. The framework loads all migrations from the registry.
2. For each migration with layer='boot', call isPending().
   - If pending, apply it in order; append the result to migrationApplications.
3. For each migration with layer='preflight', call isPending().
   - If any are pending, refuse boot (default) or warn only (configurable).
4. Start the application.
```

Boot refusal when preflight migrations are unapplied is the framework's key safety net. If `prepare-unique` hasn't been run before bringing up v2, this fails fast with a clear error before autoIndex itself fails with E11000. The behavior is configurable via `migration.preflightUnappliedPolicy: 'block' | 'warn'` (default `block`).

#### §4.2.2 Admin CLI behavior

`crowi-admin migrate plan` / `apply` default to operating on `layer='preflight'` migrations only. `layer='boot'` is left to the boot sequence. Passing `--all-layers` extends operation to both layers (for debugging and investigation).

### §4.3 Shared internal runner

Although `migrate` (A) and `rebuild` (B) are separate command namespaces, **they share the internal runner implementation**. Concerns the runner standardizes:

- A standard `--dry-run` interface
- Progress reporting (counts, ETA, current id being processed)
- Safe handling of interruption (SIGINT) and partial completion
- Bounded concurrency (relevant for the embed plugin's rate limits)
- **The Yjs force-reload chain** (the mechanism that triggers Yjs document reloads when body content is rewritten)
- Structured logging (with a JSON output option)

The runner lives under e.g. `packages/api/src/migration/runner.ts` and is invoked by both (A) and (B).

---

## §5 Migration definition interface

Each migration is declared with the following interface:

```ts
// packages/api/src/migration/types.ts

export type MigrationLayer = 'boot' | 'preflight';

export type MigrationStage =
  | { kind: 'detect';      fn: (ctx: MigrationContext) => Promise<DetectResult> }
  | { kind: 'transform';   fn: (ctx: MigrationContext) => Promise<TransformResult> }
  | { kind: 'build-index'; collection: string; indexSpec: object; options?: object };

export interface MigrationDefinition {
  /** Unique identifier. Naming convention: `YYYY-MM-<kebab-case-name>` */
  id: string;

  /** The version range this migration covers */
  fromVersion: string;   // e.g. '1.x' | '2.0' | '2.1'
  toVersion:   string;   // e.g. '2.0' | '2.1' | '2.2'

  layer: MigrationLayer;

  /** Short, human-readable description (shown by plan / list) */
  description: string;

  /** Execution order within the same version range (defaults to registry insertion order) */
  order?: number;

  /** Stages, executed in declaration order */
  stages: MigrationStage[];

  /**
   * Pending check. By default the framework invokes the `detect` stage.
   * Override here when pending should be judged by something other than detect.
   */
  isPending?: (ctx: MigrationContext) => Promise<boolean>;

  /**
   * Indexes "owned" by this migration. Schemas exclude these indexes from
   * autoIndex consideration. See §9.
   */
  ownedIndexes?: Array<{ collection: string; name: string }>;
}
```

### §5.1 Why stages

Stages exist to **clearly separate dry-run from execution**:

- `detect` stages are **observation only** (no side effects). `--dry-run` runs through these and reports counts.
- `transform` stages **mutate data** (side effects). Only executed under `apply`.
- `build-index` stages **build indexes** (background build, independent of autoIndex).

For `prepare-unique`:

```ts
defineMigration({
  id: '2026-06-user-unique-prepare',
  fromVersion: '1.x',
  toVersion: '2.0',
  layer: 'preflight',
  description: 'Deduplicate users by username/email and build collation+partial unique index',
  stages: [
    { kind: 'detect',     fn: detectDuplicateUsers },      // report duplicate counts
    { kind: 'transform',  fn: dedupUsers },                // minimal merge logic
    { kind: 'build-index',                                  // collation+partial unique index
      collection: 'users',
      indexSpec: { username: 1 },
      options: {
        unique: true,
        collation: { locale: 'en', strength: 2 },
        partialFilterExpression: {
          status: { $ne: STATUS_DELETED },
          username: { $type: 'string', $ne: '' },
        },
        background: true,
        name: 'username_unique_ci_partial',
      } },
    { kind: 'build-index',
      collection: 'users',
      indexSpec: { email: 1 },
      options: { /* ... */ name: 'email_unique_ci_partial' } },
  ],
  ownedIndexes: [
    { collection: 'users', name: 'username_unique_ci_partial' },
    { collection: 'users', name: 'email_unique_ci_partial' },
  ],
});
```

### §5.2 Registry

Migration files live under `packages/api/src/migration/migrations/` and are auto-registered from an index file at framework startup. Migrations are grouped by `fromVersion` / `toVersion`, ordered within a range by `order` (defaulting to registration order).

---

## §6 Pending determination

### §6.1 Principle: data inspection is the source of truth

Pending state is determined by **executing the migration's `detect` stage (or its custom `isPending` function)**. The `migrationApplications` collection is an **audit log**, not the source of truth for pending state.

Rationale:

- Crowi's existing boot migrations (`migrateConfig`, etc.) already operate on the "detect every boot, idempotently" model. This is the codebase's prevailing style.
- Operationally, what we actually want to know is **whether migration-target data is still present**, not just whether something was recorded as applied. A pure ledger model cannot catch "recorded as applied but data still leftover" incidents.
- The `prepare-unique` dry-run ("report how many duplicates remain") **is** the pending check.

### §6.2 Reconciling inspection vs. recorded state

When the inspection result and the latest application record disagree, **always trust the inspection result (the actual state)**. The framework behaves as follows:

| Inspection | Latest record | Framework action |
|---|---|---|
| pending (data present) | none | Run normally → append a record with `result: 'applied'`. |
| pending (data present) | `applied` | **Trust inspection; re-run.** Append a record with `result: 're-applied'`, with a warning log: "previously applied but target data is present." |
| not pending (clean) | none | **Skip execution.** Append a record with `result: 'detected-clean'`. |
| not pending (clean) | `applied` | Do nothing (consistent state; no record needed). |

Implications:

- **Fresh installs** start in v2-shape, so every past migration records `detected-clean` once. There is no risk of mass-running all historical migrations on a clean DB.
- If data is **manually reintroduced** or a **bug caused leftover items**, the inspection will flag pending and re-run (safe because migrations are idempotent).
- Each migration's `detect` function carries **authoring responsibility for coverage**. **False negatives are the most dangerous outcome** (data left behind that nothing flags), so PR review must include "does this detect catch all targets?" as a required check. **False positives are tolerable** (a wasteful re-run, but idempotent — same result).

---

## §7 The `migrationApplications` collection

### §7.1 Schema

```ts
// packages/api/src/models/migration-application.ts
const migrationApplicationSchema = new Schema({
  migrationId:  { type: String, required: true, index: true },
  fromVersion:  { type: String },
  toVersion:    { type: String },
  layer:        { type: String, enum: ['boot', 'preflight'] },
  result:       {
    type: String,
    enum: ['applied', 'detected-clean', 're-applied', 'failed'],
    required: true,
  },
  appliedAt:    { type: Date, default: Date.now, index: true },
  durationMs:   { type: Number },
  stats:        { type: Schema.Types.Mixed },   // detected / transformed / indexBuilt, etc.
  appliedBy:    { type: String },                // 'boot-auto' | `admin-cli@${hostname}`
  error:        { type: String },                // only when result === 'failed'
}, { timestamps: true });
```

### §7.2 Append-only

This collection is treated as **append-only**. Multiple documents per `migrationId` are expected:

- One on initial application
- One per re-run (`re-applied`)
- One per inspection-only outcome (`detected-clean`)
- One per failure (`failed`)

"Latest applied state" is derived by fetching the most recent document for a given `migrationId`. Benefits:

- The audit requirement (who ran what, when, how many records affected) is satisfied naturally.
- The history of "missed-and-rerun" cycles is preserved.
- Failure counts and duration trends are available for analysis.

### §7.3 Self-bootstrapping

The `migrationApplications` collection itself is **excluded from migration management**:

- It is created from schema declaration alone (autoIndex exception, or by an explicit `ensureIndexes` call at framework startup).
- **No migration may modify this collection's schema.** This avoids a chicken-and-egg problem. If a future framework version requires a breaking change to this collection, it will be handled by a separate design (a "framework v2" RFC).

---

## §8 Subcommand specifications

### §8.1 `migrate plan`

Lists pending migrations. Used to **preview what will happen**.

```
$ crowi-admin migrate plan
Current data version: 1.x (detected from data)
Target:               2.0 (latest)

Preflight migrations to apply:
  [1/3] 2026-06-user-unique-prepare       (1.x → 2.0)
        Deduplicate users by username/email and build unique indexes
        Detected: 42 duplicate username groups, 17 duplicate email groups
        Stages: detect → transform → build-index×2

  [2/3] 2025-09-wikilink-format            (1.x → 2.1)
        Migrate </path> wikilink syntax to [[path]]
        Detected: 1,283 pages contain legacy wikilink syntax

  [3/3] 2025-12-revisions-schema-unify     (2.0 → 2.1)
        Unify revision document schema (add type:'snapshot')
        Detected: 8,442 revision documents missing 'type' field

Boot migrations (will run on next startup):
  - migrateConfig                          (boot, auto)
  - page-status-default                    (boot, auto, detected: 0 — already clean)

Run `crowi-admin migrate apply` to execute preflight migrations.
```

Options:

- `--to <ver>`: restrict to migrations required to reach the given version
- `--id <id>`: show a specific migration only
- `--preflight-only`: preflight layer only (default)
- `--all-layers`: include the boot layer
- `--json`: machine-readable output (for CI / scripting)

### §8.2 `migrate apply`

Applies pending preflight migrations in order.

```
$ crowi-admin migrate apply
[1/3] 2026-06-user-unique-prepare ...
  detect:      42 duplicate username groups, 17 duplicate email groups
  transform:   merging 59 user records ... done (3.2s)
  build-index: users.username_unique_ci_partial ... done (1.1s)
  build-index: users.email_unique_ci_partial    ... done (0.9s)
  → applied (5.2s)

[2/3] 2025-09-wikilink-format ...
  ...
```

Options:

- `--dry-run`: execute `detect` stages only (equivalent to `plan`, but the `apply --dry-run` form expresses "intent to apply, trial run")
- `--id <id>`: apply a specific migration only (after dependency checks)
- `--yes`: skip interactive confirmation
- `--continue-on-error`: keep going on failure (default: abort)

### §8.3 `migrate status`

Shows the current data version and a summary of applications.

```
$ crowi-admin migrate status
Data version (inferred): 1.x
Latest target:           2.0

Recent applications (last 10):
  2026-06-03  applied        2026-06-user-unique-prepare       (5.2s)
  2026-06-01  detected-clean page-status-default               (0.1s, boot)
  2026-06-01  applied        migrateConfig                     (0.3s, boot)
  ...

Pending preflight:  2 migrations
Pending boot:       0 migrations
```

### §8.4 `migrate list`

Lists all defined migrations, regardless of pending state.

```
$ crowi-admin migrate list
ID                              from → to    layer       description
migrateConfig                   *    → 2.0   boot        Config schema migration
page-status-default             1.x  → 2.0   boot        Backfill page.status (RFC-0004)
2026-06-user-unique-prepare     1.x  → 2.0   preflight   Deduplicate users + unique index
2025-09-wikilink-format         1.x  → 2.1   preflight   Migrate wikilink syntax
2025-12-revisions-schema-unify  2.0  → 2.1   preflight   Unify revision schema
```

### §8.5 `rebuild <target>`

```
$ crowi-admin rebuild renderer [--only-stale] [--dry-run]
$ crowi-admin rebuild search   [--dry-run]
$ crowi-admin rebuild backlink [--dry-run]
$ crowi-admin rebuild storage-copy <args>
```

Each target is a simple dispatcher to a rebuild task registered in the framework. There is no pending/applied concept here — rebuilds are run as an operational decision. `--dry-run` and progress reporting use the same runner infrastructure as (A).

---

## §9 autoIndex policy

### §9.1 Policy: enforce `autoIndex: false` in production

Production deployments **must** run Mongoose with `autoIndex: false`. Indexes are **not** created from schema declarations at boot; they are **all built by migrations** via `build-index` stages.

Rationale:

- autoIndex causes immediate boot death (E11000) when duplicate data is still present, which directly conflicts with the "clean up data before applying the constraint" model of preflight migrations.
- Index builds on large collections take time. Boot blocking for foreground index builds is operationally undesirable.
- Having a single rule — "indexes are migration-owned" — avoids autoIndex guards and ad hoc `index: false` declarations scattered across schemas.

`autoIndex: true` is permitted in development (for DX).

### §9.2 Implementation

```ts
// mongoose connect options
mongoose.connect(uri, {
  autoIndex: process.env.NODE_ENV !== 'production',
});
```

Any migration introducing a new index includes a `build-index` stage and declares the index name in `ownedIndexes`. The framework emits a warning (eventually an error) at startup if it detects `autoIndex: true` in production.

### §9.3 Handling existing schema declarations

Existing unique constraints and index declarations on schemas are rationalized during the framework migration:

- Indexes already present in the DB → leave them in place. Define a corresponding `build-index` stage as a "no-op for existing environments, builder for new environments." Such a migration records `detected-clean` for existing deployments.
- Newly introduced indexes → must go through a migration.

---

## §10 Migration plan for existing implementation

### §10.1 Promote boot migrations into the framework

The following items, currently inlined in `packages/api/src/crowi/index.ts`, are re-registered as `layer: 'boot'` migrations:

| Current | New |
|---|---|
| `migrateConfig` | `defineMigration({ id: 'migrate-config', layer: 'boot', ... })` |
| `runAwsConfigMigration` | `defineMigration({ id: 'aws-config-migrate', layer: 'boot', ... })` |
| RFC-0004 page status backfill | `defineMigration({ id: 'page-status-default', layer: 'boot', ... })` |

The boot sequence is reduced to a single `runBootMigrations()` invocation.

### §10.2 Removal of legacy admin commands

| Old command | Replacement |
|---|---|
| `wikilink-migrate` / `migrate-wikilink` | `crowi-admin migrate apply --id wikilink-format` (defined as a new preflight migration) |
| `search-rebuild` | `crowi-admin rebuild search` |
| `storage-copy` | `crowi-admin rebuild storage-copy` |
| (planned) `renderer:rebuild` | `crowi-admin rebuild renderer` |
| (planned) `revisions-schema-unify` | `crowi-admin migrate apply --id revisions-schema-unify` (defined as a preflight migration) |

No compatibility aliases. Announced in the CHANGELOG and upgrade guide.

### §10.3 Rollout order

1. Implement the framework core (runner, registry, types, `migrationApplication` model, CLI scaffolding).
2. Move existing boot migrations under the framework (preserving observed behavior).
3. Implement uniqueness `prepare-unique` as the first preflight migration.
4. Implement `wikilink-format` and `revisions-schema-unify` as preflight migrations.
5. Move rebuild tasks (renderer / search / backlink / storage-copy) under the framework.
6. Switch production to `autoIndex: false`.

Each stage keeps the legacy code path alongside the new one for verification, with the old entry points removed at the end.

---

## §11 Worked example: `prepare-unique` (uniqueness preflight migration)

`prepare-unique` from `feature-user-identity-uniqueness` is the prototype preflight migration under this framework. The full definition is in §5.1. Key points:

- **layer**: `preflight` (heavy and destructive; run in a maintenance window)
- **fromVersion → toVersion**: `1.x → 2.0`
- **stages**:
  1. `detect`: aggregate duplicate usernames / emails; return counts
  2. `transform`: minimal merge logic (keep the older / content-richer record; rewire references)
  3. `build-index` ×2: build collation (`locale:'en', strength:2`) + partial (excluding `status === DELETED` and empty username) unique indexes in the background
- **ownedIndexes**: declares `username_unique_ci_partial` and `email_unique_ci_partial`, so schemas treat these as excluded from autoIndex (no-op in production where `autoIndex: false` is forced; gives parity in development).

Implementing `prepare-unique` finalizes the "standard preflight migration shape" that subsequent migrations (`wikilink-format`, `revisions-schema-unify`) can follow.

---

## §12 Open questions / future work

### §12.1 Plugin-provided migrations

(Input doc §6, point 1.) Should plugins (e.g. the embed plugin) be able to provide their own migrations? **Out of scope for v1.** Plugins that need custom boot/preflight steps handle this in their own initialization hook today (not via the framework registry).

A future `definePluginMigration` API may be considered. Open questions for that work:

- Migrations attached to plugin install / uninstall (up and down)
- Avoiding id collisions across plugins (e.g. `<plugin-name>:<id>` prefixes)
- Ordering relationships between core migrations and plugin migrations

### §12.2 Rollback (down migrations)

Forward-only by design. Rollback is delegated to operational strategies (mongo snapshot / restore). If a clear use case for framework-level down migrations emerges (e.g. round-tripping between major versions), it will be handled in a separate RFC.

### §12.3 `crowi-admin doctor`

(Input doc §2.) "An umbrella command that runs all checks and reports an ordered task list." This RFC treats a thicker `migrate plan` as effectively that role. If a need to consolidate non-migration checks (Redis connectivity, storage configuration, etc.) becomes clear, a separate `doctor` will be carved out.

### §12.4 Concurrency / locking

Protection against two operators running `crowi-admin migrate apply` simultaneously is out of scope (left to operational convention). A future iteration could add a lock document in `migrationApplications`.

### §12.5 Details of the preflight boot-refusal policy

The `migration.preflightUnappliedPolicy: 'block' | 'warn'` switch (§4.2.1) ships, but the default value, environment-variable override semantics, and behavior in cluster deployments will be finalized during implementation.

---

## §13 Related RFCs / references

- RFC-0004 (Page Status): the boot-time backfill there is the seed of this framework's `page-status-default` migration.
- `feature-user-identity-uniqueness`: `prepare-unique` is the framework's first preflight migration. Responsibility split: uniqueness owns schema, E11000 mapping, and minimal dedup; the framework owns registration and execution.
- Existing boot init sequence: `packages/api/src/crowi/index.ts` (`migrateConfig` / `runAwsConfigMigration` / page status backfill).

---

## Appendix A: Placement of the confirmed migrations

| Migration | Legacy command | New placement | layer | from → to |
|---|---|---|---|---|
| Config schema | (inlined in boot) | `migrate-config` | boot | `* → 2.0` |
| AWS config | (inlined in boot) | `aws-config-migrate` | boot | `* → 2.0` |
| Page status backfill (RFC-0004) | (inlined in boot) | `page-status-default` | boot | `1.x → 2.0` |
| User uniqueness prepare | (new) | `2026-06-user-unique-prepare` | preflight | `1.x → 2.0` |
| Wikilink syntax | `wikilink-migrate` / `migrate-wikilink` | `2025-09-wikilink-format` | preflight | `1.x → 2.1` |
| Revisions schema unify | (planned, new) | `2025-12-revisions-schema-unify` | preflight | `2.0 → 2.1` |
| Renderer derived data | (planned `renderer:rebuild`) | `rebuild renderer` | — (rebuild) | — |
| Search index | `search-rebuild` | `rebuild search` | — (rebuild) | — |
| Backlink index | (planned, new) | `rebuild backlink` | — (rebuild) | — |
| Storage copy | `storage-copy` | `rebuild storage-copy` | — (rebuild) | — |
