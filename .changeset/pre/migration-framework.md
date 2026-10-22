---
'@crowi/api': minor
'@crowi/admin-cli': minor
---

Introduce a unified migration framework (RFC-0008) that consolidates the
previously scattered admin operations (`migrate-wikilink`, search rebuild,
storage copy) and the boot-time page-status backfill behind a single shared
runner, registry, and audit log.

What's new:

- **Two command namespaces on one shared runner.** `crowi-admin migrate`
  (plan / apply / status / list) drives schema/data migrations, while
  `crowi-admin rebuild` (search / storage copy / renderer / backlink) drives
  idempotent rebuild tasks. Both share dry-run, progress reporting, bounded
  concurrency, SIGINT-safe interruption, and structured logging.
- **Two-layer boot vs. preflight model.** `boot` migrations run automatically
  on startup; `preflight` migrations must be applied by an operator before
  boot. Unapplied preflight migrations are handled by
  `preflightUnappliedPolicy` (`block` = all replicas fail-fast, the default;
  `warn` = log and continue), overridable via
  `MIGRATION_PREFLIGHT_UNAPPLIED_POLICY`.
- **page-status-default (boot)** ports the RFC-0004 page status backfill into
  the framework.
- **wikilink-format (preflight)** ports the legacy wikilink syntax conversion
  and fixes a bug where the old `migrate-wikilink` command bypassed the
  `updatePage` path and left stale Yjs state on rewritten pages. Body rewrites
  now go through the canonical path that nulls `yjsState` / `yjsCheckpointAt`
  so collaborative editors reload the new body.
- **User identity uniqueness enforcement.** `users.username` / `users.email`
  now carry case-insensitive (`collation {locale:'en',strength:2}`) plain
  unique indexes. Account deletion writes a per-id tombstone identity so
  deleted users no longer collide. The `user-unique-prepare` preflight
  migration deduplicates pre-existing duplicate accounts (merging references
  across all collections) so the unique index can be built safely, and E11000
  duplicate-key errors on every write path (registration, invitation accept,
  email change, `/me`, admin user edit) are now mapped to
  `USERNAME_TAKEN` / `EMAIL_TAKEN` instead of surfacing as a 500.
- **migrationApplications audit log** records each applied migration
  (append-only, self-bootstrapping); inspection (`isPending`) remains the
  source of truth and the log is reconciled against it.

BREAKING (CLI): the legacy command forms are removed with no compatibility
aliases. Update operator scripts:

- `crowi-admin migrate --only=wikilink` → `crowi-admin migrate apply --id wikilink-format`
- `crowi-admin search rebuild` → `crowi-admin rebuild search`
- `crowi-admin storage copy` → `crowi-admin rebuild storage copy`
