# @crowi/admin-cli

## 0.1.0-alpha.5

### Minor Changes

- 80c29e3: Add the durable data model, page-local ordering, and repair machinery for page history (RFC-0021), Phase 1 of the rollout. This adds new `PageHistoryEvent` and `PageHistoryOperation` collections, additive `historySequence` / `historyTracking` / `pendingHistoryEntry` fields on `Page`, and additive `historySequence` / `historyOperationId` fields on `Revision`, plus an idempotent materializer and repair job for the new outbox. No writer produces a `PageHistoryEvent` yet and no HTTP route changes — every existing page keeps recording history exactly as it does today; only newly created pages are marked ready for the writers that later phases will add. Comment creation now re-validates the owning page immediately after insert and removes the comment if the page was trashed or renamed in the meantime, closing a narrow authorize-then-insert race. Adds `crowi-admin page-history repair` (`--outbox` / `--scan`), the operator entry point for draining a crashed writer's leftover outbox entry and, on request, assigning sequences to unsequenced Revisions on already-ready Pages.

### Patch Changes

- Updated dependencies [3545265]
- Updated dependencies [9a06104]
- Updated dependencies [f855266]
- Updated dependencies [0b2656a]
- Updated dependencies [0b62bc0]
- Updated dependencies [80c29e3]
  - @crowi/api@2.0.0-alpha.13

## 0.1.0-alpha.4

### Minor Changes

- 7a7394f: Make `renderedAst` a client-agnostic typed contract (RFC-0023). Renderer producers (shiki, KaTeX, Mermaid, PlantUML, link cards, placeholders) now stamp typed sidecar data onto the byte-identical `html` nodes they already emit, and clients that declare `X-Crowi-Ast-Version: 1` receive a validated `{astVersion, root}` envelope in which those nodes are projected into typed nodes (`code` with themed tokens, `math`/`inlineMath` with TeX source, `crowiDiagram` with intrinsic dimensions, `crowiLinkCard`, `crowiPlaceholder`) — the foundation for native (non-HTML) rendering such as the iOS app. Requests without the header — including the web, permanently — keep receiving the stored bare mdast Root verbatim, so existing clients and open tabs are unaffected. Responses now also carry `renderedAstArtifactKey`, which fixes a web bug where a pending diagram that finished rendering (or a freshness-mismatch recompute) was not re-drawn on refetch because the render memo only keyed on the revision id. Operators: this release bumps the renderer pipeline to 1.0.0 and removes the missing-version freshness special case — run the new `crowi-admin rebuild rendered-ast` (real writes) immediately after deploying, and use `--dry-run` only before that; see the admin guide's "rebuild rendered-ast" section for the rollout and completion procedure.

### Patch Changes

- Updated dependencies [ce69b4a]
- Updated dependencies [8ca7a9b]
- Updated dependencies [c2d0e9c]
- Updated dependencies [4736e06]
- Updated dependencies [7a7394f]
- Updated dependencies [7688188]
  - @crowi/api@2.0.0-alpha.11

## 0.1.0-alpha.3

### Patch Changes

- 0467a05: Clean up `crowi-admin`'s output (affects `migrate` / `rebuild` / `replace` / `watcher-backfill`, and the `pnpm migrate` wrapper). The `[crowi] Loaded N plugin(s)` boot line no longer prints to stdout: in development it moves to stderr (so `crowi-admin migrate plan --json | jq` keeps working), and in production (`NODE_ENV=production`) it is suppressed entirely. Node's own `DeprecationWarning`s (e.g. `DEP0169` from a transitive dependency's `url.parse()` call) are now suppressed on every `crowi-admin` invocation, dev and prod alike. Server boot output (`pnpm dev` / the production server) is unaffected.
- Updated dependencies [abe7ca5]
- Updated dependencies [04cbd85]
- Updated dependencies [a899fdd]
- Updated dependencies [df1ce77]
- Updated dependencies [9122c85]
- Updated dependencies [708c0d5]
- Updated dependencies [05648c0]
- Updated dependencies [d680c0c]
- Updated dependencies [0d21b52]
- Updated dependencies [09d7b9c]
- Updated dependencies [fee9c9a]
- Updated dependencies [4ec60a6]
- Updated dependencies [a32204f]
- Updated dependencies [7e1c54e]
- Updated dependencies [cb3d16c]
- Updated dependencies [b0e2c76]
- Updated dependencies [3b27a67]
  - @crowi/api@2.0.0-alpha.8

## 0.1.0-alpha.2

### Minor Changes

- 89aa2b7: Split the boot-time preflight migration probe by a new per-migration `severity` (`cosmetic` | `blocking`). A `cosmetic` migration (the display-only ones — the body-rewriting `wikilink-format` / `files-url-to-attachments` / `wikilink-html-recover` and the path-relocating `relocate-reserved-api-paths`) that is still pending now only logs a warning and lets the api boot — even under the default `block` policy — while the data-integrity `user-unique-prepare` migration stays `blocking` and still refuses boot under `block` (downgradeable with `MIGRATION_PREFLIGHT_UNAPPLIED_POLICY=warn`). This fixes the deadlock where a newly written page in old wikilink syntax kept a cosmetic migration's corpus-scan probe pending forever and permanently refused the whole cluster's boot. `crowi-admin migrate list` / `migrate plan` now tag each preflight migration `[blocking]` / `[cosmetic]` so operators can judge boot-block risk (boot-layer rows, which are never boot-probed, show `—`).

### Patch Changes

- Updated dependencies [6bbbecd]
- Updated dependencies [89aa2b7]
- Updated dependencies [eb0fca1]
- Updated dependencies [06aeff5]
  - @crowi/api@2.0.0-alpha.3

## 0.1.0-alpha.1

### Minor Changes

- bcfc175: Add `crowi-admin replace url --from <url> --to <url>` for swapping a literal
  URL/host string in every page body — the fix for a v1→v2 migration that changed
  the public domain and left absolute URLs (image embeds / links) pinned to the
  old host. Page / file ids are carried over unchanged, so this is a literal host
  swap, not an id remap.

  Each match is rewritten as a new revision (auditable + revertable) while the
  page's `updatedAt` / `lastUpdateUser` / `grant` are left untouched and no
  `pageEvent` is emitted — so a bulk cleanup does not reorder "recently updated",
  notify every watcher, or auto-watch the operator onto every page. The Yjs
  snapshot is invalidated so collaborative editors rebuild from the new body.
  Supports `--dry-run`, an interactive preview/confirmation (`--yes` to skip),
  `--include-trash`, `--user <email>` (new-revision author; defaults to the oldest
  admin), and a footgun guard that refuses an empty / too-short / scheme-less
  `--from` (a bare host can corrupt longer hosts that start with it) unless
  `--force` is given. After a run, rebuild the search index with
  `crowi-admin rebuild search`; page rendering is already up to date.

### Patch Changes

- Updated dependencies [54f7df3]
- Updated dependencies [c0ca5c2]
- Updated dependencies [9a22d3c]
- Updated dependencies [bcfc175]
- Updated dependencies [82a1ed5]
- Updated dependencies [fa5733c]
  - @crowi/api@2.0.0-alpha.1

## 0.1.0-alpha.0

### Minor Changes

- a52d03f: Initial publish preparation: monorepo restructure complete (RFC-0002 →
  feature-monorepo-packages-restructure). All packages now use
  workspace: protocol internally, peerDependencies for plugin boundaries,
  shared @crowi/tsconfig presets, and a publish-ready layout under
  packages/\*.
- 6eff03b: Introduce a unified migration framework (RFC-0008) that consolidates the
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

- 3f937ae: Add `crowi-admin watcher backfill` for pages created before auto-watch.

  Auto-watch only materialises WATCH rows for participation going forward
  (create / edit / comment), and the notification fan-out is now watcher-only, so
  pages that predate the feature have no watcher rows and their past participants
  stop being notified. The command walks every non-redirect page and creates a
  WATCH row for its implicit notification set (creator + comment authors +
  revision authors), respecting existing IGNORE opt-outs and leaving existing
  WATCH rows untouched. Idempotent; supports `--dry-run`.

### Patch Changes

- Updated dependencies [5a775a3]
- Updated dependencies [60a3cda]
- Updated dependencies [dba0f0d]
- Updated dependencies [20e6395]
- Updated dependencies [8851242]
- Updated dependencies [097a24b]
- Updated dependencies [7fa76b5]
- Updated dependencies [ce294dd]
- Updated dependencies [a804e1c]
- Updated dependencies [f0d69c2]
- Updated dependencies [ad0cc9b]
- Updated dependencies [32f5965]
- Updated dependencies [9c55f6c]
- Updated dependencies [8bfb1fd]
- Updated dependencies [548e0c8]
- Updated dependencies [a52d03f]
- Updated dependencies [a0f4ada]
- Updated dependencies [966d133]
- Updated dependencies [6eff03b]
- Updated dependencies [f04c524]
- Updated dependencies [e7296c0]
- Updated dependencies [f568734]
- Updated dependencies [ec00876]
- Updated dependencies [1fa5a4c]
- Updated dependencies [8f12462]
- Updated dependencies [7f77407]
- Updated dependencies [d293151]
- Updated dependencies [deb6a26]
- Updated dependencies [ea2b7db]
- Updated dependencies [580a3f9]
- Updated dependencies [ee935ad]
- Updated dependencies [b8c067b]
- Updated dependencies [ab063fe]
- Updated dependencies [87f35d4]
- Updated dependencies [be5fcee]
- Updated dependencies [088f922]
- Updated dependencies [dbc4b0a]
- Updated dependencies [8e3d4bf]
- Updated dependencies [10ac192]
- Updated dependencies [56babec]
- Updated dependencies [9899d5f]
- Updated dependencies [a469da3]
- Updated dependencies [4594ad2]
- Updated dependencies [3f937ae]
  - @crowi/api@2.0.0-alpha.0
