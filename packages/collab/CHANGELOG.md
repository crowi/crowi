# @crowi/collab

## 0.1.0-alpha.6

### Patch Changes

- e0dd589: Migrate the last 4 eslintrc-based configs (the repo root, `@crowi/api`, `@crowi/collab`, `@crowi/plugin-search-mongo`) to flat config (`eslint.config.mjs`), so every workspace in the repo now lints through the same config format that `@crowi/web` and `@crowi/site` already used. `eslint` itself moves into the pnpm catalog at `^9.39.5`, so all 7 linted workspaces share one version instead of the previous 8.57.1/9 split.

  This is dev tooling only — no runtime behavior, public type, or API shape changes. Every workspace's lint output was diffed line-by-line against the pre-migration baseline and came back identical (0 errors, same warnings, same files, same line numbers), including `@crowi/api`'s guard rules that block ad hoc test-file DB connections and direct Redis `.duplicate()` calls outside the one helper that installs an error listener first — those guards were restructured from 3 eslintrc override blocks down to 2 flat-config entries (flat config turned out to share eslintrc's "later config replaces, not merges, a repeated rule key" behavior, so the restructuring is a smaller version of the same workaround, not a different one) and their existing regression test (`packages/api/src/test/eslint-db-guard.test.ts`) still passes unmodified assertion-for-assertion, now driving the real flat config via ESLint's Node API with `cwd`-only discovery instead of the removed `useEslintrc` option.

  `eslint` stays on the 9.x series rather than moving to 10: `eslint-config-next` (used by `@crowi/web` and `@crowi/site`) pins `eslint-plugin-react`, whose latest release (7.37.5) calls two APIs ESLint 10 removed outright, so linting a `.tsx` file crashes rather than warns. There is currently no published `eslint-config-next` release that resolves this. Flat config is unaffected by that gap — ESLint 9 already reads it natively — so this migration removes eslintrc from the repo entirely without waiting on the upstream fix; bumping to ESLint 10 later is a single catalog version change once `eslint-plugin-react` supports it.

- ba38a7e: Upgrade `jest` / `@types/jest` / `jest-environment-node` from the 29.x series to 30.5.0 / 30.0.0 / 30.5.0 across the 16 workspaces that share these versions through the pnpm catalog. `ts-jest` stays on 29.4.12 (already accepts `jest@^30`) and `packages/web`'s vitest stack is untouched — this is a test-tooling-only change with no observable behavior difference for users of any of these packages.

  `@crowi/api`'s three custom Jest extension points (the `CrowiEnvironment` test environment's `handleTestEvent`, the `FailureTaxonomyReporter`'s `onTestResult`/`onRunComplete`, and `globalSetup`'s MongoDB connection resolution) were individually verified against jest 30 and continue to work unchanged, as does the `--no-sparkplug` Node 24 V8 workaround the api's test script depends on.

- Updated dependencies [a334308]
  - @crowi/api-contract@2.0.0-alpha.18

## 0.1.0-alpha.5

### Minor Changes

- A page's history now shows what happened to the page itself, not just its content. Renames, visibility changes, moves to the trash, restores and draft publishes appear as their own rows — who did it and when — interleaved with the content revisions in the order they happened, on one timeline (RFC-0021). Each row carries the concrete detail behind it: a rename names the old and new paths and whether a redirect was left behind, a visibility change names both sharing levels, and trash and restore rows name the path the page left or returned to. Comparing revisions works as before — only content rows are selectable, and the default comparison still opens on the most recent change. A new `GET /pages/{pageId}/history` endpoint backs the screen, paginated by an opaque cursor and readable by anyone who can read the page. Pages whose history predates this release keep showing their revisions, simply without a position in the metadata ordering, and users who have since been deleted or suspended appear as an unknown user rather than by name.

  **Clients other than the built-in UI must be updated before upgrading.** `POST /pages/rename`, `POST /pages/rename-subtree`, the soft-delete branch of `DELETE /pages`, and `POST /pages/revert` now require an `Idempotency-Key` header. Each of those runs as a durable operation: a repeated delivery of the same request returns the current page with `Idempotency-Replayed: true` instead of moving anything twice, and the same key sent with a different destination is refused with 409 `IDEMPOTENCY_KEY_CONFLICT`. Hard delete and internal callers such as user-page activation are unchanged and record nothing.

  **Replace every api replica at once when upgrading to this version rather than rolling them.** While a page is between the two writes of a move it is briefly excluded from reads, listings and search rather than being served under an ambiguous path, and a replica running an older version does not recognise that state — it can start a second move on top of one already underway, leaving both unfinished. A single-instance deployment satisfies this automatically. A move interrupted by a crash leaves the page in that recoverable state, and `crowi-admin page-history repair --transitions` settles it or reports it with the operation, page and path so an operator can act; it never rewrites a page whose state it cannot classify.

  Hard-deleting a page or cancelling a draft purges that page's history events, so a deleted page's history never outlives it. Page creation and draft cancellation deliberately record nothing. Page content, search indexing, backlinks, notifications and live-collaboration updates are unaffected.

### Patch Changes

- Updated dependencies [c3329f5]
- Updated dependencies [5270087]
- Updated dependencies [33cb08f]
- Updated dependencies
- Updated dependencies [c810729]
  - @crowi/api-contract@2.0.0-alpha.17

## 0.1.0-alpha.4

### Patch Changes

- 3ba4c69: Add the first writer for page history (RFC-0021 Phase 2a): every content save (page create, draft create, HTTP update/revert, collaborative editor save, and `crowi-admin replace url`) now assigns a page-local `historySequence` to its Revision, promoting the page's `historyTracking` to `ready` on its first tracked save. Sequence assignment runs as a separate, resumable step after the existing pointer write commits, never as part of it, so a crash between the two never fails the save — a background/operator repair pass recovers any interrupted assignment. `scanUnsequencedRevisions` now skips Revisions younger than a configurable grace window (`RepairScanOptions.minAgeMs`, default 10 minutes) and Revisions predating a page's tracking start, so it never races a still-in-flight assignment or mis-orders history. No request/response shape, status code, error body, or OpenAPI contract changes — this is purely additive bookkeeping invisible to end users.
- Updated dependencies [c1cb3d5]
  - @crowi/api-contract@2.0.0-alpha.15

## 0.1.0-alpha.3

### Patch Changes

- a899fdd: Fix a correctness hole where a live collaborative editor open before a page was renamed, soft-deleted, or reverted could still save its content afterwards, silently clobbering the renamed/deleted state instead of being rejected.
  The fix introduces a monotonic collab lifecycle epoch (`Page.collabLifecycleVersion`) that advances atomically with every rename/delete/revert/body-replace and is enforced at four boundaries — wsToken mint, WebSocket authentication, document load, and the atomic save compare-and-set — so a stale editor session is refused rather than allowed to overwrite the page, including across multiple api replicas.
  Rename/delete now also opens the existing reload-prompt dialog on any live editor for that page, and soft/hard delete purge the page's collaborative editing state (Yjs snapshot and pending updates) as defense-in-depth.
- Updated dependencies [d9eb1c0]
- Updated dependencies [a899fdd]
- Updated dependencies [f1bcd2b]
- Updated dependencies [29b3679]
- Updated dependencies [a32204f]
- Updated dependencies [b0e2c76]
- Updated dependencies [3b27a67]
  - @crowi/api-contract@2.0.0-alpha.8

## 0.1.0-alpha.2

### Minor Changes

- 6bbbecd: Harden the realtime collaborative editor against data loss and external-edit divergence. This is the full implementation of the reliability work: alpha.2 shipped only a small seed of external-edit invalidation under an over-scoped changeset, and the complete implementation (a ~5k-line overhaul across `@crowi/collab` and the api collab host) lands here.

  Guard the Yjs document state against shrink and loss: compaction never replaces a document with a smaller or empty state, the document's base revision is persisted so a reconnecting client re-materialises from the correct revision body, and an empty-load fallback rebuilds the doc from the stored revision instead of starting blank.

  External (REST / MCP / in-process) edits now invalidate a live collab session in the same api process: after the page commits, Crowi broadcasts a force-reload, tombstones the document so an in-flight stale save is rejected with a reload prompt instead of CONFLICT-looping, gates reconnects so they re-materialise from the new revision, and drains the stale connections (a force-reload was previously a no-op while any client stayed connected). Two concurrent same-process saves carrying a byte-identical body now coalesce into a single success with the loser recorded as a contributor, while a genuine divergence still surfaces as CONFLICT so the user reloads.

  Multi-instance / out-of-process external edits (a live doc on another replica, or an admin-CLI DB-direct edit) remain a documented limitation requiring a future cross-instance invalidation channel; a single api instance is recommended (see the realtime-collab operations doc).

## 0.1.0-alpha.1

### Patch Changes

- 27ef287: Fix v1-era pages getting corrupted when opened in the collaborative editor.
  Revision bodies were seeded into the Y.Text verbatim, but Crowi v1 saved
  bodies with CRLF (`\r\n`) line endings while CodeMirror 6 strips every `\r`
  when it builds its document. That left the Y.Text one character longer per
  line than the editor's view, and because y-codemirror.next maps positions
  1:1 between them, every subsequent edit landed at the wrong offset and
  progressively mangled the document (worse toward the end of the page).

  The `onLoadDocument` body seed now normalizes CRLF / lone CR to LF before
  inserting into the Y.Text, keeping it length-aligned with the editor.
  Markdown rendering is line-ending agnostic, so this is a no-op for
  already-LF (v2-authored) bodies. Pages that were already corrupted by a
  prior edit must be restored from a pre-corruption revision.

- Updated dependencies [0e9a07c]
  - @crowi/api-contract@2.0.0-alpha.1

## 0.1.0-alpha.0

### Patch Changes

- Updated dependencies [8d8e04d]
- Updated dependencies [c7443c4]
- Updated dependencies [ce294dd]
- Updated dependencies [ad0cc9b]
- Updated dependencies [32f5965]
- Updated dependencies [9c55f6c]
- Updated dependencies [548e0c8]
- Updated dependencies [a52d03f]
- Updated dependencies [a0f4ada]
- Updated dependencies [966d133]
- Updated dependencies [e7296c0]
- Updated dependencies [ec00876]
- Updated dependencies [8f12462]
- Updated dependencies [637f0c9]
- Updated dependencies [deb6a26]
- Updated dependencies [ea2b7db]
- Updated dependencies [ee935ad]
- Updated dependencies [b8c067b]
- Updated dependencies [ab063fe]
- Updated dependencies [87f35d4]
- Updated dependencies [be5fcee]
- Updated dependencies [088f922]
- Updated dependencies [97e6543]
- Updated dependencies [10ac192]
- Updated dependencies [9899d5f]
- Updated dependencies [4594ad2]
  - @crowi/api-contract@2.0.0-alpha.0
