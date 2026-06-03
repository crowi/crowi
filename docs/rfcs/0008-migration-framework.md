# RFC-0008: Migration Framework

- Status: Draft (v3)
- Created: 2026-06-03
- Updated: 2026-06-03 (v3: invalidateYjs layering, detect consolidation, autoIndex-owns-unique)
- Supersedes: None
- Related: RFC-0004 (Page Status), RFC-0010 (OAuth client seed), `feature-user-identity-uniqueness`

> **Changelog**
>
> **v2 → v3** (after second implementation review):
> - **A.** Fixed the Yjs description. The writer (`updatePage`) nulls `yjsState`/`yjsCheckpointAt`; `on-load-document` is the *reader* that detects null and rebuilds/broadcasts. Split the runner's invalidation into a **persistence-layer** operation (all layers) and a **live broadcast** (boot layer only); preflight does persistence-only (§4.3.1, §5.2).
> - **B.** Consolidated detection into top-level `isPending` (cheap, required) and `detect?` (full scan, optional). Removed `detect` from `stages`.
> - **D1.** Specified `block` semantics: if a preflight migration is unapplied, **every replica fail-fasts** (no partial cluster start) (§4.2.7).
> - **D2.** Unique indexes are built by **schema declaration + autoIndex** (so fresh installs get them); a migration's job is only to **dedup** so autoIndex won't hit E11000. Removed the `build-index` stage and `ownedIndexes`; simplified `stages` to named transforms (§5, §9, §11).
> - **C.** Corrected line references (§1.2 → 212–224; §1.4 → `mongoose.connect(mongoUri)` with no options at `index.ts:488`).
>
> **v1 → v2** (after first implementation review): corrected nonexistent boot migrations (`migrateConfig`/`runAwsConfigMigration`); corrected the already-namespaced CLI; split `isPending`/`detect`; narrowed autoIndex scope; flagged the `$ne` / `STATUS_DELETED` index problem; removed the single "data version" scalar; standardized dateless-slug ids; kept seeds outside the framework.

---

## §0 Summary

Crowi's scattered admin operations (`migrate --only=wikilink` / `search rebuild` / `storage copy`) and one live boot-time migration (`runPageStatusMigration`) are reorganized under a single **migration framework**.

The admin CLI is split into **two command namespaces**:

- `crowi-admin migrate ...` — **one-shot migrations** (forward-only; gating conditions for reaching a target version)
- `crowi-admin rebuild ...` — **operational rebuilds** (regeneration of derived data; any time, any number of times)

The `migrate` namespace is divided into a **boot-auto layer** and a **preflight layer**: lightweight, safe migrations run automatically at boot; heavy or destructive ones are invoked explicitly from the admin CLI. Pending state is determined by **data inspection** as the source of truth, via a cheap `isPending` probe (called at boot) separated from a richer `detect` report (used by `plan`). An applied-record collection is kept separately as an **append-only audit log**.

The framework's central problem is **not** unifying command names (the CLI is already partly namespaced) — it is that today's operations are each standalone with **no shared runner** (no shared dry-run, progress, concurrency control, or Yjs invalidation).

---

## §1 Background / Motivation

### §1.1 The real problem: no shared runner

The current admin operations are each implemented standalone, with no common infrastructure:

- `crowi-admin migrate --only=wikilink` (`packages/admin-cli/src/commands/migrate-wikilink.ts`)
- `crowi-admin search rebuild` (nested commander subcommand)
- `crowi-admin storage copy` (nested commander subcommand)

The CLI is therefore **already partially namespaced** — the motivation is *not* "inconsistent naming." The real gap is that each command reimplements (or simply lacks) dry-run, progress reporting, bounded concurrency, idempotency conventions, and — critically — **Yjs invalidation after body rewrites** (§4.3). There is no registry, no application record, and no shared notion of "pending."

### §1.2 One boot-time migration already exists

The boot init sequence (`packages/api/src/crowi/index.ts:212-224`) contains two relevant steps:

- `runPageStatusMigration` (`:219`) — the RFC-0004 page-status backfill. A genuine forward-only migration.
- `runOAuthClientSeed` (`:223`) — the RFC-0010 OAuth client seed. An **idempotent seed**, not a forward-only migration (see §3 and §12.6).

Only `runPageStatusMigration` is a migration in this RFC's sense. Each new migration currently requires direct edits to the boot code, with no shared registration, ordering, record, dry-run, or testing.

> Note: earlier drafts referenced `migrateConfig` and `runAwsConfigMigration` as live boot migrations. Neither exists in `packages/api/src`: `migrateConfig` has no definition (config handling is inlined in `setupConfig()`), and `runAwsConfigMigration` survives only as a compiled `dist/` artifact (removed in RFC-0007's `drop-legacy-aws-config-migration` changeset). They are **not** part of this framework.

### §1.3 The v1→v2 upgrade as the largest use case

The `feature-user-identity-uniqueness` discussion made the in-place v1→v2 upgrade runbook concrete:

1. v1 stays up (with a maintenance window or read-only mode if needed).
2. v2 is brought up, pointed at the v1 mongo (or a restored copy for rollback safety). `REDIS` and storage are configured. The web installer is not opened (and would be rejected as `already_installed` anyway).
3. The admin CLI runs **preflight** checks against mongo before go-live:
   - `crowi-admin migrate plan` to see what needs to be done
   - Execute as needed to resolve
4. Start v2 (boot's automatic migrations run) → smoke-test → cut traffic over.

The migration framework is the implementation substrate for this upgrade guide. Without it, upgrade procedures degrade into runbook oral tradition with no reproducibility or testability.

### §1.4 The autoIndex problem

Mongoose builds any schema-declared index at boot (`autoIndex` defaults to `true`; `mongoose.connect(mongoUri)` is called with no options at `index.ts:488`, so it is effectively on with no env gate). When a v1→v2 transition introduces a **new unique index**, booting v2 with duplicate data still present causes **boot to fail with E11000**. This hazard is specific to **unique/constraint indexes** — non-unique indexes never throw on duplicates. The framework must define how to keep autoIndex from hitting E11000 when a unique constraint is introduced (§9).

---

## §2 Goals / Non-Goals

### §2.1 Goals

- Consolidate scattered admin operations under two namespaces, sharing a single runner.
- Let operators inspect, ahead of time, which version-to-version transition each migration covers and what will happen.
- Make **plan / dry-run → apply** the default flow.
- Formalize the **boot-auto vs. preflight** two-layer split, with well-defined cluster `block` semantics.
- Define a safe pattern so that introducing a **unique index** does not cause E11000 boot death (§9).
- Consolidate the existing `runPageStatusMigration` boot migration under the framework.
- Make the v1→v2 upgrade procedure expressible as a reproducible runbook in framework commands.

### §2.2 Non-Goals

- **Plugin-provided migrations**: out of scope for v1 (§12.1).
- **Seeds**: idempotent seeds such as the OAuth client seed remain outside the framework for now (§12.6).
- **General-purpose recovery tooling** (e.g. merging two arbitrary users) is out of scope.
- **Index construction by the framework**: the framework does not build indexes; autoIndex does (§9). Migrations only prepare data so autoIndex succeeds.
- **Version-specific upgrade procedures** beyond v1→v2 are deferred to a separate upgrade guide.
- **Rollback (down migrations)**: forward-only; rollback is handled operationally via mongo snapshot/restore.
- **Cross-migration dependencies**: migrations are independent; ordering is by version range + `order` only (§5.3).

---

## §3 Terminology

- **Migration**: A one-shot, forward-only transformation from one version's data shape to another's, applied at most once per dataset. Under the `migrate` namespace.
- **Rebuild task**: Regeneration of derived data. Version-independent; any time, any number of times. Under the `rebuild` namespace.
- **Seed**: An idempotent guarantee that required baseline data exists (e.g. OAuth client seed). Neither a migration nor a rebuild. **Outside this framework** for now (§12.6).
- **Layer**: For migrations, whether it runs automatically at boot (`boot`) or only from the admin CLI (`preflight`).
- **Pending**: "Should be applied but hasn't been," judged by the cheap `isPending` probe (§6).
- **Applied**: A record exists in `migrationApplications` (§7). Judged independently of pending.
- **Stage**: A named, side-effecting transform step composing a migration (§5). (Index building is *not* a stage — see §9.)

---

## §4 Overall architecture

### §4.1 Two command namespaces

```
crowi-admin migrate ...       # (A) one-shot migrations (forward-only)
  plan       [--to <ver>] [--preflight-only] [--id <id>]
  apply      [--dry-run] [--id <id>]
  status
  list

crowi-admin rebuild ...       # (B) operational rebuilds (any time)
  renderer   [--only-stale] [--dry-run]
  search     [--dry-run]
  backlink   [--dry-run]
  storage    copy <args>      # existing `storage copy` retained here
```

**Reorganized commands** (no compatibility aliases — the legacy forms are removed):

| Legacy (actual registration) | New |
|---|---|
| `migrate --only=wikilink` | `crowi-admin migrate apply --id wikilink-format` |
| `search rebuild` | `crowi-admin rebuild search` |
| `storage copy` | `crowi-admin rebuild storage copy` |
| (planned) renderer rebuild | `crowi-admin rebuild renderer` |
| (planned) revisions schema unify | `crowi-admin migrate apply --id revisions-schema-unify` |

The point is not renaming but routing every operation through one runner.

### §4.2 Two layers under `migrate`

Each migration declares a **`layer`** (`'boot' | 'preflight'`):

| layer | When it runs | Examples | Characteristics |
|---|---|---|---|
| `boot` | Detected and applied automatically during the application boot sequence | `page-status-default` | Lightweight, safe, short-running. |
| `preflight` | Invoked explicitly from the admin CLI (boot does not run them, but **does probe** unapplied ones) | `user-unique-prepare`, `wikilink-format`, `revisions-schema-unify` | Heavy, potentially destructive, long-running. Run in a maintenance window before go-live. |

#### §4.2.1 Boot sequence behavior

```
1. The framework loads all migrations from the registry.
2. For each layer='boot' migration, call isPending() (cheap probe).
   - If pending, apply it in order; append the result to migrationApplications.
3. For each layer='preflight' migration, call isPending() (cheap probe).
   - If any are pending, refuse boot (default) or warn only (configurable).
4. Start the application (autoIndex then builds schema-declared indexes, incl. unique — see §9).
```

Step 3 is the framework's key safety net: if `user-unique-prepare` hasn't run before v2 boot, this fails fast with a clear error *before* autoIndex would fail with E11000. Configurable via `migration.preflightUnappliedPolicy: 'block' | 'warn'` (default `block`).

**Critical**: because step 3 runs on every boot of every instance, `isPending` must be **cheap** — see §6.

#### §4.2.7 `block` semantics in a multi-instance deployment

When `preflightUnappliedPolicy: 'block'` (default) and a preflight migration is unapplied, **every replica fail-fasts on boot**; the cluster does not come up partially. This is intentional and is the safe behavior:

- An unapplied preflight migration means the data is not yet in v2 shape.
- Allowing *some* instances to start against not-yet-migrated data is more dangerous than refusing all of them — each would independently hit autoIndex E11000 (§9) or operate on inconsistent data.
- The correct operational flow is: all instances fail-fast for the same reason → operator runs `crowi-admin migrate apply` (e.g. dedup) once → operator brings the cluster up.

`warn` is available for operators who explicitly accept the risk (e.g. a controlled single-instance investigation), but is not the default. Orchestration specifics (restart backoff, health-check interaction) are deployment-level and out of scope; the *semantics* above are normative.

#### §4.2.2 Admin CLI behavior

`migrate plan` / `apply` default to `layer='preflight'` only; the boot layer is left to the boot sequence. `--all-layers` extends to both (debugging/investigation).

### §4.3 Shared internal runner

`migrate` (A) and `rebuild` (B) are separate namespaces but share one runner. Standardized concerns:

- A standard `--dry-run` interface
- Progress reporting (counts, ETA, current id)
- Safe interruption (SIGINT) and partial-completion handling
- Bounded concurrency (for the embed plugin's rate limits)
- **Yjs invalidation after body rewrites** (see below)
- Structured logging (JSON output option)

#### §4.3.1 Yjs invalidation mechanism

When a migration rewrites page **body** content, any in-memory `Y.Doc` held by currently-editing clients becomes stale. The mechanism has two distinct sides:

- **Writer side (persistence):** the writer nulls `page.yjsState` and `yjsCheckpointAt` (and repoints `currentRevision`). This is what `Page.updatePage` already does (`page.ts:1066-1068`). Once `yjsState` is null, the next `onLoadDocument` rebuilds the `Y.Doc` from the body.
- **Reader side (live broadcast):** `packages/collab/src/hooks/on-load-document.ts:148-157` *detects* the null state and `broadcastStateless`es `{ kind: 'crowi:force-reload', reason: 'page-body-replaced' }` so connected clients reload. This requires a handle to a **live Hocuspocus instance**.

The two sides have different reachability across processes, which the runner must respect:

| | Persistence null-out | Live force-reload broadcast |
|---|---|---|
| `layer='boot'` (in the api process) | ✅ | ✅ (has a live Hocuspocus handle) |
| `layer='preflight'` (admin CLI, separate process, mongo-only) | ✅ | ❌ (no live Hocuspocus handle) |

The admin CLI is a separate, lightweight process that talks to MongoDB directly (`cli.ts`); it has **no reference to a live Hocuspocus instance**, so it **cannot broadcast**. This is fine in practice: preflight migrations run in a maintenance window with v1 stopped or read-only, so there are no connected editors to force-reload — nulling `yjsState` is sufficient, and the next `onLoadDocument` rebuilds from the body.

**Runner convention** (instead of inventing a new primitive): body-rewriting migrations go through the existing `updatePage`-equivalent path (repoint `currentRevision` + null `yjsState`/`yjsCheckpointAt`). The runner exposes this as `ctx.rewritePageBody(...)` / `ctx.invalidateYjsPersistence(pageIds)` (persistence-layer; works in all layers). The live broadcast is an additional capability available **only in `layer='boot'`** migrations (api process). Preflight does persistence-only.

**Motivating bug:** the current wikilink migration (`migrate-wikilink.ts:447-448`) calls `Revision.prepareRevision` + `Page.pushRevision` directly, bypassing `Page.updatePage`, so it never nulls `yjsState`/`yjsCheckpointAt` — leaving editing users on a stale `Y.Doc`. Porting it to `wikilink-format` on the shared runner (via the `updatePage`-equivalent path) fixes this (§10.2 step 4).

---

## §5 Migration definition interface

```ts
// packages/api/src/migration/types.ts

export type MigrationLayer = 'boot' | 'preflight';

/** A named, side-effecting transform. Index building is NOT here — see §9. */
export interface MigrationStage {
  /** Label for logging/progress (e.g. 'dedup-username') */
  name: string;
  /** Must no-op when ctx.dryRun is true. */
  fn: (ctx: MigrationContext) => Promise<StageResult>;
}

export interface MigrationDefinition {
  /** Stable identifier. Convention: dateless kebab-case slug (see §5.4). */
  id: string;

  /** Version range this migration covers */
  fromVersion: string;   // e.g. '1.x' | '2.0' | '2.1'
  toVersion:   string;   // e.g. '2.0' | '2.1' | '2.2'

  layer: MigrationLayer;

  /** Short, human-readable description (shown by plan / list) */
  description: string;

  /** Execution order within the same version range (defaults to registry insertion order) */
  order?: number;

  /** Side-effecting transforms, executed in declaration order */
  stages: MigrationStage[];

  /**
   * REQUIRED. A cheap pending probe — O(1) or index-backed (e.g. a `findOne`
   * on an indexed field). Called on every boot for every instance (§4.2.1),
   * so it must NOT be a full-collection scan.
   *
   * For preflight + block policy, a false positive blocks boot for the whole
   * cluster (§4.2.7), so authors must write this conservatively (§6.2).
   */
  isPending: (ctx: MigrationContext) => Promise<boolean>;

  /**
   * OPTIONAL. A detailed report for `plan` — may be a full scan (counts,
   * breakdown). Not called at boot. If omitted, `plan` shows
   * "details unavailable" and relies on isPending for the verdict.
   */
  detect?: (ctx: MigrationContext) => Promise<DetectReport>;
}
```

Note there is **no `build-index` stage and no `ownedIndexes`**: per §9, unique indexes are declared on schemas and built by autoIndex; a migration's role is to prepare data, not to build indexes.

### §5.1 `isPending` vs. `detect`

Detection is two concepts, not three:

- **`isPending`** — cheap, index-backed, **required**. Called at boot. Answers only "is there anything left to do?" as fast as possible. Example: an index-backed existence probe.
- **`detect`** — rich, possibly a full scan, **optional**. Called by `plan` only. Returns counts and a breakdown for the operator's preview.

This preserves "inspection = source of truth" while keeping boot cheap. (Detection is *not* a stage; `stages` are side-effecting transforms only.)

### §5.2 `MigrationContext`

```ts
export interface MigrationContext {
  db: Db;                                  // raw driver handle
  models: Models;                          // mongoose models
  logger: Logger;
  dryRun: boolean;                         // stages must no-op when true
  progress: ProgressReporter;              // { setTotal, increment, setLabel }

  /**
   * Persistence-layer Yjs invalidation (all layers): repoint currentRevision
   * and null page.yjsState / yjsCheckpointAt for the given pages, via the
   * updatePage-equivalent path (§4.3.1). The next onLoadDocument rebuilds
   * the Y.Doc from the body.
   */
  rewritePageBody: (pageId: string, newBody: string) => Promise<void>;
  invalidateYjsPersistence: (pageIds: string[]) => Promise<void>;

  /**
   * Live force-reload broadcast. Available ONLY in layer='boot' migrations
   * (api process with a live Hocuspocus handle). Undefined in preflight
   * (admin CLI); preflight relies on persistence-layer invalidation only.
   */
  broadcastForceReload?: (pageIds: string[]) => Promise<void>;
}
```

### §5.3 Ordering and dependencies

**Migrations are independent.** There is no `dependsOn`. Execution order is determined solely by `fromVersion`/`toVersion` (version range ordering), then `order` within the same range (defaulting to registry insertion order). If a real cross-migration dependency arises that version + order cannot express, that is a signal to reconsider the migration boundary, not to add a dependency graph (`dependsOn` is possible future work, §12.5).

### §5.4 id naming convention

ids are **dateless kebab-case slugs** named for content: `page-status-default`, `wikilink-format`, `revisions-schema-unify`, `user-unique-prepare`. Ordering is owned by `fromVersion`/`toVersion` + `order`, so a date prefix would imply an ordering role it does not have; `migrate list` already provides a chronological view via the `from → to` column. ids are stable identifiers (also keys in `migrationApplications`) and must not change once shipped.

### §5.5 Registry

Migration files live under `packages/api/src/migration/migrations/`, auto-registered from an index file at startup, grouped by version range, ordered by `order`.

---

## §6 Pending determination

### §6.1 Principle: inspection is the source of truth

Pending state is determined by executing the migration's **`isPending`** probe. The `migrationApplications` collection (§7) is an audit log, not the source of truth. Crowi's existing boot migration (`runPageStatusMigration`) already uses the "detect every boot, idempotently" model — this is the codebase's prevailing style. What we operationally need is whether target data is still present, not just whether something was recorded as applied.

### §6.2 Reconciling inspection vs. recorded state

When the inspection result and the latest record disagree, **always trust inspection (actual state)**:

| Inspection (`isPending`) | Latest record | Framework action |
|---|---|---|
| pending | none | Run normally → record `applied`. |
| pending | `applied` | **Trust inspection; re-run.** Record `re-applied` + warning log. |
| not pending | none | Skip → record `detected-clean`. |
| not pending | `applied` | Do nothing (consistent). |

**Asymmetry of false positives (important):** the general claim "a false positive is merely a wasteful re-run (idempotent, same result)" holds for `rebuild` and for `layer='boot'` migrations. It does **not** hold for `layer='preflight'` under `block`: there, a false positive in `isPending` means **boot refusal for the whole cluster (§4.2.7) = an outage**, not a harmless re-run. So `isPending` for preflight migrations must be written conservatively.

**Coverage is the author's responsibility.** False negatives are the most dangerous outcome (data left behind that nothing flags). PR review must include "does `isPending` correctly catch all remaining targets?" as a required check.

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
  stats:        { type: Schema.Types.Mixed },   // detected / transformed counts, etc.
  appliedBy:    { type: String },                // 'boot-auto' | `admin-cli@${hostname}`
  error:        { type: String },                // only when result === 'failed'
}, { timestamps: true });
```

### §7.2 Append-only

Append-only; multiple documents per `migrationId` are expected (initial apply, each re-run, each detected-clean, each failure). "Latest applied state" is the most recent document for a given `migrationId`. This satisfies the audit requirement and preserves missed-and-rerun history and duration trends.

### §7.3 Self-bootstrapping

Excluded from migration management: created from schema declaration alone (or via an explicit `ensureIndexes` at startup), and no migration may modify its schema (avoids chicken-and-egg). A future framework version requiring a breaking change here is handled by a separate design.

---

## §8 Subcommand specifications

### §8.1 `migrate plan`

Lists pending migrations to preview what will happen. There is **no single "current data version"** scalar — Crowi data has no single version, and "inspection = source of truth" means the framework holds no aggregate version state. `plan` shows the reachable target and the per-migration pending list.

```
$ crowi-admin migrate plan
Latest target: 2.1

Preflight migrations to apply:
  [1/3] user-unique-prepare        (1.x → 2.0)
        Deduplicate users by username/email so unique indexes can be built
        Detected: 42 duplicate username groups, 17 duplicate email groups
        Stages: dedup-username → dedup-email

  [2/3] wikilink-format            (1.x → 2.1)
        Migrate </path> wikilink syntax to [[path]]
        Detected: 1,283 pages contain legacy wikilink syntax

  [3/3] revisions-schema-unify     (2.0 → 2.1)
        Unify revision document schema (add type:'snapshot')
        Detected: details unavailable (no detect stage; isPending = true)

Boot migrations (run automatically on next startup):
  - page-status-default            (boot; pending)

Run `crowi-admin migrate apply` to execute preflight migrations.
```

Options: `--to <ver>`, `--id <id>`, `--preflight-only` (default), `--all-layers`, `--json`. Where a migration provides `detect`, `plan` shows its report; otherwise "details unavailable" and the `isPending` verdict.

### §8.2 `migrate apply`

Applies pending preflight migrations in version-range + `order` sequence (§5.3).

```
$ crowi-admin migrate apply
[1/3] user-unique-prepare ...
  detect:          42 duplicate username groups, 17 duplicate email groups
  dedup-username:  merging 38 user records ... done (2.1s)
  dedup-email:     merging 21 user records ... done (1.4s)
  → applied (3.6s)
  note: unique indexes will be built by autoIndex on next api boot (§9)

[2/3] wikilink-format ...
  ...
```

Options: `--dry-run` (run `detect` only; stages no-op), `--id <id>`, `--yes`, `--continue-on-error` (default: abort).

### §8.3 `migrate status`

```
$ crowi-admin migrate status
Latest target: 2.1

Recent applications (last 10):
  2026-06-03  applied        user-unique-prepare       (3.6s, admin-cli@host1)
  2026-06-01  detected-clean page-status-default       (0.1s, boot-auto)
  ...

Pending preflight:  2 migrations
Pending boot:       1 migration
```

### §8.4 `migrate list`

```
$ crowi-admin migrate list
ID                        from → to    layer       description
page-status-default       1.x  → 2.0   boot        Backfill page.status (RFC-0004)
user-unique-prepare       1.x  → 2.0   preflight   Deduplicate users (unique index via autoIndex)
wikilink-format           1.x  → 2.1   preflight   Migrate wikilink syntax
revisions-schema-unify    2.0  → 2.1   preflight   Unify revision schema
```

### §8.5 `rebuild <target>`

```
$ crowi-admin rebuild renderer [--only-stale] [--dry-run]
$ crowi-admin rebuild search   [--dry-run]
$ crowi-admin rebuild backlink [--dry-run]
$ crowi-admin rebuild storage copy <args>
```

Simple dispatchers to registered rebuild tasks. No pending/applied concept. `--dry-run` and progress use the same runner as (A).

---

## §9 Unique index policy (autoIndex builds, migrations only dedup)

### §9.1 Principle: schemas declare unique indexes; autoIndex builds them; migrations prepare data

The problem to solve is **E11000 boot death when introducing a unique constraint over not-yet-clean data**. The solution splits the two concerns:

- **Building the index** stays with the schema declaration + **autoIndex** (Mongoose's default, already how every index in the codebase is built today). The framework does **not** build indexes.
- **Making the build succeed** is the migration's job: a `layer='preflight'` migration **deduplicates** (or otherwise repairs) the data so that, when autoIndex builds the unique index at the next boot, there is no constraint violation.

This is why §5 has no `build-index` stage and no `ownedIndexes`. A migration carries `stages` of data transforms (e.g. dedup) plus `isPending`/`detect`; the index itself lives in the schema.

### §9.2 The two paths, made explicit

**Fresh install** (no duplicate data):
1. v2 schema declares the unique index (collation/partial as needed).
2. autoIndex builds it at first boot. No duplicates exist, so it succeeds.
3. The corresponding preflight migration's `isPending` returns false → recorded `detected-clean`; nothing to dedup.

**Upgrade (v1→v2)** (duplicate data may exist):
1. Operator brings up v2 against the v1 mongo.
2. Boot step 3 (§4.2.1): the dedup preflight migration is pending → **whole cluster fail-fasts** (§4.2.7) *before* autoIndex can hit E11000.
3. Operator runs `crowi-admin migrate apply` → dedup resolves duplicates.
4. Operator boots v2 again → step 3 now clean → boot proceeds → autoIndex builds the unique index against deduped data → succeeds.

In both paths the unique index is built by autoIndex; the only difference is whether a dedup step had to run first.

### §9.3 Consequences and a known cost

- **No baseline build-index migrations** are needed (the v2 concern about writing 25+ of them disappears): existing unique indexes (`page.path`, OAuth code/client/device/refresh, personal-access-token, `share.uuid`, bookmark/activity composites, `shareAccess`, plugin-render-cache) stay as plain schema declarations built by autoIndex. They are untouched by this framework unless a future migration needs to change their *data* (in which case a dedup-style preflight migration is added, still leaving the build to autoIndex).
- **autoIndex stays on** (no production `autoIndex: false`); this matches current behavior and keeps non-unique indexes building as before.
- **Known cost:** for a large collection on upgrade, autoIndex building the unique index at boot blocks startup for the duration of the build (now over deduped data, so it is a normal unique-index build, not a failing one). If this boot-blocking ever becomes operationally painful, a future option is an explicit, pre-go-live index build in a preflight step (`createIndex` from the admin CLI) so the boot-time autoIndex build is a no-op. This is deliberately deferred (§12.8) rather than designed in now.

> **⚠️ `partialFilterExpression` is unresolved and owned by the uniqueness spec.**
> The intended filter "exclude `STATUS_DELETED` and empty usernames" **cannot be expressed as written** on the schema's unique index:
> - MongoDB's `partialFilterExpression` supports only `$eq`, `$exists: true`, `$gt/$gte/$lt/$lte`, `$type`, and a top-level `$and`. **`$ne` is not allowed**, so `status: { $ne: STATUS_DELETED }` fails at index build.
> - status is `REGISTERED=1 / ACTIVE=2 / SUSPENDED=3 / DELETED=4 / INVITED=5` (`models/user.ts`), so `DELETED=4` is **not** the maximum (`INVITED=5` is higher); `$lt: 4` would wrongly exclude INVITED too.
>
> The uniqueness spec must choose a supported encoding, e.g. (a) add a dedicated `deleted: true` flag and use `{ deleted: { $exists: false } }`, or (b) reorder status values so DELETED sits at an extreme and use `$lt`/`$gt`. Since the index is now schema-declared (§9.1), this resolution lands in the User schema's index declaration, not in a migration.

---

## §10 Migration plan for existing implementation

### §10.1 Promote the live boot migration into the framework

| Current (`crowi/index.ts:212-224`) | New | Notes |
|---|---|---|
| `runPageStatusMigration` (`:219`) | `defineMigration({ id: 'page-status-default', layer: 'boot', fromVersion: '1.x', toVersion: '2.0', ... })` | Genuine forward-only migration |
| `runOAuthClientSeed` (`:223`) | **unchanged** — stays as a boot-time seed outside the framework | Idempotent seed (§12.6) |

The boot sequence's migration portion becomes a single `runBootMigrations()` call; the OAuth client seed continues to run as ordinary boot initialization alongside it.

### §10.2 Reorganize legacy admin commands

| Old (actual registration) | New |
|---|---|
| `migrate --only=wikilink` | `migrate apply --id wikilink-format` (new preflight migration; routed through the `updatePage`-equivalent path, fixing the missing Yjs invalidation — §4.3.1) |
| `search rebuild` | `rebuild search` |
| `storage copy` | `rebuild storage copy` |
| (planned) renderer rebuild | `rebuild renderer` |
| (planned) revisions schema unify | `migrate apply --id revisions-schema-unify` |

No compatibility aliases. Announced in CHANGELOG and the upgrade guide.

### §10.3 Rollout order

1. Implement the framework core (runner, registry, types, `MigrationContext`, `migrationApplication` model, CLI scaffolding).
2. Port `runPageStatusMigration` to `page-status-default` (`layer: 'boot'`), preserving behavior.
3. Implement `user-unique-prepare` as the first preflight migration (dedup only). **The User schema's unique index declaration — including the `partialFilterExpression` resolution — is owned by the uniqueness spec** (§9.3).
4. Port the wikilink migration to `wikilink-format` (preflight), routing body rewrites through `ctx.rewritePageBody` / the `updatePage`-equivalent path, **fixing the missing Yjs invalidation** (§4.3.1).
5. Implement `revisions-schema-unify` (preflight).
6. Move rebuild tasks (renderer / search / backlink / storage copy) onto the shared runner.

(There is no separate "baseline build-index" step — see §9.3.) Each stage keeps the legacy path alongside the new one for verification; old entry points are removed at the end.

---

## §11 Worked example: `user-unique-prepare` (uniqueness preflight migration)

The prototype preflight migration. Its role is **dedup only** — the unique indexes are declared on the User schema and built by autoIndex (§9).

- **layer**: `preflight` (heavy/destructive; maintenance window)
- **fromVersion → toVersion**: `1.x → 2.0`
- **stages**: `dedup-username`, `dedup-email` (minimal merge: keep older/content-richer record, rewire references)
- **isPending**: index-backed existence probe for remaining duplicate keys (must be cheap — §5.1/§6.2)
- **detect**: full scan returning duplicate-group counts for `plan`

```ts
// packages/api/src/migration/migrations/user-unique-prepare.ts
defineMigration({
  id: 'user-unique-prepare',
  fromVersion: '1.x',
  toVersion: '2.0',
  layer: 'preflight',
  description: 'Deduplicate users by username/email so the unique indexes can be built by autoIndex',
  isPending: async (ctx) => /* cheap, index-backed probe for remaining duplicate keys */,
  detect:    async (ctx) => /* full scan: counts + breakdown for plan */,
  stages: [
    { name: 'dedup-username', fn: dedupByUsername },
    { name: 'dedup-email',    fn: dedupByEmail },
  ],
});
```

The unique indexes themselves are declared on the schema (built by autoIndex):

```ts
// packages/api/src/models/user.ts  (owned by the uniqueness spec)
userSchema.index(
  { username: 1 },
  {
    unique: true,
    collation: { locale: 'en', strength: 2 },
    // ⚠️ partialFilterExpression: PENDING the uniqueness spec — see §9.3 note.
    partialFilterExpression: { /* TBD */ },
    name: 'username_unique_ci_partial',
  },
);
// ... and similarly for { email: 1 } → email_unique_ci_partial
```

This makes `user-unique-prepare` the standard preflight shape: `stages` of transforms + `isPending`/`detect`, with index construction left to the schema/autoIndex. Subsequent migrations (`wikilink-format`, `revisions-schema-unify`) follow the same shape.

---

## §12 Open questions / future work

### §12.1 Plugin-provided migrations
Out of scope for v1. A future `definePluginMigration` API may address install/uninstall up/down, id collision avoidance (`<plugin>:<id>`), and ordering vs. core migrations.

### §12.2 Rollback (down migrations)
Forward-only; rollback delegated to mongo snapshot/restore. Revisited if round-tripping between major versions becomes a real need.

### §12.3 `crowi-admin doctor`
A thicker `migrate plan` effectively serves the "what should I run" role. If consolidating non-migration checks (Redis, storage config) becomes valuable, carve out a separate `doctor`.

### §12.4 Concurrency / locking
Protection against simultaneous `migrate apply` runs is out of scope (operational convention). A future iteration could add a lock document in `migrationApplications`.

### §12.5 Cross-migration dependencies
Currently unsupported by design (§5.3). If version + `order` proves insufficient, consider `dependsOn` — but first reconsider the migration boundary.

### §12.6 Seeds in the framework
Idempotent seeds (currently only the OAuth client seed) stay outside the framework. If seeds proliferate or need unified visibility, introduce a `layer='seed'` (version-independent, idempotent) within the `migrate` namespace at that time.

### §12.7 Preflight boot-refusal policy details
`migration.preflightUnappliedPolicy: 'block' | 'warn'` ships (default `block`; semantics in §4.2.7). Env-var override and restart/health-check interaction in clusters are finalized during implementation.

### §12.8 Explicit pre-go-live index build
If autoIndex building a large unique index at boot blocks startup unacceptably (§9.3), add an optional preflight step that builds the index via `createIndex` from the admin CLI before go-live, so the boot-time autoIndex build is a no-op. Deferred until the cost is demonstrated.

---

## §13 Related RFCs / references

- RFC-0004 (Page Status): `runPageStatusMigration` is the seed of `page-status-default`.
- RFC-0010 (OAuth client seed): `runOAuthClientSeed`, the example seed kept outside the framework (§12.6).
- RFC-0007 (`drop-legacy-aws-config-migration`): removed `runAwsConfigMigration`; only a `dist/` artifact remains.
- `feature-user-identity-uniqueness`: owns the User schema, the unique index declaration + `partialFilterExpression` resolution (§9.3), E11000 mapping, and minimal dedup. The framework owns registration, the dedup migration's execution, and the shared runner.
- Code references: boot sequence `crowi/index.ts:212-224` (`runPageStatusMigration` `:219`, `runOAuthClientSeed` `:223`); CLI `admin-cli/src/cli.ts:22-24` + `commands/{migrate-wikilink,search-rebuild,storage-copy}.ts`; mongoose connect `crowi/index.ts:488` (`mongoose.connect(mongoUri)`, no options, autoIndex default on); `models/user.ts:12-16` (`STATUS_DELETED=4`, `STATUS_INVITED=5`); `updatePage` null-out `page.ts:1066-1068`; wikilink direct-push bug `migrate-wikilink.ts:447-448`; force-reload reader `collab/src/hooks/on-load-document.ts:148-157`. The framework itself (registry / runner / `migrationApplications` / `migrate plan|apply|status|list`) is **unimplemented** — this RFC is prescriptive.

---

## Appendix A: Placement of the confirmed migrations

| Migration | Legacy (actual) | New placement | layer | from → to | Index? |
|---|---|---|---|---|---|
| Page status backfill (RFC-0004) | `runPageStatusMigration` (boot) | `page-status-default` | boot | `1.x → 2.0` | — |
| User uniqueness prepare | (new) | `user-unique-prepare` | preflight | `1.x → 2.0` | dedup only; unique index via schema/autoIndex (§9) |
| Wikilink syntax | `migrate --only=wikilink` | `wikilink-format` | preflight | `1.x → 2.1` | — (fixes Yjs bug, §4.3.1) |
| Revisions schema unify | (planned, new) | `revisions-schema-unify` | preflight | `2.0 → 2.1` | — |
| Renderer derived data | (planned) | `rebuild renderer` | — (rebuild) | — | — |
| Search index | `search rebuild` | `rebuild search` | — (rebuild) | — | — |
| Backlink index | (planned, new) | `rebuild backlink` | — (rebuild) | — | — |
| Storage copy | `storage copy` | `rebuild storage copy` | — (rebuild) | — | — |
| OAuth client seed (RFC-0010) | `runOAuthClientSeed` (boot) | **unchanged — outside framework** | — (seed) | — | — |
