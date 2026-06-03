# RFC-0008: Migration Framework

- Status: Draft (v2)
- Created: 2026-06-03
- Updated: 2026-06-03 (v2: reconciled against implementation feedback)
- Supersedes: None
- Related: RFC-0004 (Page Status), RFC-0010 (OAuth client seed), `feature-user-identity-uniqueness`

> **Changelog (v1 → v2)**
> Revised after cross-checking against the actual codebase (`packages/admin-cli`, `packages/api/src/crowi/index.ts`, `packages/api/src/models/`, `packages/collab`):
> - Corrected the description of currently-existing boot migrations (`migrateConfig` / `runAwsConfigMigration` do not exist in `src`; the live ones are `runPageStatusMigration` and the `runOAuthClientSeed` seed).
> - Corrected the legacy command surface (the CLI is already partially namespaced; there are no `wikilink-migrate` / `migrate-wikilink` commands).
> - Split `isPending` (cheap probe, called at boot) from `detect` (detailed report for `plan`) to avoid full-collection scans on every boot.
> - Narrowed the autoIndex policy to **unique/constraint indexes only**.
> - Marked the `prepare-unique` `partialFilterExpression` as pending resolution in the uniqueness spec (`$ne` is unsupported; `STATUS_DELETED` is not the max status value).
> - Removed the single-scalar "data version" concept.
> - Standardized id naming on dateless slugs.
> - Kept seeds (e.g. OAuth client seed) **outside** the framework for now.
> - Described the Yjs invalidation mechanism concretely.

---

## §0 Summary

Crowi's scattered admin operations (`migrate --only=wikilink` / `search rebuild` / `storage copy`) and one live boot-time migration (`runPageStatusMigration`) are reorganized under a single **migration framework**.

The admin CLI is split into **two command namespaces**:

- `crowi-admin migrate ...` — **one-shot migrations** (forward-only; gating conditions for reaching a target version)
- `crowi-admin rebuild ...` — **operational rebuilds** (regeneration of derived data; any time, any number of times)

The `migrate` namespace is divided into a **boot-auto layer** and a **preflight layer**: lightweight, safe migrations run automatically during boot, while heavy or destructive ones are invoked explicitly from the admin CLI. Pending state is determined by **data inspection** as the source of truth, via a cheap `isPending` probe (called at boot) separated from a richer `detect` report (used by `plan`). An applied-record collection is maintained separately as an **append-only audit log**.

The framework's central problem is **not** unifying command names (the CLI is already partly namespaced) — it is that today's operations are each standalone with **no shared runner** (no shared dry-run, progress, concurrency control, or Yjs invalidation).

---

## §1 Background / Motivation

### §1.1 The real problem: no shared runner

The current admin operations are each implemented standalone, with no common infrastructure:

- `crowi-admin migrate --only=wikilink` (`packages/admin-cli/src/commands/migrate-wikilink.ts`)
- `crowi-admin search rebuild` (nested commander subcommand)
- `crowi-admin storage copy` (nested commander subcommand)

The CLI is therefore **already partially namespaced** — the motivation is *not* "inconsistent naming." The real gap is that each command reimplements its own (or simply lacks) dry-run, progress reporting, bounded concurrency, idempotency conventions, and — critically — **Yjs invalidation after body rewrites** (§4.3). There is no registry, no application record, and no shared notion of "pending."

### §1.2 One boot-time migration already exists

The boot init sequence (`packages/api/src/crowi/index.ts:211-251`) contains two relevant steps:

- `runPageStatusMigration` — the RFC-0004 page-status backfill. A genuine forward-only migration.
- `runOAuthClientSeed` — the RFC-0010 OAuth client seed. An **idempotent seed**, not a forward-only migration (see §3 and §12.1).

This already embodies "booting v2 = progressively migrating the connected DB," but only `runPageStatusMigration` is a migration in this RFC's sense. Each new migration currently requires direct edits to the boot code, with no shared registration surface, ordering, record, dry-run, or testing.

> Note: earlier drafts referenced `migrateConfig` and `runAwsConfigMigration` as live boot migrations. Neither exists in `packages/api/src`: `migrateConfig` has no definition (config handling is inlined in `setupConfig()`), and `runAwsConfigMigration` survives only as a compiled artifact under `dist/` (removed in RFC-0007's `drop-legacy-aws-config-migration` changeset). They are **not** part of this framework.

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

Mongoose builds any schema-declared index at boot (`autoIndex` defaults to `true`; `mongooseOptions` is currently empty in `index.ts:482-496`, so it is effectively on with no env gate). When a v1→v2 transition introduces a **new unique index**, booting v2 with duplicate data still present causes **boot to fail with E11000**. This was surfaced by the uniqueness work. Note this hazard is specific to **unique/constraint indexes** — non-unique indexes never throw on duplicates. The framework must define how to safely sequence unique-index construction (§9).

---

## §2 Goals / Non-Goals

### §2.1 Goals

- Consolidate scattered admin operations under two namespaces, sharing a single runner.
- Let operators inspect, ahead of time, which version-to-version transition each migration covers and what will happen.
- Make **plan / dry-run → apply** the default flow.
- Formalize the **boot-auto vs. preflight** two-layer split.
- Define a safe pattern for **unique-index construction** that avoids E11000 boot death.
- Consolidate the existing `runPageStatusMigration` boot migration under the framework.
- Make the v1→v2 upgrade procedure expressible as a reproducible runbook in framework commands.

### §2.2 Non-Goals

- **Plugin-provided migrations**: out of scope for v1 (§12.1).
- **Seeds**: idempotent seeds such as the OAuth client seed remain outside the framework for now (§12.6).
- **General-purpose recovery tooling** (e.g. merging two arbitrary users) is out of scope.
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
- **Stage**: An internal step composing a migration (`detect` / `transform` / `build-index`).

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
4. Start the application.
```

Step 3 is the framework's key safety net: if `user-unique-prepare` hasn't run before v2 boot, this fails fast with a clear error *before* autoIndex would fail with E11000. Configurable via `migration.preflightUnappliedPolicy: 'block' | 'warn'` (default `block`).

**Critical**: because step 3 runs on every boot of every instance, `isPending` must be **cheap** — see §6.

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

When a migration rewrites page body content, any in-memory `Y.Doc` held by currently-editing clients becomes stale. The existing mechanism (`packages/collab/src/hooks/on-load-document.ts`) is: set `page.yjsState` (and `yjsCheckpointAt`) to `null`, then `broadcastStateless` a `{ kind: 'crowi:force-reload', reason: 'page-body-replaced' }` message so connected clients reload.

**Motivating bug**: the current wikilink migration (`migrate-wikilink.ts`) rewrites body content but **does not null out `yjsState`**, leaving editing users on a stale `Y.Doc`. This is exactly the kind of footgun the shared runner should eliminate: the runner exposes `ctx.invalidateYjs(pageIds)` (§5.2), and body-rewriting migrations must call it. The wikilink migration's missing invalidation is fixed as part of porting it onto the framework.

The runner standardizes this as: after a `transform` stage touches page bodies, the affected page ids are passed to `invalidateYjs`, which nulls `yjsState` / `yjsCheckpointAt` and broadcasts force-reload.

---

## §5 Migration definition interface

```ts
// packages/api/src/migration/types.ts

export type MigrationLayer = 'boot' | 'preflight';

export type MigrationStage =
  | { kind: 'detect';      fn: (ctx: MigrationContext) => Promise<DetectReport> }
  | { kind: 'transform';   fn: (ctx: MigrationContext) => Promise<TransformResult> }
  | { kind: 'build-index'; collection: string; indexSpec: object; options?: object };

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

  /** Stages, executed in declaration order */
  stages: MigrationStage[];

  /**
   * REQUIRED. A cheap pending probe — O(1) or index-backed (e.g. a `findOne`
   * on an indexed field, or an index-backed count). Called on every boot for
   * every instance (§4.2.1), so it must NOT be a full-collection scan.
   *
   * For preflight + block policy, a false positive blocks boot (an outage),
   * so authors must write this conservatively (§6.2).
   */
  isPending: (ctx: MigrationContext) => Promise<boolean>;

  /**
   * OPTIONAL. A detailed report for `plan` — may be a full scan (counts,
   * breakdown of affected records). Not called at boot. If omitted, `plan`
   * shows "details unavailable" and falls back to isPending for the verdict.
   */
  detect?: (ctx: MigrationContext) => Promise<DetectReport>;

  /**
   * Unique/constraint indexes "owned" by this migration. Such indexes are
   * NOT declared on the schema (or declared with autoIndex suppressed); the
   * migration builds them. See §9.
   */
  ownedIndexes?: Array<{ collection: string; name: string }>;
}
```

### §5.1 `isPending` vs. `detect` (the key split)

These were one concept in v1 and caused a problem: §4.2.1 calls the pending check on every boot, and if that check is a full-collection scan (e.g. scanning all published pages for legacy wikilink syntax), it runs on every restart of every replica — a real operational cost at scale.

So they are split:

- **`isPending`** — cheap, index-backed, **required**. Called at boot. Answers only "is there anything left to do?" as fast as possible. Example: `pages.findOne({ legacyWikilink: true }, { _id: 1 })` against an indexed flag, or an index-backed existence probe.
- **`detect`** — rich, possibly a full scan, **optional**. Called by `plan` only. Returns counts and a breakdown for the operator's preview.

This preserves "inspection = source of truth" while keeping boot cheap.

### §5.2 `MigrationContext`

The argument to every stage and probe:

```ts
export interface MigrationContext {
  db: Db;                                  // raw driver handle
  models: Models;                          // mongoose models
  logger: Logger;
  dryRun: boolean;                         // transform/build-index must no-op when true
  progress: ProgressReporter;              // { setTotal, increment, setLabel }
  /**
   * Invalidate in-memory Y.Doc for the given pages after a body rewrite:
   * nulls page.yjsState / yjsCheckpointAt and broadcasts force-reload (§4.3.1).
   */
  invalidateYjs: (pageIds: string[]) => Promise<void>;
}
```

### §5.3 Ordering and dependencies

**Migrations are independent.** There is no `dependsOn`. Execution order is determined solely by:

1. `fromVersion` / `toVersion` (version range ordering), then
2. `order` within the same range (defaulting to registry insertion order).

If a real cross-migration dependency arises that version + order cannot express, it is a signal to reconsider the boundary between those migrations, not to add a dependency graph. (`dependsOn` is listed as possible future work, §12.5.)

### §5.4 id naming convention

ids are **dateless kebab-case slugs** named for content: `page-status-default`, `wikilink-format`, `revisions-schema-unify`, `user-unique-prepare`.

Rationale: ordering is owned by `fromVersion`/`toVersion` + `order`, so a date prefix would imply an ordering role it does not have. `migrate list` already provides a chronological view via the `from → to` column. ids are stable identifiers (also used as keys in `migrationApplications`), so they must not change once shipped.

### §5.5 Registry

Migration files live under `packages/api/src/migration/migrations/`, auto-registered from an index file at startup, grouped by version range, ordered by `order`.

---

## §6 Pending determination

### §6.1 Principle: inspection is the source of truth

Pending state is determined by executing the migration's **`isPending`** probe. The `migrationApplications` collection (§7) is an audit log, not the source of truth.

Rationale:

- Crowi's existing boot migration (`runPageStatusMigration`) already uses the "detect every boot, idempotently" model. This is the codebase's prevailing style.
- What we operationally need to know is whether target data is still present, not just whether something was recorded as applied. A pure ledger cannot catch "recorded applied but data still leftover."

### §6.2 Reconciling inspection vs. recorded state

When the inspection result and the latest record disagree, **always trust inspection (actual state)**:

| Inspection (`isPending`) | Latest record | Framework action |
|---|---|---|
| pending | none | Run normally → record `applied`. |
| pending | `applied` | **Trust inspection; re-run.** Record `re-applied` + warning log ("previously applied but target data present"). |
| not pending | none | Skip → record `detected-clean`. |
| not pending | `applied` | Do nothing (consistent). |

**Asymmetry of false positives (important):** §6's general claim "a false positive is merely a wasteful re-run (idempotent, same result)" holds for `rebuild` and for `layer='boot'` migrations. It does **not** hold for `layer='preflight'` under `preflightUnappliedPolicy: 'block'`: there, a false positive in `isPending` means **boot refusal = an outage**, not a harmless re-run. Therefore `isPending` for preflight migrations must be written conservatively to avoid spurious "pending" verdicts.

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
  stats:        { type: Schema.Types.Mixed },   // detected / transformed / indexBuilt, etc.
  appliedBy:    { type: String },                // 'boot-auto' | `admin-cli@${hostname}`
  error:        { type: String },                // only when result === 'failed'
}, { timestamps: true });
```

### §7.2 Append-only

Append-only; multiple documents per `migrationId` are expected (initial apply, each re-run, each detected-clean, each failure). "Latest applied state" is the most recent document for a given `migrationId`. This satisfies the audit requirement and preserves missed-and-rerun history and duration trends.

### §7.3 Self-bootstrapping

This collection is excluded from migration management: created from schema declaration alone (or via an explicit `ensureIndexes` at startup), and no migration may modify its schema (avoids chicken-and-egg). A future framework version requiring a breaking change here is handled by a separate design.

---

## §8 Subcommand specifications

### §8.1 `migrate plan`

Lists pending migrations to preview what will happen. There is **no single "current data version"** scalar — Crowi data has no single version (different collections/documents can be at different generations), and "inspection = source of truth" means the framework holds no aggregate version state. Instead, `plan` shows the reachable target and the per-migration pending list.

```
$ crowi-admin migrate plan
Latest target: 2.1

Preflight migrations to apply:
  [1/3] user-unique-prepare        (1.x → 2.0)
        Deduplicate users by username/email and build unique indexes
        Detected: 42 duplicate username groups, 17 duplicate email groups
        Stages: detect → transform → build-index×2

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

Options: `--to <ver>` (restrict to those needed to reach a version), `--id <id>`, `--preflight-only` (default), `--all-layers`, `--json`.

Where a migration provides a `detect` stage, `plan` shows its report; otherwise it shows "details unavailable" and relies on `isPending` for the pending verdict.

### §8.2 `migrate apply`

Applies pending preflight migrations in version-range + `order` sequence (§5.3).

```
$ crowi-admin migrate apply
[1/3] user-unique-prepare ...
  detect:      42 duplicate username groups, 17 duplicate email groups
  transform:   merging 59 user records ... done (3.2s)
  build-index: users.username_unique_ci_partial ... done (1.1s)
  build-index: users.email_unique_ci_partial    ... done (0.9s)
  → applied (5.2s)

[2/3] wikilink-format ...
  ...
```

Options: `--dry-run` (run `detect` stages only), `--id <id>` (apply one, after ordering resolution), `--yes` (skip confirmation), `--continue-on-error` (default: abort).

### §8.3 `migrate status`

```
$ crowi-admin migrate status
Latest target: 2.1

Recent applications (last 10):
  2026-06-03  applied        user-unique-prepare       (5.2s, admin-cli@host1)
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
user-unique-prepare       1.x  → 2.0   preflight   Deduplicate users + unique index
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

Simple dispatchers to registered rebuild tasks. No pending/applied concept (run as an operational decision). `--dry-run` and progress use the same runner as (A).

---

## §9 autoIndex policy (unique/constraint indexes only)

### §9.1 Scope: only unique/constraint indexes are migration-owned

The problem to solve is **E11000 boot death when introducing a unique constraint over not-yet-clean data**. Non-unique indexes never throw on duplicates, so they are not part of this problem.

Therefore: **only unique/constraint indexes are migration-owned.** Non-unique indexes continue to be declared on schemas and built by autoIndex as today. This deliberately avoids the much larger scope of "all indexes are migration-owned" — the codebase already has 90+ index declarations across `models/*.ts`, and forcing all of them through migrations would mean writing 25+ baseline build-index migrations, with any omission causing a fresh install to run with missing indexes.

### §9.2 Implementation

- A new unique index is **not** declared on the schema (or is declared with autoIndex suppressed for that index). Instead, a migration with a `build-index` stage builds it, and declares it in `ownedIndexes`.
- Non-unique indexes: unchanged (schema declaration + autoIndex).
- The framework emits a warning at startup if it finds a unique index declared on a schema that is also listed in some migration's `ownedIndexes` (declaration/ownership conflict).

(We do **not** force global `autoIndex: false` in production — that was v1's overreach. autoIndex remains on for non-unique indexes.)

### §9.3 Baseline unique indexes are a fresh-install prerequisite

Existing unique indexes (`page.path`; OAuth code/client/device/refresh; personal-access-token; `share.uuid`; bookmark/activity composites; `shareAccess`; plugin-render-cache — all currently plain `unique: true`, no collation/partial) are today created by autoIndex. As they move to migration-ownership (only when/if a migration needs to change them), the corresponding `build-index` migration becomes the thing that creates them on a fresh install.

**This must be explicit**: any unique index moved to migration-ownership must have a baseline build-index migration that a fresh v2 install runs, or that install comes up without the index. This is a tracked rollout step (§10.3), not a one-liner. Unique indexes that are *not* being changed stay on autoIndex and need no migration.

---

## §10 Migration plan for existing implementation

### §10.1 Promote the live boot migration into the framework

| Current (`crowi/index.ts:211-251`) | New | Notes |
|---|---|---|
| `runPageStatusMigration` | `defineMigration({ id: 'page-status-default', layer: 'boot', fromVersion: '1.x', toVersion: '2.0', ... })` | Genuine forward-only migration |
| `runOAuthClientSeed` | **unchanged** — stays as a boot-time seed outside the framework | Idempotent seed, not a migration (§12.6) |

The boot sequence's migration portion is reduced to a single `runBootMigrations()` call; the OAuth client seed continues to run as ordinary boot initialization alongside it.

### §10.2 Reorganize legacy admin commands

| Old (actual registration) | New |
|---|---|
| `migrate --only=wikilink` | `migrate apply --id wikilink-format` (new preflight migration; also fixes the missing Yjs invalidation, §4.3.1) |
| `search rebuild` | `rebuild search` |
| `storage copy` | `rebuild storage copy` |
| (planned) renderer rebuild | `rebuild renderer` |
| (planned) revisions schema unify | `migrate apply --id revisions-schema-unify` |

No compatibility aliases. Announced in CHANGELOG and the upgrade guide.

### §10.3 Rollout order

1. Implement the framework core (runner, registry, types, `MigrationContext`, `migrationApplication` model, CLI scaffolding).
2. Port `runPageStatusMigration` to `page-status-default` (`layer: 'boot'`), preserving behavior.
3. Implement `user-unique-prepare` as the first preflight migration — **blocked on the uniqueness spec finalizing the `partialFilterExpression` form** (§11).
4. Port the wikilink migration to `wikilink-format` (preflight), **adding the missing `invalidateYjs` call** (§4.3.1).
5. Implement `revisions-schema-unify` (preflight).
6. Move rebuild tasks (renderer / search / backlink / storage copy) onto the shared runner.
7. For each unique index that a migration changes, ship its **baseline build-index migration** and verify a fresh v2 install comes up with all indexes present (§9.3).

Each stage keeps the legacy path alongside the new one for verification; old entry points are removed at the end.

---

## §11 Worked example: `user-unique-prepare` (uniqueness preflight migration)

The prototype preflight migration. Key points:

- **layer**: `preflight` (heavy/destructive; maintenance window)
- **fromVersion → toVersion**: `1.x → 2.0`
- **stages**: `detect` (count duplicate usernames/emails) → `transform` (minimal merge: keep older/content-richer record, rewire references) → `build-index` ×2 (collation `{locale:'en', strength:2}` + partial unique on username/email)
- **isPending**: index-backed existence probe for duplicate keys (must be cheap — see §5.1/§6.2)
- **ownedIndexes**: `username_unique_ci_partial`, `email_unique_ci_partial`

```ts
defineMigration({
  id: 'user-unique-prepare',
  fromVersion: '1.x',
  toVersion: '2.0',
  layer: 'preflight',
  description: 'Deduplicate users by username/email and build collation+partial unique indexes',
  isPending: async (ctx) => /* cheap, index-backed probe for remaining duplicate keys */,
  detect:    async (ctx) => /* full scan: counts + breakdown for plan */,
  stages: [
    { kind: 'detect',    fn: detectDuplicateUsers },
    { kind: 'transform', fn: dedupUsers },
    { kind: 'build-index',
      collection: 'users',
      indexSpec: { username: 1 },
      options: {
        unique: true,
        collation: { locale: 'en', strength: 2 },
        // ⚠️ partialFilterExpression below is PENDING the uniqueness spec — see note.
        partialFilterExpression: { /* TBD: see note */ },
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

> **⚠️ `partialFilterExpression` is unresolved and owned by the uniqueness spec.**
> The intended filter "exclude `STATUS_DELETED` and empty usernames" **cannot be expressed as written**:
> - MongoDB's `partialFilterExpression` supports only `$eq`, `$exists: true`, `$gt/$gte/$lt/$lte`, `$type`, and a top-level `$and`. **`$ne` is not allowed**, so `status: { $ne: STATUS_DELETED }` fails at `createIndex`.
> - A simple inequality swap doesn't work either: status is `REGISTERED=1 / ACTIVE=2 / SUSPENDED=3 / DELETED=4 / INVITED=5` (`models/user.ts`), so `DELETED=4` is **not** the maximum (`INVITED=5` is higher); `$lt: 4` would wrongly exclude INVITED too.
>
> The uniqueness spec must choose a supported encoding, e.g. (a) add a dedicated `deleted: true` flag and use `partialFilterExpression: { deleted: { $exists: false } }`, or (b) reorder status values so DELETED sits at an extreme and use `$lt`/`$gt`. §11 is rewritten once this is fixed. This example exists to validate the framework's `build-index` abstraction, so it must not ship in a non-runnable form.
>
> (Also: `background: true` is a no-op on MongoDB 4.2+ and is omitted.)

---

## §12 Open questions / future work

### §12.1 Plugin-provided migrations

Out of scope for v1. A future `definePluginMigration` API may address: install/uninstall up/down, id collision avoidance (`<plugin>:<id>`), and ordering vs. core migrations.

### §12.2 Rollback (down migrations)

Forward-only; rollback delegated to mongo snapshot/restore. Revisited in a separate RFC if round-tripping between major versions becomes a real need.

### §12.3 `crowi-admin doctor`

A thicker `migrate plan` effectively serves the "what should I run" role. If consolidating non-migration checks (Redis connectivity, storage config) becomes valuable, carve out a separate `doctor`.

### §12.4 Concurrency / locking

Protection against simultaneous `migrate apply` runs is out of scope (operational convention). A future iteration could add a lock document in `migrationApplications`.

### §12.5 Cross-migration dependencies

Currently unsupported by design (§5.3). If version + `order` proves insufficient, consider `dependsOn` — but first reconsider the migration boundary.

### §12.6 Seeds in the framework

Idempotent seeds (currently only the OAuth client seed) stay outside the framework. If seeds proliferate or need unified visibility (`list`/`status`), introduce a `layer='seed'` (version-independent, idempotent, always allowed to record `detected-clean`) within the `migrate` namespace at that time.

### §12.7 Preflight boot-refusal policy details

`migration.preflightUnappliedPolicy: 'block' | 'warn'` ships (default `block`); default value, env-var override semantics, and cluster behavior are finalized during implementation.

---

## §13 Related RFCs / references

- RFC-0004 (Page Status): `runPageStatusMigration` is the seed of `page-status-default`.
- RFC-0010 (OAuth client seed): `runOAuthClientSeed`, the example seed kept outside the framework (§12.6).
- RFC-0007 (`drop-legacy-aws-config-migration`): removed `runAwsConfigMigration`; only a `dist/` artifact remains.
- `feature-user-identity-uniqueness`: owns the schema, E11000 mapping, minimal dedup, and the `partialFilterExpression` resolution (§11). The framework owns registration and execution.
- Code references: boot sequence `crowi/index.ts:211-251`; CLI `admin-cli/src/cli.ts` + `commands/{migrate-wikilink,search-rebuild,storage-copy}.ts`; mongoose connect `crowi/index.ts:482-496` (empty options, autoIndex default on); `models/user.ts` (`STATUS_DELETED=4`, `STATUS_INVITED=5`); force-reload `collab/src/hooks/on-load-document.ts`. The framework itself (registry / runner / `migrationApplications` / `migrate plan|apply|status|list`) is **unimplemented** — this RFC is prescriptive.

---

## Appendix A: Placement of the confirmed migrations

| Migration | Legacy (actual) | New placement | layer | from → to |
|---|---|---|---|---|
| Page status backfill (RFC-0004) | `runPageStatusMigration` (boot) | `page-status-default` | boot | `1.x → 2.0` |
| User uniqueness prepare | (new) | `user-unique-prepare` | preflight | `1.x → 2.0` |
| Wikilink syntax | `migrate --only=wikilink` | `wikilink-format` | preflight | `1.x → 2.1` |
| Revisions schema unify | (planned, new) | `revisions-schema-unify` | preflight | `2.0 → 2.1` |
| Renderer derived data | (planned) | `rebuild renderer` | — (rebuild) | — |
| Search index | `search rebuild` | `rebuild search` | — (rebuild) | — |
| Backlink index | (planned, new) | `rebuild backlink` | — (rebuild) | — |
| Storage copy | `storage copy` | `rebuild storage copy` | — (rebuild) | — |
| OAuth client seed (RFC-0010) | `runOAuthClientSeed` (boot) | **unchanged — outside framework** | — (seed) | — |
