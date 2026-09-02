# @crowi/api

## 2.0.0-alpha.18

### Patch Changes

- e0dd589: Migrate the last 4 eslintrc-based configs (the repo root, `@crowi/api`, `@crowi/collab`, `@crowi/plugin-search-mongo`) to flat config (`eslint.config.mjs`), so every workspace in the repo now lints through the same config format that `@crowi/web` and `@crowi/site` already used. `eslint` itself moves into the pnpm catalog at `^9.39.5`, so all 7 linted workspaces share one version instead of the previous 8.57.1/9 split.

  This is dev tooling only — no runtime behavior, public type, or API shape changes. Every workspace's lint output was diffed line-by-line against the pre-migration baseline and came back identical (0 errors, same warnings, same files, same line numbers), including `@crowi/api`'s guard rules that block ad hoc test-file DB connections and direct Redis `.duplicate()` calls outside the one helper that installs an error listener first — those guards were restructured from 3 eslintrc override blocks down to 2 flat-config entries (flat config turned out to share eslintrc's "later config replaces, not merges, a repeated rule key" behavior, so the restructuring is a smaller version of the same workaround, not a different one) and their existing regression test (`packages/api/src/test/eslint-db-guard.test.ts`) still passes unmodified assertion-for-assertion, now driving the real flat config via ESLint's Node API with `cwd`-only discovery instead of the removed `useEslintrc` option.

  `eslint` stays on the 9.x series rather than moving to 10: `eslint-config-next` (used by `@crowi/web` and `@crowi/site`) pins `eslint-plugin-react`, whose latest release (7.37.5) calls two APIs ESLint 10 removed outright, so linting a `.tsx` file crashes rather than warns. There is currently no published `eslint-config-next` release that resolves this. Flat config is unaffected by that gap — ESLint 9 already reads it natively — so this migration removes eslintrc from the repo entirely without waiting on the upstream fix; bumping to ESLint 10 later is a single catalog version change once `eslint-plugin-react` supports it.

- ca28907: `crowi-admin rebuild backlink` no longer destroys the backlink index when a page has no revision. The rebuild deleted every backlink up front and then crashed on the first page whose revision was missing, leaving the instance with no backlinks and no working way to restore them — the rebuild is itself the documented recovery path. It now resolves every link before deleting anything, so a failed run leaves the previous backlinks in place, and pages without a revision are excluded from the scan.
- ba38a7e: Upgrade `jest` / `@types/jest` / `jest-environment-node` from the 29.x series to 30.5.0 / 30.0.0 / 30.5.0 across the 16 workspaces that share these versions through the pnpm catalog. `ts-jest` stays on 29.4.12 (already accepts `jest@^30`) and `packages/web`'s vitest stack is untouched — this is a test-tooling-only change with no observable behavior difference for users of any of these packages.

  `@crowi/api`'s three custom Jest extension points (the `CrowiEnvironment` test environment's `handleTestEvent`, the `FailureTaxonomyReporter`'s `onTestResult`/`onRunComplete`, and `globalSetup`'s MongoDB connection resolution) were individually verified against jest 30 and continue to work unchanged, as does the `--no-sparkplug` Node 24 V8 workaround the api's test script depends on.

- d1fc876: Upgrade the `redis` client dependency from 4.7.1 to 6.2.1. Redis-backed features (config sync, presence, rate limiting, LRU, editor-cap, link completion, collab) behave the same as before; `ioredis` (used by the realtime-collab Redis extension) stays on 5.x since the extension pins that major.
- af4d198: Fix rename so it promotes an untracked page to tracked history in place instead of silently skipping its history event.

  A page created before history tracking existed, or otherwise never promoted by a content save, previously moved successfully on rename but recorded no `page_renamed` event and never became history-tracked — and in a subtree rename, such a member was reported as a failure even though its page moved correctly. Rename now checks the page's current revision pointer right before the move: if it is untracked but owns a valid revision, that page is promoted to tracked history in the same request, the move proceeds as an ordinary tracked rename, and the event is recorded. A page with no revision pointer, or whose pointer cannot be confirmed to belong to it, is left exactly as before — it still moves, just without gaining history tracking. A promotion that cannot complete safely (a transient conflict) is reported the same way other transient rename conflicts are, and retrying succeeds.

- 3dad335: Fix a race in subtree rename where a concurrent duplicate delivery could report a page as failed to move even though the rename succeeded.

  When two deliveries of the same rename request raced under load, a member page's fan-out could read its operation record as missing right before the other delivery created it and moved the page, then derive a from/destination path pair that was already the destination on both sides. That mismatched the delivery that actually moved the page and was reported back as a failure, even though the page landed correctly and no data was lost. The fan-out now reads the page before its operation record and reads that record from the primary, so a request racing a concurrent move always sees either the pre-move page or the already-created operation, never a mix of the two (AC-1, AC-2). Retries on the already-moved page still resume from the saved from/to path (AC-5), duplicate requests with a different body are still rejected before fan-out (AC-3), and all three member-key lookups now read from the primary (AC-4).

- a334308: Upgrade TypeScript 5.8 → 6.0 across the whole workspace catalog, plus the two tools whose own peer ranges gated it: `ts-jest` 29.3 → 29.4 (the current version still excluded TS 6) and `@typescript-eslint` 6.21 → 8.68 (moved into the catalog so all five workspaces that declare it directly stay in lockstep). `eslint` itself is untouched, jest stays on the same major, and TypeScript 7 (a native/Go rewrite still landing ecosystem-wide support) is out of scope — this bump is the sanctioned bridge release for that eventual move.

  Runtime behavior and every public type/API shape are unchanged; the generated `.d.ts` output was diffed against the pre-upgrade build across all 316 declaration files and the only differences found were union-member reordering (an internal declaration-emitter artifact, byte-identical content once sorted) with zero content changes.

  Two compiler-level fallouts were absorbed without weakening `strict` or any other type-safety setting:

  - TS 6 hard-errors on two now-deprecated `tsconfig` options that will disappear in TS 7 (`moduleResolution: "node"` and any `baseUrl`, the latter also implicitly injected by `tsup`'s own declaration bundler on every workspace that ships a `.d.ts`). The shared `tsconfig/base.json` now sets `ignoreDeprecations: "6.0"`, which is TypeScript's own documented bridge flag for this exact transitional release; actually migrating off these options is real resolution-strategy work that belongs with the eventual TS 7 move, not this version bump.
  - TS 6 stopped auto-including `@types/*` packages for workspaces using `moduleResolution: "bundler"` unless a tsconfig's `types` array names them explicitly. Several `library.json`-based packages picked up this newly-required `types: ["node"]` / `types: ["jest", "node"]`, matching the explicit-`types` convention several sibling packages (`svg-sanitize`, `admin-cli`, the search plugins, etc.) already used for the same reason.

  `@typescript-eslint` 8's `recommended` preset also added `no-require-imports` (superseding the deprecated `no-var-requires` most call sites already had a justified `eslint-disable` comment for) and tightened `no-empty-object-type` against empty `interface X extends Y {}` declarations. Every new diagnostic was resolved individually: existing suppression comments were extended to cover the new rule name, a handful of genuinely dead/redundant `require()` calls were deleted, two `require()` calls were converted to static imports, and three `Pick<...>`-only marker interfaces became plain type aliases (a mechanical, meaning-preserving rewrite, not a design change).

  `@crowi/web` and `@crowi/site` lint through `eslint-config-next`, which bundles its own `typescript-eslint` dependency rather than reading the workspace catalog. That bundled copy (8.53.0) declared `typescript: >=4.8.4 <6.0.0`, a TS6-excluding range. A `pnpm.overrides` entry (`"typescript-eslint@<8.68.0": "8.68.0"`) forces it to the same 8.68.0 already used directly by the five workspaces above, whose peer range (`>=4.8.4 <6.1.0`) accepts TS 6. No new lint errors surfaced in either workspace after the bump.

  One TS6-excluding tool remains in the graph with no available fix: `openapi-typescript` 7.13.0 (used only by `@crowi/api-contract`'s dev-time OpenAPI-types codegen script, `scripts/generate-openapi-types.ts`) declares `typescript: ^5.x`, and 7.13.0 is still the latest release. This surfaces only as a non-fatal `pnpm install` peer-dependency warning — pnpm does not fail installs on unmet peers by default, and the tool isn't part of `type-check` / `build` / `test` / `lint`. It was verified functionally: `pnpm --filter @crowi/api-contract generate` runs clean under TS 6, and `pnpm check:openapi` confirms the regenerated artifacts are byte-identical to the committed ones. Revisit once openapi-typescript ships a TS6-compatible release.

- Updated dependencies [e0dd589]
- Updated dependencies [ba38a7e]
- Updated dependencies [a334308]
  - @crowi/collab@0.1.0-alpha.6
  - @crowi/plugin-api@1.0.0-alpha.9
  - @crowi/runner@0.1.0-alpha.3
  - @crowi/api-contract@2.0.0-alpha.18

## 2.0.0-alpha.17

### Minor Changes

- c3329f5: Permanently deleting a page now leaves a record of who did it and when (RFC-0021). Until now a hard delete removed the page and everything attached to it, so the question "who deleted this?" had no answer anywhere — the page's own history went with it. The new record survives because it is not attached to the page at all: it keeps the path the page last occupied, who deleted it, and when, and nothing else. No title, no body, no permissions, no share tokens — deleting a page still deletes its content, and the record is not a backdoor to reading it. Only a user's own permanent deletion is recorded; internal cleanups such as cancelling a draft or removing a redirect stub are not, so the record always means a person deleted something rather than the system tidying up. The record is written before the page is removed, so an interrupted deletion leaves a visible record beside a page that still exists rather than silently losing the evidence. Records are visible to administrators only, through three new admin endpoints — recent deletions, deletions of a known page id, and deletions at a given path — and they never appear in a page's own history. They do not expire on their own: an administrator erases them explicitly, one record or one path at a time, and the erasure itself is logged by identifier so that it stays auditable without recording what was erased. There is deliberately no "erase everything".
- 33cb08f: Add self-service OAuth session management under Settings > Security. Users can now see a list of the OAuth refresh-token rotation-chain tips issued to apps they've authorized (client name, granted scopes, when authorized, when last refreshed, and when it expires) and revoke any of them individually. Revoking stops future token refreshes reachable from that row, but an already-issued access token remains usable until it naturally expires (up to 1 hour by default) — there is no immediate-revocation mechanism for access tokens. The new `GET /me/oauth-sessions` and `DELETE /me/oauth-sessions/{id}` endpoints never expose the underlying token or its hash, and never include the browser's own web login session in the list.
- A page's history now shows what happened to the page itself, not just its content. Renames, visibility changes, moves to the trash, restores and draft publishes appear as their own rows — who did it and when — interleaved with the content revisions in the order they happened, on one timeline (RFC-0021). Each row carries the concrete detail behind it: a rename names the old and new paths and whether a redirect was left behind, a visibility change names both sharing levels, and trash and restore rows name the path the page left or returned to. Comparing revisions works as before — only content rows are selectable, and the default comparison still opens on the most recent change. A new `GET /pages/{pageId}/history` endpoint backs the screen, paginated by an opaque cursor and readable by anyone who can read the page. Pages whose history predates this release keep showing their revisions, simply without a position in the metadata ordering, and users who have since been deleted or suspended appear as an unknown user rather than by name.

  **Clients other than the built-in UI must be updated before upgrading.** `POST /pages/rename`, `POST /pages/rename-subtree`, the soft-delete branch of `DELETE /pages`, and `POST /pages/revert` now require an `Idempotency-Key` header. Each of those runs as a durable operation: a repeated delivery of the same request returns the current page with `Idempotency-Replayed: true` instead of moving anything twice, and the same key sent with a different destination is refused with 409 `IDEMPOTENCY_KEY_CONFLICT`. Hard delete and internal callers such as user-page activation are unchanged and record nothing.

  **Replace every api replica at once when upgrading to this version rather than rolling them.** While a page is between the two writes of a move it is briefly excluded from reads, listings and search rather than being served under an ambiguous path, and a replica running an older version does not recognise that state — it can start a second move on top of one already underway, leaving both unfinished. A single-instance deployment satisfies this automatically. A move interrupted by a crash leaves the page in that recoverable state, and `crowi-admin page-history repair --transitions` settles it or reports it with the operation, page and path so an operator can act; it never rewrites a page whose state it cannot classify.

  Hard-deleting a page or cancelling a draft purges that page's history events, so a deleted page's history never outlives it. Page creation and draft cancellation deliberately record nothing. Page content, search indexing, backlinks, notifications and live-collaboration updates are unaffected.

- c810729: Saving local storage, AWS S3, or Elasticsearch configuration from `/admin/plugins` now runs a non-blocking connectivity/permission check right after the existing save and hot-reload finish. Local and S3 do a real `put` / `get` / `delete` round trip under a reserved key namespace, entirely separate from uploaded attachments; Elasticsearch calls the cluster's `info` API once. The admin UI shows the outcome next to the existing save toast — "saved, but verification failed" with one of a small set of fixed reasons (unreachable, authentication failed, not found, write denied, unknown) — without ever undoing the save; a failed check is informational only.

  The check always reflects just the api instance that answered the save request, never a cluster-wide result, and every form control (including the linked-identities confirmation dialog) is disabled while a save is in flight so edits can't race the response.

  Plugin authors can opt into the same mechanism via the new optional `CrowiPlugin.verifyConfig` hook in `@crowi/plugin-api`, documented in that package's README.

- d55357e: Turn a plain `<br>` / `<br/>` / `<br />` line break (tag name case-insensitive, such as `<BR>`) in a paragraph, heading, or table cell into a real line break on non-web clients instead of a placeholder for unrenderable content — non-web clients on the versioned AST contract treat raw HTML as opaque content and used to show a visible placeholder for a bare `<br>` even though its meaning is fully known, but the renderer now normalizes it into the same canonical line-break node it already produces for an ordinary manual line break, as long as nothing else in that paragraph, heading, or table cell is raw HTML (a `<br>` that shares a cell or paragraph with other raw HTML, for example a cell mixing `<b>bold</b>` with a line break, is left exactly as it renders today); table cells with multiple line breaks (`a<br>b<br>c`) get every one of them, and one cell's raw HTML no longer blocks a normalized line break in a neighboring cell of the same row, while a normal paragraph or table cell with no other raw HTML in it keeps the exact same appearance in the browser — the same visual line break, just carried on a wire type non-web clients already understand; for sites that have enabled the optional Crowi 1.x compatibility plugin, a `<br>` directly after a heading written without a space (`##heading<br>body`) is now treated the same as a real line break there too, which means the blank line that plugin used to leave behind is gone; existing pages pick up the new rendering the next time they're viewed, and an operator can also run `crowi-admin rebuild rendered-ast` to backfill the stored copy in bulk.

### Patch Changes

- 0bfad27: Saving an auth provider plugin's credentials (e.g. `@crowi/plugin-google`'s OAuth client id/secret) from `/admin/plugins` now requires confirmation when users are already linked through that provider. The save returns a 409 with the number of linked users; resubmitting with `confirmLinkedIdentities: true` proceeds. The admin UI shows a confirmation dialog with the count and re-sends automatically when confirmed. Saves that touch only unrelated settings, plugins with zero linked users, or plugins that register no auth driver are unaffected.
- a113cf2: If two initial-setup requests race and one finishes while the other's configuration write fails partway through, the finished setup's configuration is no longer deleted — the public installer stays closed and keeps reporting "already installed" instead of reopening and exposing an uninstalled-looking instance.

  When a configuration save fails partway through, the running instance now serializes its config-changing writes so a different save that succeeds in the same window is never rolled back by the failed save's own recovery reload, and the ordering holds all the way through that failed save's own reconfiguration, not just its database write.

  After a configuration save fails partway through, the instance that attempted the write now reconfigures itself the same way every other instance does — publishing the change to other instances exactly as before — instead of being left running against the old configuration while its own in-memory cache has already moved on. A plugin that writes its own configuration back while reacting to that reconfiguration cannot deadlock the instance, and a normal successful save still reconfigures only once, from the admin action that made it.

- 5270087: Saving admin settings that fail to persist to the database now returns an error instead of a false 200, and the failed value is no longer applied to the running instance or its replicas — a reload used to silently show the pre-save value with no indication anything had gone wrong.
  This also fixes plugin config saves: a connectivity-check notice ("saved, but verification failed") could previously appear for a value that was never actually written to the database.
  `PUT /admin/app` and `PUT /admin/mail` can now return a 500 on a write failure, matching the existing behavior of `/admin/auth`, `/admin/security`, and `/admin/plugins/config`.
- 0d205c7: When saving admin settings partially fails to persist (some keys wrote, others didn't), the running instance now reloads its configuration from the database instead of leaving stale values in memory — every replica's in-memory config stays in agreement with what's actually stored, and the write failure still surfaces to the admin as before.

  If the very first setup fails to write its seed configuration to the database, the installer can be reopened instead of permanently reporting "already installed" with no way to proceed.

- 139776e: Fix authorization and recovery gaps in the path-moving commands' re-entry handling (RFC-0021). Replaying a subtree rename after losing access to the page no longer returns its current content — the retry now re-checks the caller's grant at the time of the replay instead of trusting that the original request was authorized. Retrying a rename, trash, or restore that was interrupted mid-move (crashed between entering and leaving its transition) now resumes and completes instead of dead-ending in a 404 that only an administrator's repair tool could clear; a normal (non-retry) request against a page that is genuinely mid-move by another operation now correctly reports 409 "in progress" rather than 404 "not found". Completed path-moving operation records are now removed automatically once their retention period elapses, via a TTL index that was missing from the collection; records still in flight are left untouched. Finally, opening a page's history with an uppercase-hex page id now works past the first page — pagination cursors are compared against the normalized id instead of the raw request parameter.
- 0ee7c5b: Treat every spelling of an attribute-less `<br>` as a line break for non-web clients, not just the three that happened to be listed. A `<br >` or `<br  />` — same tag, same meaning, indistinguishable to anyone reading the page — used to stay a placeholder on clients that read the versioned AST, while `<br>` next to it became a real break. The accepted set is now defined by what the Markdown parser can actually produce: zero or more space, tab, CR or LF before an optional `/`. Attributes, other tags, and text sharing the node still disqualify it, exactly as before.
- 21a7a19: Temporary passwords issued by an admin password reset and by user invitation are now generated from `crypto.randomInt` instead of `Math.random()`, which is not cryptographically secure — its internal state can be recovered from a handful of observed outputs, making later "random" values predictable. Both call sites now share one generator, so a compromised generator can no longer be fixed in one place while leaving the other exposed. The character set (uppercase/lowercase letters, digits, `!=-_`) and the 12-character minimum length are unchanged; the invitation path, which previously produced a shorter value, is now at least as long as the admin-reset path. No change to password hashing, legacy compatibility, or any user-facing flow.
- efec24f: Fix a subtree rename occasionally being reported as a partial failure (HTTP 400) even though every page moved successfully. This happened when two deliveries of the same rename raced each other and the losing one checked whether the move had committed a moment too early, before the confirming record caught up — a timing race, not a logic error that could return the wrong page. No page data was ever affected; only the response reporting was wrong. Concurrent subtree renames now consistently report success when the move actually succeeded.
- Updated dependencies [c3329f5]
- Updated dependencies [5270087]
- Updated dependencies [33cb08f]
- Updated dependencies
- Updated dependencies [c810729]
  - @crowi/api-contract@2.0.0-alpha.17
  - @crowi/collab@0.1.0-alpha.5
  - @crowi/plugin-api@1.0.0-alpha.8

## 2.0.0-alpha.16

### Major Changes

- 9a288e3: Linking a federated identity (Google, or any other configured provider — RFC-0014) from `/me` is rebuilt as three authenticated steps instead of one unauthenticated top-level redirect. Pressing "link" on an unlinked provider now sends an authenticated request that mints the identity-provider authorization URL, then the browser navigates there directly; returning from the provider shows a one-time confirmation on the Security tab ("Link the Google account `xxx@example.com`?", or just the provider name when the provider doesn't return a displayable email) that the user must explicitly confirm before the identity is attached — closing the dialog or navigating away links nothing. The previous flow was unauthenticated at the point the identity provider redirected back, which meant a copied authorization link could be used by anyone to attach an identity provider account they controlled to whichever Crowi account had started that link — a permanent backdoor into that account for whoever opened the copied link. The new flow authenticates both the start and the final confirmation, binds the target account to the server-resolved session at start time (never to anything the callback carries), and re-validates that the account is still active with an unchanged authentication state immediately before attaching the identity.

  **Breaking**: the `POST /api/auth/providers/:name/link-grants` endpoint and the `link`/`link_grant` query parameters on `GET /api/auth/providers/:name/start` are removed; a request using either now fails instead of degrading to a plain sign-in. Normal federated sign-in, unlinking, and `GET /api/auth/providers/identities` are unchanged.

  **Operator note**: because this release replaces the shared OAuth state cookie's linking payload with a flow-specific one, deployments running more than one API replica must drain and replace all replicas at the same time for this release — a one-at-a-time rolling update is not supported, since an old replica can still read (and delete before validating) the new cookie format during the overlap window, which would also break unrelated in-flight sign-ins on that replica. Single-instance deployments satisfy this automatically. Multi-instance deployments must also have `REDIS_URL` configured so the confirmation code is visible to whichever replica handles the follow-up confirmation request.

### Patch Changes

- 2241261: Added a native Google Cloud Storage driver plugin (`@crowi/plugin-storage-gcs`, driver name `gcs`) so operators can store page attachments and profile pictures in a GCS bucket, using Application Default Credentials by default with an encrypted inline service-account key as a fallback.

  - Bucket, optional object prefix, optional project ID, and optional service-account key JSON are configured from `/admin/plugins`; the four fields save together as one encrypted document and hot-reconfigure without a restart while `gcs` is not yet the active driver.
  - Missing-object behavior matches the existing `local`/`s3` drivers exactly (same placeholder/`FILE_MISSING`/derivative-fallback UX), and V4 signed URLs are supported for future direct-delivery use without changing how attachments are served today (still proxied through the Crowi API).
  - The full runner and full Docker image now bundle this plugin (the active driver stays `s3` unless an operator explicitly switches `storage.driver` to `gcs`), and `crowi-admin rebuild storage copy` supports migrating existing files from `local`/`s3` to GCS via a full-stop copy procedure documented in the operations guide.

- Updated dependencies [9a288e3]
  - @crowi/api-contract@2.0.0-alpha.16

## 2.0.0-alpha.15

### Patch Changes

- c1cb3d5: Admins can now see which users have a linked federated identity (RFC-0014) and disconnect one from the user list — the users table shows a linked-account icon per row, and a new row action unlinks a provider. If the target user has no password, the admin unlink issues a random one and shows it once (mirroring the existing password-reset flow); an existing password is left untouched. An admin can never unlink their own identity from this screen, and unlinking is refused instance-wide while password sign-in is disabled, since either would strand the account. The unlink removes the same registration-journal row the self-service unlink already cleans up, so the disconnected provider account cannot walk straight back into the account through the sign-in screen.

  An account with a linked federated identity can no longer have its email address changed by an admin either: `PUT /admin/users/{id}/email` now refuses a different address with `409 EMAIL_LOCKED_BY_FEDERATED_IDENTITY`, the same way the self-service `PUT /me` already does. Unlinking the identity first is the only way to change it. The user-edit dialog no longer has an email field at all — `PATCH /admin/users/{id}` now updates only the display name, and email changes go exclusively through the dedicated "Change email" dialog, so there is exactly one email-writing path to lock.

- ee76fb4: Two or more processes refreshing the same OAuth refresh token at nearly the same time no longer forces a re-login. The server now suppresses rotation-reuse-chain revocation for a short grace window (default 60s, tunable via `OAUTH_REFRESH_REUSE_GRACE_MS`, `0` restores the previous immediate-revocation behavior) after a token is rotated away, while still returning the exact same `400 invalid_grant` response and never issuing a token on the suppressed path — reuse outside the window, and explicit `POST /oauth/revoke` calls, still revoke the whole chain exactly as before. The CLI (`crowi`) now recovers automatically on the losing side of such a race: when a refresh fails, it re-reads the locally stored profile and retries once with the refresh token a concurrent `crowi` process already rotated to, instead of surfacing a spurious session-expired error.
- 3ba4c69: Add the first writer for page history (RFC-0021 Phase 2a): every content save (page create, draft create, HTTP update/revert, collaborative editor save, and `crowi-admin replace url`) now assigns a page-local `historySequence` to its Revision, promoting the page's `historyTracking` to `ready` on its first tracked save. Sequence assignment runs as a separate, resumable step after the existing pointer write commits, never as part of it, so a crash between the two never fails the save — a background/operator repair pass recovers any interrupted assignment. `scanUnsequencedRevisions` now skips Revisions younger than a configurable grace window (`RepairScanOptions.minAgeMs`, default 10 minutes) and Revisions predating a page's tracking start, so it never races a still-in-flight assignment or mis-orders history. No request/response shape, status code, error body, or OpenAPI contract changes — this is purely additive bookkeeping invisible to end users.
- Updated dependencies [c1cb3d5]
- Updated dependencies [3ba4c69]
  - @crowi/api-contract@2.0.0-alpha.15
  - @crowi/collab@0.1.0-alpha.4

## 2.0.0-alpha.14

### Minor Changes

- cb0608a: Render a document-leading YAML frontmatter block as a muted key/value table instead of letting it fall through as a broken horizontal rule and paragraph.

  Pages that start with a `---`-delimited frontmatter block (common when pasting a spec, RFC, or other document with metadata headers) used to render that block as a mangled paragraph, since the renderer had no concept of frontmatter at all. The pipeline now parses a document-leading `---` block, scans it line-by-line into an ordered list of key/value entries (never a full YAML parse, so there is no anchor/alias expansion attack surface), and displays it as a compact two-column table above the body. A frontmatter block that is empty renders nothing; one that is malformed, or exceeds a bounded size, is preserved verbatim as a fenced `yaml` code block so no content is ever lost. A `---` anywhere other than the very first line of the document is unaffected and still renders as an ordinary horizontal rule. Existing pages pick up the new rendering the next time they're viewed; an operator can also run `crowi-admin rebuild rendered-ast` to backfill the stored copy in bulk.

- e8d5fa5: Render GitHub Alerts markers (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`) as titled callouts instead of a block quote with a stray `[!NOTE]` line in it.

  A block quote at the top level of a page whose first line is one of the five markers (upper, lower or mixed case) now renders as a callout with its own English title, icon and accent colour, in both the page view and the editor preview. The quote's contents are otherwise untouched — links, lists, code, images and nested quotes inside it render exactly as they do anywhere else. Anything that is not unambiguously a marker deliberately keeps today's rendering, marker text and all: an unknown token like `[!HINT]`, a marker sharing its line with body text, an escaped `\[!NOTE]`, a marker with no content under it, and a marker inside a list item or another quote. Existing pages pick up the new rendering the next time they're viewed: the renderer pipeline goes from 1.1.0 to 1.2.0, and a page whose stored render output is still 1.1.0 is recomputed while serving that read — nothing is written back to the database, so no save and no migration is needed for the callout to appear. An operator can still run `crowi-admin rebuild rendered-ast` to backfill the stored copies in bulk. During a rolling deployment, replicas still on the previous version keep serving the old rendering for the same page until they are all updated. Clients on the versioned AST contract (the iOS app) receive these quotes as ordinary block quotes with their literal `[!NOTE]` marker line and its line break still in place, so they keep rendering these pages as they do today and need no update.

- 8e881d0: The server now publishes its upload policy at `GET /attachments/upload-policy` (allowed MIME types, extension-to-MIME hints, and per-route size limits), so clients no longer have to guess what an instance accepts. `@crowi/cli`'s `attach add` fetches (and caches per profile) this policy before uploading and rejects an oversized file or a disallowed type locally, instead of waiting for a 413/415 round trip; against an older server that lacks the endpoint (404), it falls back to its built-in extension table exactly as before, so nothing regresses. Profile picture uploads (`POST /me/picture`) now resolve the effective MIME type from the filename when the client doesn't declare a `Content-Type` (the same fallback already used by attachment uploads), so CLI, curl, and MCP clients can finally set a profile picture without declaring one. Profile picture acceptance also moves from an unbounded `image/*` pattern to the same finite image-type allow-list attachments use, plus a 5MB size cap matching the web client's existing crop-dialog guard; a declared `image/*` type outside that list (e.g. `image/tiff`) or a file over 5MB is now rejected, which it previously was not.
- 5096980: Attachment uploads now share a single 50 MB size limit across the "Attach file" button, editor paste, and drag-and-drop — previously these disagreed (100 MB / 10 MB / 50 MB respectively), and the paste limit in particular did nothing to bound memory usage since the request body was already fully buffered before it was checked. Operators can lower the limit with the new `CROWI_UPLOAD_MAX_BYTES` environment variable (a value above 50 MB is clamped to 50 MB, since the limit is also the per-upload memory budget); see the environment variables table in the configuration docs. `GET /attachments/upload-policy` now reports this single limit as `maxBytes.attachment` (the separate `paste`/`dnd` figures are gone), and the editor upload request no longer sends an `intent` field — the web drag-and-drop handler now reads its size ceiling from this policy response instead of a hard-coded constant. If a reverse proxy sits in front of crowi and rejects an upload with its own (smaller) body-size limit before the request reaches the api, the web editor and the `crowi attach add` CLI command now recognize that the rejection didn't come from crowi itself and tell the user to check the proxy configuration instead of reporting crowi's own limit; the deployment docs gained a section on setting the proxy's body-size limit (nginx defaults to 1 MB) to a margin above crowi's own limit, since an exact match can still reject a request crowi would have accepted.

### Patch Changes

- Updated dependencies [cb0608a]
- Updated dependencies [8e881d0]
- Updated dependencies [5096980]
  - @crowi/api-contract@2.0.0-alpha.14

## 2.0.0-alpha.13

### Major Changes

- 0b2656a: BREAKING: `GET /admin/plugins/readiness`'s response shape changes from a plugin-only `{ name, adminPlacement, fields }` issue to a generic `{ id, source: 'plugin' | 'core', label, href, fields }` issue, so this admin-only endpoint's existing contract is not backward compatible for any client parsing the old field names. There is no server-side alias for the old shape. The endpoint path, auth (admin-only JWT), and the underlying "unset field" semantics are unchanged; `@crowi/web`'s own consumer of this endpoint is updated in the same release.

  Admin readiness now also covers core mail configuration, and test-send errors no longer leak internal details to the browser.

  - The `mail:from` sender address (a core setting, not a plugin one) now participates in the same admin readiness check that already covered storage/search plugin config: when it's unset, admins see it in the shared readiness banner (on every wiki page and `/admin/plugins`) with a link straight to `/admin/mail`.
  - `@crowi/plugin-mail-smtp` (`host`) and `@crowi/plugin-mail-resend` (`apiKey`) now declare `readiness` too, so an incomplete SMTP or Resend setup is caught the same way S3/Elasticsearch/OpenSearch already are. AWS SES intentionally declares none — its credentials fall back to the AWS SDK default credential chain, which is a legitimate empty configuration.
  - `mail:from` and the active mail driver's required fields are independent issues — either one being unset keeps mail flagged as not ready.
  - A test-send failure caused by an unset `mail:from` now returns a dedicated `MAIL_FROM_NOT_CONFIGURED` error with a localized explanation and a link back to mail settings, instead of a generic failure. Any other sender/transport failure (e.g. a connection error or bad credentials) is logged on the server only — the browser only ever sees a safe, localized generic message, never the raw exception text.

### Minor Changes

- 9a06104: Add sign-in with Google, as a plugin (RFC-0014). Enable `@crowi/plugin-google` in your runner project, paste a Client ID and secret into the admin plugin screen, and a "Sign in with Google" button appears on the sign-in page without a restart. A first-time federated sign-in picks a username before an account is created, and then follows the instance's registration mode — active immediately when registration is Open, queued for administrator approval when Restricted, refused when Closed. Signed-in users can connect and disconnect providers from Settings, and an unlink is refused when it would leave the account with no way to sign back in. Google gets no special treatment in core: the whole flow (provider list / start / callback / handoff, signed state cookies, PKCE, OIDC verification) is generic, backed by a new auth-driver plugin SDK and a `UserIdentity` linking model, so any other OIDC provider can be added the same way. An email address is honoured only when the provider asserts it is verified, and one that matches an existing local account is never auto-linked — that sign-in is refused, and linking has to be done deliberately from Settings. Requires `AUTH_PUBLIC_WEB_URL` (or `CLIENT_URL`) to be set; see the "Signing in with an external account" operations guide for setup.

### Patch Changes

- 3545265: Backfill an upload's MIME type from its filename extension when the client didn't declare one (or explicitly declared `application/octet-stream`). MCP, curl, and other third-party scripts routinely skip the multipart `Content-Type`, which used to store — and later serve — a file like an uploaded `pixel.png` as a generic download instead of an inline image. `POST /api/pages/:pageId/attachments` and both `paste`/`dnd` intents of `POST /api/attachments/upload` now resolve the same effective MIME, so `attachment.fileFormat` / `mimeType` reflect the actual file type in this case. A client-declared MIME other than `application/octet-stream` is always kept as-is, even if it contradicts the filename's extension, and an unknown or absent extension still falls back to `application/octet-stream` as before. Delivery-side behavior — the `INLINE_SAFE_MIME` allow-list, `Content-Security-Policy: sandbox`, and `X-Content-Type-Options: nosniff` that keep attachment delivery safe from stored XSS — is unchanged.
- f855266: `crowi attach download <id>` downloads one attachment — to a file with `-o`, or to stdout so it can be piped. `crowi attach list` now prints the attachment id at the start of each row, which is what the new command takes. It is served by a new `GET /api/attachments/{id}/download`, a strict counterpart to the delivery routes an embedded `<img>` uses: those answer a missing attachment with the placeholder image and a `200`, which a client extracting bytes cannot tell apart from the real file, whereas this route returns `404` for both a missing record (`ATTACHMENT_NOT_FOUND`) and a missing stored object (`FILE_MISSING`). The CLI also validates the response before writing anything, and removes a partial file if the transfer is cut short, so a saved file is always the whole attachment.
- 0b62bc0: An account with one or more linked federated identities (Google, or any other configured provider — RFC-0014) can no longer move its own email address through `PUT /me`. The address on a federated account was verified by the identity provider at sign-in; letting the holder of a stolen `profile:write` credential (a leaked personal access token or OAuth grant) redirect the confirmation link to an address they control would hand the account's recovery identifier away. A request that submits a different email now fails with `400 EMAIL_LOCKED_BY_FEDERATED_IDENTITY` and applies nothing from that request — name and language changes sent in the same request are not saved either, so the outcome is all-or-nothing. Resubmitting the current, unchanged address still saves name/language normally, and accounts with no linked identity are completely unaffected — the confirm-by-email flow behaves exactly as before.

  The profile response (`GET /me` and `PUT /me`) now carries a `federated` boolean. The Profile tab uses it to disable the email field and show a note pointing to the Security tab, where the linked account can be reviewed or unlinked; this is a UX aid only; the server-side rule above is what actually enforces the lock.

- 80c29e3: Add the durable data model, page-local ordering, and repair machinery for page history (RFC-0021), Phase 1 of the rollout. This adds new `PageHistoryEvent` and `PageHistoryOperation` collections, additive `historySequence` / `historyTracking` / `pendingHistoryEntry` fields on `Page`, and additive `historySequence` / `historyOperationId` fields on `Revision`, plus an idempotent materializer and repair job for the new outbox. No writer produces a `PageHistoryEvent` yet and no HTTP route changes — every existing page keeps recording history exactly as it does today; only newly created pages are marked ready for the writers that later phases will add. Comment creation now re-validates the owning page immediately after insert and removes the comment if the page was trashed or renamed in the meantime, closing a narrow authorize-then-insert race. Adds `crowi-admin page-history repair` (`--outbox` / `--scan`), the operator entry point for draining a crashed writer's leftover outbox entry and, on request, assigning sequences to unsequenced Revisions on already-ready Pages.
- Updated dependencies [9a06104]
- Updated dependencies [0b2656a]
- Updated dependencies [0b62bc0]
  - @crowi/api-contract@2.0.0-alpha.13
  - @crowi/plugin-api@1.0.0-alpha.7

## 2.0.0-alpha.12

### Major Changes

- 5d5fa9a: Close the auth cookie-fallback gap RFC-0019 §7.5 flagged and scope `/mcp` to Personal Access Tokens only, so a JSON-RPC API and non-attachment routes can no longer be reached with just an ambient browser cookie.

  BREAKING (`@crowi/api`): `createJwtAuth`'s cookie fallback (the `crowi.accessToken` cookie, previously accepted whenever the `Authorization` header was missing OR unparseable) is now header-only for every consumer except attachment delivery — admin, `/pages/*`, `/auth/me`, `/auth/logout`, the protected `/oauth/*` routes, `/search`, and every plugin route registered with the default `auth: 'user'` tier. A request that used to succeed via a stray or forged `crowi.accessToken` cookie with no (or a malformed) `Authorization` header now gets a `401 AUTHENTICATION_REQUIRED`; a normal browser session, which always sends the header from `localStorage`, is unaffected.

  BREAKING (`@crowi/api`): the `crowi.accessToken` cookie fallback is now accepted ONLY on `GET`/`HEAD` for the three headerless attachment delivery routes — `/attachments/:id`, `/attachments/:id/original`, and `/attachments/by-key/*` (plus the `/files/:id` redirect target) — matching exactly the `<img src>` / direct-navigation shape the cookie exists for. Every other attachment route (upload, meta, delete, add) now requires the header.

  BREAKING (`@crowi/api`): `/mcp` is now Personal Access Token (PAT) only. A web-session Bearer token, the `crowi.accessToken` cookie, and an OAuth access token (`oauth_access`) are all rejected with a JSON-RPC `401` — MCP previously rode the same shared auth as the rest of the API and accepted any of those. This is a deliberate defense-in-depth narrowing ahead of RFC-0022's resource/audience-bound OAuth support; once that lands, a properly scoped `oauth_access` token will be accepted again.

  `@crowi/web`'s `apiFetch`, `useAddAttachment`, the editor's paste/drag-and-drop upload, and the admin plugin-action button no longer send a request with no `Authorization` header when the access token is missing — they recover it through the existing refresh flow first, and fail closed (the existing session-expired handling) instead of depending on the ambient cookie a normal page load already sends.

### Minor Changes

- c5f243a: Admins now see a non-blocking warning banner (on every wiki page and in `/admin/plugins`) when the currently selected storage or search driver is missing configuration it needs to actually work — such as the S3 bucket name, or the Elasticsearch/OpenSearch cluster URL — so misconfiguration is caught before it causes an upload or search failure instead of only surfacing as a 500 later.

  - New `CrowiPlugin.readiness` SDK declaration lets a plugin state which of its own config fields must be set once a specific driver is selected; `@crowi/plugin-storage-aws-s3` (`bucket`), `@crowi/plugin-search-elasticsearch`, and `@crowi/plugin-search-opensearch` (`url`) declare it.
  - New admin-only `GET /admin/plugins/readiness` endpoint reports only the plugin name, its admin placement, and the unset field names — never the actual config value, URL, or any secret.
  - The wiki header and the `/admin/plugins` list link straight to the affected plugin's config screen; saving the missing field clears the warning on the next refetch.
  - Non-admins never see the banner and never trigger the readiness request.

### Patch Changes

- 30cb12a: Fix a page's comment count showing a stale value after comments are posted or deleted at nearly the same time. The count was recomputed by reading the current number of comments and then writing it, with no ordering between two recomputations for the same page — so a slower one could overwrite a newer, correct value with the number it had read earlier. The wrong count then stuck until the next comment was added or removed on that page. Recomputations for the same page are now serialized, so the last one always writes the true count. (Recomputations still run per API process, so a deployment running several API replicas can in principle still interleave; the count self-corrects on the next comment change.)
- 77f014e: Stop a draft page's contents from being readable by other users. A draft is stored with a public grant and is meant to be kept private by a separate "only the author sees it" rule, but the revision endpoints and the comment endpoints checked only the grant — so another signed-in user who had a revision or page id could read an unpublished body, list its comments, and delete them. All three now apply the author rule and answer "not found", so a draft's existence is not disclosed either.
- d4342cd: Requesting an email address change now cancels any earlier change still awaiting confirmation, and a confirmation link no longer works while the account is suspended. Previously the only way a pending change stopped being confirmable was the address actually changing or the requesting session being revoked — so a change requested from a stolen session could not be called off by asking for a different address, and suspending an account did not stop a link issued beforehand from moving the address that account recovers through.
- 1346e2a: Fix a crash where a Redis restart or brief network blip could bring down the entire api process instead of just degrading presence or notifications for a moment. The dedicated pub/sub subscriber clients used by page presence and realtime notifications are duplicated off the primary Redis connection, and node-redis does not carry event listeners over to a duplicate — a subscriber that lost its connection after it was already up had no `error` listener, and an unhandled Redis client error is fatal to the whole Node process. Every duplicate subscriber now gets an `error`/`ready` listener attached immediately, so a Redis outage logs one warning and a recovery line instead of crashing the api. Once node-redis reconnects, presence's single fixed feed subscription is automatically restored (node-redis native resubscribe); notifications' per-user subscriptions restore the same way for whichever channels were subscribed at the moment of the outage — a channel whose subscribe/unsubscribe request was still in flight when the outage hit is not covered by this fix.
- 8b42663: Security dependency updates. `hono` moves to `4.13.0` (the declared floor is now `^4.12.34`, the first release without GHSA-advisory-affected versions) — for `@crowi/plugin-api` this also raises its `hono` peer range, so a plugin pinning an older 4.12.x will need to move up. Transitively, `undici` 7.x reaches `7.29.0` and `ip-address` reaches `10.4.0`, both within their existing parents' ranges. No `pnpm.overrides` entries were needed for any of these.
- b43b6ef: Further security dependency updates, following a second batch of advisories issued against packages fixed hours earlier: `brace-expansion` moves to `1.1.18` / `2.1.4` (the earlier `1.1.17` / `2.1.3` fix was incomplete upstream), `postcss` to `8.5.23`, and `fast-uri` to `3.1.5`.
- f6a3ffe: Enforce a single, shared username validation contract across self-registration, invite acceptance, and first-admin (installer) creation.

  Username input is now restricted to ASCII letters, digits, `_`, and `-`, 1-64 characters, matching what the `@mention` renderer already recognizes. Previously each of the three account-creation forms validated username with a different (and looser) rule, and the `User` model itself did not validate the field at all — so an empty, whitespace-only, or otherwise malformed username could reach the database and break the `/user/<username>` page namespace. Non-conforming values are now rejected with the existing `400 VALIDATION_ERROR` response before any account is created or activated. Installer account creation, which previously also allowed `.` in usernames, now uses the same rule as the other two forms. Existing usernames already stored in the database are left untouched — this only applies to new or changed usernames.

- Updated dependencies [d4342cd]
- Updated dependencies [c5f243a]
- Updated dependencies [8b42663]
- Updated dependencies [f6a3ffe]
  - @crowi/api-contract@2.0.0-alpha.12
  - @crowi/plugin-api@1.0.0-alpha.6

## 2.0.0-alpha.11

### Major Changes

- ce69b4a: BREAKING: the public API namespace moves from `/api/v2` to `/api`. `v2` never
  carried real version-negotiation meaning (contracts are root-relative, the
  segment was stripped verbatim at the listener boundary), and Crowi 2.0 has no
  production deployments and no parallel API generations left to protect — see
  `docs/rfcs/0006-hono-integration.md` for the framework migration that made the
  old `/api/v2/*` HTTP shape a fixed point in the first place. There is no
  server-side alias or redirect for `/api/v2/*`: after upgrading, every request
  to the old prefix returns a plain 404.

  **MCP clients** (Claude Desktop, Codex CLI, or any other client with a Crowi
  MCP server URL configured directly — including anyone who followed the
  "MCP setup" card on the user settings page before this release) must update
  the endpoint from `<host>/api/v2/mcp` to `<host>/api/mcp`. Existing PAT /
  OAuth credentials are unaffected — only the connection URL changes.

  **`@crowi/cli` users** must upgrade to this release (or later) in the same
  deploy as the api. An un-upgraded CLI will 404 against the new listener; on
  `crowi logout`, the CLI now also warns (rather than silently succeeding) when
  the cached OAuth revoke endpoint returns a non-2xx status, since local
  credentials are removed regardless — re-run `crowi login` or ask an
  administrator to revoke the stale token server-side.

  **Operators running multiple api replicas** must treat this as a coordinated
  fleet cutover, not a normal one-at-a-time rolling restart: the old and new
  listeners cannot interpret each other's prefix, so any deploy topology that
  lets old and new api replicas serve traffic at the same time causes 404s for
  whichever client hits the "wrong" generation. Stop all api replicas and start
  them back up together on the new version (or cut a blue/green fleet over as a
  single step), and use the preflight check (`GET /api/openapi.json` returns
  200, `GET /api/v2/openapi.json` returns 404 on every replica before accepting
  traffic) documented in the new "api prefix cutover" section of
  `operations/self-hosting`. Single-instance deployments (including local dev)
  are unaffected by this requirement — there is only one replica, so old/new
  never coexist.

  Everything else about the HTTP surface is unchanged: route paths, request/
  response shapes, auth, and scopes are identical under the new prefix. Browser
  users see no visible change (the web app talks in same-origin relative paths
  and picks up the new base URL on next build), except that a tab left open
  since before the cutover will 404 on API calls until reloaded. Attachment /
  avatar URLs already embedded in page bodies keep resolving via permanent
  canonicalization on both the server (attachment lookup) and the web client
  (display-time URL rewrite) — no database migration is required or performed.

### Minor Changes

- 8ca7a9b: Unify the attachment upload allow-list across every upload path — the "Attach file" button, the editor's paste, and its drag-and-drop — so the same file always gets the same result. Previously the general page-attachment route had no MIME check at all while drag-and-drop enforced a narrow images-plus-a-few-documents list, which is why the same file (e.g. an HTML export) could upload from the button but be rejected by drag-and-drop. Common office documents (`.doc`/`.docx`, `.xls`/`.xlsx`, `.ppt`/`.pptx`) and a broader set of text/archive/audio/video types are now accepted everywhere; opening them directly still downloads them rather than rendering inline (unchanged, security-relevant delivery behavior). Pasting into the editor uploads non-image files too (it used to only react to images, leaving a pasted document unhandled), inserting them as a `[filename](url)` link just like drag-and-drop does. Rejected uploads now return the same error message no matter which route rejected them. The attachment grid also shows a file-type-specific icon for Word/PowerPoint documents (previously the generic file icon), falling back to the generic icon for any unrecognised type.
- 4736e06: `GET /user/{username}` now returns `likesCount` and `commentsCount` alongside the existing `createdPagesCount` / `bookmarksCount` — the number of pages the target user has liked and the number of comments they have written, computed via `countDocuments` on the indexed `Page.liker` / `Comment.creator` fields. These are the target user's own actions, not activity their pages received from others, and are not re-filtered by the viewer's grants.

  `GET /pages/list` now returns a top-level `total`: the exact, viewer-visible count of the full (unpaginated) listing, computed with the same match conditions as the page rows themselves and shared across every branch (root, path prefix, `user=`, `/trash`/`include_deleted`). `total` excludes whatever `portalPage` / `contentPage` already excludes from `pages`, so the two never disagree, and stays constant across `offset`/`limit`. `PagerSchema` is unchanged — `total` is a new sibling field, mirroring `ListUsersResponseSchema.total`.

- 7a7394f: Make `renderedAst` a client-agnostic typed contract (RFC-0023). Renderer producers (shiki, KaTeX, Mermaid, PlantUML, link cards, placeholders) now stamp typed sidecar data onto the byte-identical `html` nodes they already emit, and clients that declare `X-Crowi-Ast-Version: 1` receive a validated `{astVersion, root}` envelope in which those nodes are projected into typed nodes (`code` with themed tokens, `math`/`inlineMath` with TeX source, `crowiDiagram` with intrinsic dimensions, `crowiLinkCard`, `crowiPlaceholder`) — the foundation for native (non-HTML) rendering such as the iOS app. Requests without the header — including the web, permanently — keep receiving the stored bare mdast Root verbatim, so existing clients and open tabs are unaffected. Responses now also carry `renderedAstArtifactKey`, which fixes a web bug where a pending diagram that finished rendering (or a freshness-mismatch recompute) was not re-drawn on refetch because the render memo only keyed on the revision id. Operators: this release bumps the renderer pipeline to 1.0.0 and removes the missing-version freshness special case — run the new `crowi-admin rebuild rendered-ast` (real writes) immediately after deploying, and use `--dry-run` only before that; see the admin guide's "rebuild rendered-ast" section for the rollout and completion procedure.

### Patch Changes

- c2d0e9c: Fix a crash where uploading an attachment or profile picture could bring down the entire api process instead of just failing that one request. The bug triggered whenever the active storage driver rejected the upload before consuming the file stream (for example, an S3 storage backend with no bucket configured) — the abandoned stream's later internal error had no listener attached, and an unhandled stream error is fatal to the whole Node process. Uploads now always attach an error handler and release the stream up front, so a misconfigured or failing storage driver produces a normal failed-upload response instead of an outage.
- 7688188: `@crowi/plugin-api` now re-exports `sanitizeSvg` and `extractSvgDimensions`, so a plugin that needs SVG sanitization gets it from the SDK rather than from a package of its own. This also fixes a release-blocking defect: `@crowi/api` had picked up a runtime dependency on the private, never-published `@crowi/svg-sanitize`, which would have published an `@crowi/api` whose declared dependency does not exist on npm — core builds with `tsc` and cannot inline a workspace package itself, so it now takes the sanitizer from the SDK too. The SDK is the single place the private package is inlined, which also means a sanitizer change no longer obliges re-publishing every renderer plugin. `@xmldom/xmldom` becomes a declared dependency of `@crowi/plugin-api` (it is deliberately not inlined, so operators can still address a CVE in it through their own lockfile).
- Updated dependencies [ce69b4a]
- Updated dependencies [4736e06]
- Updated dependencies [7a7394f]
- Updated dependencies [7688188]
  - @crowi/api-contract@2.0.0-alpha.11
  - @crowi/plugin-api@1.0.0-alpha.5

## 2.0.0-alpha.10

### Minor Changes

- 02d8118: A Markdown link whose destination is a raw, unescaped absolute path containing a space — e.g. `[label](/absolute path with spaces)`, which CommonMark's standard link-destination grammar rejects and previously left as literal text — is now leniently recovered into a clickable internal link to the actual page, and its Backlinks entry is created the same way. This is an intentional, narrow deviation from CommonMark: image syntax (`![alt](/a b)`), an escaped form (`\[label\](/a b)`), a raw-space token inside a code fence or inline code, and a raw-space fragment already nested inside another link's label are all left untouched as literal text. Recommended notations for linking to a space-containing page path (`%20`, `+`, or `<...>`) are unaffected and remain the more CommonMark-portable choice.

### Patch Changes

- 094e01b: Close three ways an account could be taken over without knowing its password: an account-activation link no longer signs anyone in once the account is already active (previously a second click on a 24-hour-old link handed out a full session), a password-reset link now works exactly once instead of staying usable for its whole hour, and both changing and resetting your password now sign out every other session — so if someone was already logged in as you, they are kicked out. Two consequences when you upgrade: everyone is signed out once and has to log in again (sessions issued by the previous version cannot be checked against the new revocation rule, so they are refused rather than trusted), and any password-reset emails sent before the upgrade stop working — recipients who still need one can simply request a new link, and since reset links only live an hour this affects at most the last hour of mail. Personal access tokens and OAuth-connected apps keep working throughout, including across a password change; revoke those from their own settings pages when you need to.
- 5cb7fe7: Close a way an attacker could undo an account recovery. A pending email-address change was confirmed purely on a link, so someone who requested a change to their own address while holding a stolen session could still complete it after an administrator reset the password — taking over the account's recovery address at the moment the administrator believed the problem was handled. Confirming an address change now requires the session that requested it to still be valid, so any action that signs the account out (an administrator reset, or the owner changing their own password) also cancels a change that is still pending. If your own change is cancelled this way, just request it again.
- 0af3af0: `POST /pages` now rejects a `path` containing a literal `+` with `400 PAGE_INVALID_NAME`, matching the existing draft-creation and rename checks — previously this one creation path let through a page whose path became unreachable by URL for anyone but its creator (Crowi's URL convention always reads `+` as a space). Angle-bracket links (`[label](</foo bar#frag>)`) now correctly strip a trailing `#fragment`/`?query` before backlink lookup, so their Backlinks panel entry matches the real page instead of silently failing to find one. A single malformed percent-encoded link (e.g. `/a%`) in a page's body no longer wipes out that page's other, well-formed backlinks — link extraction is now hardened per-link and runs before existing backlinks are removed.
- 8a5433c: Fix four presence (live "who's viewing this page") consistency bugs.

  Viewer membership is now refcounted per WebSocket connection instead of per user, so closing one tab of a multi-tab/multi-replica session no longer makes the user vanish from the viewer list while a sibling tab is still open — only the last connection leaving actually removes them. Viewer-list broadcasts now carry a monotonically increasing per-page generation number (a backward-compatible additive field on the `viewers` WebSocket message) so an old, out-of-order snapshot can never overwrite a newer one on the client. Navigating between pages no longer flashes the previous page's viewer list (including their identities) on the next page's first render. Finally, when the server fails to register a viewer (e.g. a transient Redis error) it now closes the WebSocket so the client's existing reconnect logic recovers, instead of leaving the connection open with a permanently stale viewer list.

- 64df02e: Fix a stored cross-site-scripting hole in attachment delivery. An attachment's content type was taken from the uploading client's own declaration and echoed back with `Content-Disposition: inline`, so a user with edit rights could upload an HTML file and have it execute on the wiki's origin when someone opened its link, exposing that visitor's session token. Attachment delivery now pins the outgoing content type to an allowlist of types that render safely, serves anything else as a download, sends `Content-Security-Policy: sandbox` with inline responses so an embedded document can neither run scripts nor reach the wiki's origin, and sets `X-Content-Type-Options: nosniff` on every API response. The check runs at delivery time, so attachments already stored with a hostile content type are covered too. Images, PDFs and text attachments — including SVG images embedded in pages — keep displaying as before.
- 1a64d47: Harden the password-reset paths against sessions and links that outlive the reset. An administrator resetting someone's password from the admin screen now also signs that account out of every existing login session and invalidates any password-reset link still in flight for it, so the action taken in response to a suspected account takeover actually evicts the intruder (personal access tokens and OAuth-connected apps are unaffected, as with a self-service password change). In addition, a password-reset link now stops working if the account's email address changed after the link was sent — whoever still controls the old mailbox can no longer set the password of an account that has moved on; request a fresh link instead.
- Updated dependencies [8a5433c]
  - @crowi/api-contract@2.0.0-alpha.10

## 2.0.0-alpha.9

### Minor Changes

- a687b18: Scope every Redis key and pub/sub channel to the Crowi instance so multiple instances can safely share one Redis (Upstash, ElastiCache, a single VPS, etc.) without cross-talk.

  Every Redis-backed consumer — collab pub/sub, the editor-cap counter, presence, notification invalidation, Config sync, rate limiting, and LRU (recently-viewed pages) — now builds its keys and channels through a shared `crowi:<instance-slug>:...` namespace instead of a bare `crowi:...` shape that collided across instances (most visibly, the presence feed channel was previously global, so instance A's viewer/editing updates leaked into instance B's WebSocket clients on a shared Redis).

  The instance slug defaults to the hostname of `CLIENT_URL`, so replicas of the same public site automatically share a namespace while distinct sites get distinct ones with no extra configuration. Set the new `REDIS_KEY_PREFIX` env var to override it explicitly (required whenever `REDIS_URL` is set and no valid `CLIENT_URL` is configured — booting without a resolvable slug now aborts instead of silently defaulting).

  `REDIS_URL`'s database-number path segment (e.g. `redis://host:6379/1`) is also now respected by both the node-redis and ioredis clients, which previously silently ignored it and always connected to DB 0. This is a secondary, purely numeric isolation axis — Redis pub/sub is not scoped to a DB, so `REDIS_KEY_PREFIX` (not the DB number) is what actually isolates instances sharing one Redis.

### Patch Changes

- @crowi/api-contract@2.0.0-alpha.9

## 2.0.0-alpha.8

### Minor Changes

- df1ce77: Give renderer plugins a first-class way to show a working fallback UI on render failure, and make the plugin-render cache keep the last-good output on screen through a transient failure.

  `@crowi/plugin-api`'s `RenderResult` gains an optional `errorHtml` field, paired with `error`: when set, `@crowi/api` shows `errorHtml` instead of the generic link-less placeholder, and a new `RenderError.code: 'blocked'` covers policy-level permanent rejections (SSRF block, disallowed scheme, disallowed content-type) with the same 1h TTL as `not_found`. `@crowi/api`'s plugin-render cache also adds a stale-if-error policy: when a previously-successful embed or code-block render's background/blocking revalidation fails, the last-good output stays on screen (retried at the failure's own TTL cadence) for up to 24h before degrading to `errorHtml` or the placeholder — this applies uniformly to every renderer plugin, not just link cards, so e.g. a PlantUML diagram no longer drops to a placeholder while the PlantUML server briefly restarts.

  Crowi's `@[card](url)` link-card embed (originally shipped as the separate `@crowi/plugin-renderer-link-card` plugin, since folded directly into `@crowi/api` core — see the emoji/link-card core-absorption changeset) migrates its failure path onto this real contract instead of disguising every OGP-fetch failure as a successful render with a plugin-local shortened TTL: per-failure-class TTL (persistent 1h for blocked/not-found sources, transient 5min for network/timeout, `Retry-After`-aware rate-limit handling) is now expressed through the shared `error` + `errorHtml` mechanism, so admin telemetry sees the real failure instead of a fake success. The `errorHtml` a link-card render shows today is the unified fallback card described in the emoji/link-card core-absorption changeset — a plain link to the original URL with no error-red styling, not a dedicated error card.

- 708c0d5: Add `@[card](url)` link-card embeds with editor affordance.

  New core `@[card](url)` embed tag (`registry.addEmbedTag(name, renderer)` embed-tag registration seam, RFC-0002; a later release folded the original `@crowi/plugin-renderer-link-card` plugin implementation directly into `@crowi/api` as a core-reserved embed tag and removed the plugin package, see the emoji/link-card core-absorption changeset). Writing `@[card](url)` fetches the target page's OGP meta tags (`og:title` / `og:description` / `og:image` / `og:site_name`) and renders a title / description / domain / image preview card. A page with no `og:image` renders as a text-only card; a fetch failure (timeout, non-2xx, blocked, bad scheme, oversized response) degrades to the unified fallback card (see the emoji/link-card core-absorption changeset) — a plain link to the original URL, with no OGP fields and no error-red styling. The fetch is SSRF-guarded (rejects private / loopback / link-local / unique-local / metadata addresses, whether specified directly, via DNS resolution, or via a redirect target — each of up to 3 manual redirect hops is re-validated), time-capped at 5s, size-capped at 512KB, and concurrency-capped at 5 simultaneous fetches. `og:image` is always linked directly to the source site (no proxying or caching).

  The web editor gains a hover/focus affordance that converts a bare `http(s)://` URL to `@[card](url)` and back, leaving an already-labelled `[label](url)` link untouched.

- d680c0c: Add server-side Mermaid diagram rendering (RFC-0002 Phase 6.1).

  New `@crowi/plugin-renderer-mermaid` plugin: ` ```mermaid ` fenced code blocks are rendered entirely server-side in an isolated, network-denied child process (no client-side Mermaid JS ever ships to the browser) and embedded as a sanitized, base64-encoded SVG `<img>`. Supports flowchart, sequence, class, state, ER, journey, pie, and git-graph diagrams, with a shared, independently-tested DOM-based SVG sanitizer (new, private `@crowi/svg-sanitize` package) that also replaces `@crowi/plugin-renderer-plantuml`'s previous regex-only sanitizer. No operator configuration is required, and existing pages keep rendering their `mermaid` fences as plain code blocks until the author explicitly re-saves them.

  The editor's live preview now renders Mermaid diagrams as you type, not just after saving: a new `previewPolicy` opt-in on `CodeBlockRenderer` lets a renderer participate in non-persistent preview rendering (page-less, no cache writes), gated by the same per-user admission-control concurrency limits and priority scheduling used for saved-page rendering, plus a per-user rate limit on the preview endpoint and proper request cancellation when a newer keystroke supersedes an in-flight preview.

  The page-view diagram wrapper (click-to-enlarge, cap-to-width, dark-mode-neutral surface) is generalized from PlantUML-only to any diagram renderer, so Mermaid diagrams get the same affordance PlantUML diagrams already had.

- 09d7b9c: Redis 8.x is now the reference version Crowi tests and supports (previously Redis 7.x). `docker-compose.yml`'s `redis` service moved off the moving `redis:7` tag to a reviewed, digest-pinned Redis 8.x patch tag, and CI now runs the same pinned tag as a service in the `test` and `flake-report` jobs, plus a dedicated `crowi-test-redis` instance so a Config pub/sub smoke test can safely publish to the fixed, global `'config'` channel without waking up any other process sharing the Redis instance. A TLS-only fixture (`crowi-test-redis-tls` locally, an equivalent post-checkout `docker run` step in CI) reuses the existing self-signed test certs to exercise `rediss://` connectivity.

  This is a documentation/test-support policy change only: no code rejects Redis 7.x connections, and existing self-hosted Redis 7 deployments keep working unchanged. CI and `docker compose up -d` now exercise exactly one pinned Redis 8.x patch tag — this is not a claim that every version in the `>=8.0 <9` range has been individually verified.

- a32204f: Absorb the emoji shortcode transform and the `@[card](url)` link-card embed directly into `@crowi/api` core — both are now always-on Markdown features and no longer need to be installed as separate renderer plugins. The `@crowi/plugin-renderer-emoji` and `@crowi/plugin-renderer-link-card` packages have been removed from the workspace entirely; they are no longer published.

  Link-card OGP fetching is controlled by a new admin Security setting, "Allow link cards for external URLs" (default ON, matching the previous plugin-installed behaviour and GitHub/Slack/Notion-style link unfurling). Disabling it stops all new outbound OGP requests immediately — including bypassing the render cache entirely, so a card fetched while enabled is never served stale after a disable, and a disable never leaves a cached fallback behind after a re-enable — and every render that cannot show a real preview (a disabled toggle, a fetch failure, a blocked/air-gapped host) now shows the exact same non-error-styled fallback card (a plain link to the original URL) instead of the old dedicated error-card variant.

  Operators upgrading with `@crowi/plugin-renderer-emoji` or `@crowi/plugin-renderer-link-card` still listed in `crowi.config.json` (or their npm packages still listed as a runner dependency) see a one-time boot warning instead of a hard failure — remove the two entries (and the matching `dependencies`) once convenient; they no longer do anything, and the packages no longer exist to install.

  `@crowi/plugin-api`'s `EmbedRenderer` gains an optional `shouldBypassCache(input)` hook — a renderer whose output depends on a runtime policy toggle (like link-card's) can use it to skip the render cache entirely for a given dispatch instead of only checking the toggle inside `render()`, which would otherwise let a stale cache hit serve pre-toggle output.

- 3b27a67: Add a "Subpages" tab to the user page.

  `/user/<username>` now has a third footer tab, "Subpages", listing every page that actually exists under `/user/<username>/` (recursively, across all depths), regardless of who created it — distinct from the existing "Pages" tab, which lists pages this user created regardless of path. The preview shows up to 10 rows plus the total count, with a "View all" link to `/user/<username>/pages` for the full, paginated listing (30 per page). Visibility follows the same grant/status rules as every other page listing.

  Also hardens draft creation (`POST /pages/drafts`): if the seed revision fails to save after the draft `Page` document was created, the orphaned `Page` is now compensating-deleted so it can no longer resurface as a permanently broken row in listings such as the new Subpages tab.

### Patch Changes

- abe7ca5: Bump the transitive `body-parser` dependency to close a DoS advisory (silently disabled size-limit enforcement on an invalid `limit` value).
- 04cbd85: Bump the transitive `brace-expansion` dependency to close a ReDoS vulnerability (GHSA-3jxr-9vmj-r5cp / CVE-2026-13149).
- a899fdd: Fix a correctness hole where a live collaborative editor open before a page was renamed, soft-deleted, or reverted could still save its content afterwards, silently clobbering the renamed/deleted state instead of being rejected.
  The fix introduces a monotonic collab lifecycle epoch (`Page.collabLifecycleVersion`) that advances atomically with every rename/delete/revert/body-replace and is enforced at four boundaries — wsToken mint, WebSocket authentication, document load, and the atomic save compare-and-set — so a stale editor session is refused rather than allowed to overwrite the page, including across multiple api replicas.
  Rename/delete now also opens the existing reload-prompt dialog on any live editor for that page, and soft/hard delete purge the page's collaborative editing state (Yjs snapshot and pending updates) as defense-in-depth.
- 9122c85: Stop the JWT auth middleware from masking infrastructure and handler errors as a spurious `401 AUTHENTICATION_REQUIRED`. `jwtAuth` previously wrapped the principal lookup (`User.findById`), scope application (a PAT's best-effort last-used write), and the downstream handler call in a `try/catch` that turned any thrown error into a 401. A transient database failure during authentication therefore reached the client as "authentication required" (prompting a pointless re-login) and disappeared from server error logs. Such throws now propagate to the app error handler and surface as `500 INTERNAL_ERROR`; genuine authentication failures (missing/invalid/expired token, unknown user, inactive account) still return `401`/`403` unchanged, and the boundary stays fail-closed (a throw short-circuits before the handler runs). The admin-route composition (`createJwtAdminRequired`) preserves its short-circuit forwarding.
- 05648c0: Bound the link-card OGP-fetch semaphore's wait queue to close a DoS where a page embedding `@[card]` links to many unique, slow/unresponsive hosts could pile up an unbounded number of unresolved fetches (crowi-review CROWI-REVIEW-002, high severity).

  The shared fetch semaphore (`FETCH_CONCURRENCY_LIMIT = 5`, unchanged) now caps its wait queue at a fixed length and gives queued requests a wait deadline distinct from the post-acquisition fetch timeout. A request that arrives once the queue is already full is rejected synchronously with a new `busy` outcome, never queuing another unresolved Promise; a request that was accepted into the queue but times out before a slot opens up is rejected the same way once its deadline elapses. `@crowi/plugin-api`'s `RenderError.code` union gains `'busy'`, mapped to the same unified link-card fallback card every other OGP-fetch failure uses (no new UI variant) and cached with a short transient TTL so a subsequent render retries once the queue drains.

- 0d21b52: Fixed a bug where the collaborative-editing Redis extension (`buildCollabRedisExtension`, only active when `REDIS_URL` is set) failed to load `ioredis` at runtime, because `ioredis` was never declared as a direct dependency of `@crowi/api` — it was only reachable through pnpm's isolated `node_modules` layout as a transitive dependency of `@hocuspocus/extension-redis`, which `require('ioredis')` from `@crowi/api`'s own source cannot resolve. This broke every multi-instance deployment with `REDIS_URL` configured: the process would throw `Cannot find module 'ioredis'` the first time a collaborative-editing WebSocket connection was authenticated. `ioredis` is now declared directly, matching the version already resolved elsewhere in the workspace. Discovered while adding real-Redis-8 smoke test coverage for this exact code path (feature-redis-8-upgrade Phase 2); unrelated to the Redis 7→8 version change itself.
- fee9c9a: Fix `rediss://` URLs silently connecting in plaintext: the Redis socket options passed a nested `tls: {...}` object, but node-redis v4 selects the TLS transport only on the literal `tls: true` with the TLS options flattened into the socket object — so TLS (and `REDIS_REJECT_UNAUTHORIZED`) was silently ignored. Also fix boot hanging forever when Redis is configured but unreachable: the initial boot connection is now bounded (~10 attempts) and degrades to "Continuing without Redis" as documented, config pub/sub setup skips connecting when the boot connection degraded, and the pub/sub clients gained error listeners so a steady-state Redis outage no longer crashes the process. Steady-state reconnect behaviour after an established connection is unchanged.
- 4ec60a6: Forward the ACL username from `REDIS_URL` (`redis://user:pass@host`): it was silently dropped, so the api's Redis clients authenticated as the `default` user while the realtime-collab path authenticated as the URL's ACL user. Both URL parsers also moved to the WHATWG URL API so percent-encoded credentials decode exactly once and passwords containing `:` or `@` keep their username/password boundary (the legacy parser pre-decoded the userinfo and could corrupt such credentials).
- 7e1c54e: Add an immutable `Revision.page` (`Page` ObjectId ref) alongside the existing `path` string, and switch revision/comment/attachment-usage/page-body history lookups (`GET /pages/revisions/:id`, `GET /pages/revisions?ids=...`, `GET /comments?revision_id=...`, `GET /pages/:pageId/attachments/usage`, `GET /pages?path=...&revision_id=...`, `POST /pages/revert-to-revision`) to resolve/verify the owning page by that immutable id instead of reverse-looking-up or comparing `path`. Fixes a latent grant leak where deleting a page and later reusing its `path` for an unrelated page could let that new page's grant expose the old page's private revision body / comments / attachment metadata, or let a caller with edit access to the new page revert it to the old page's private body. A boot migration backfills `page` onto existing revisions.
- cb3d16c: Fix an authorization bypass where PAT / OAuth token scope guards were silently skipped on every parameterized route (e.g. `GET /user/{username}`, `GET /user/{username}/pages`, `GET /user/{username}/bookmarks`). `applyScope` registered the guard on the OpenAPI path form (`{username}`), which Hono's router treats as a literal segment that never matches a real request, so the required-scope check never ran and a narrowly-scoped token could reach those handlers. It now attaches the guard on the route's Hono routing path (`:username`) — the same path the handler is registered on — so the scope check runs. Non-parameterized routes (e.g. `/me`) were unaffected.
- b0e2c76: Bump dependencies to clear Dependabot security advisories (alerts #622/#623/#626-#637).

  - `sharp` 0.34.5 → 0.35.3, direct in `@crowi/api` (GHSA sharp <0.35.0). Also
    overridden repo-wide (`sharp@<0.35.3` → `0.35.3`) since Next.js pins an
    optional `sharp: ^0.34.5` dependency of its own that a Next.js version bump
    can't escape.
  - `@hono/node-server` 2.0.3 → 2.0.11, direct in `@crowi/api` (GHSA-frvp-7c67-39w9
    path traversal / GHSA-9mqv-5hh9-4cgg WS handshake DoS). Also overridden
    (`@hono/node-server@<2.0.11` → `2.0.11`) for the transitive 1.19.14
    resolution pulled in by `@modelcontextprotocol/sdk`'s own `dependencies` —
    verified crowi never imports the SDK module that requires it
    (`@hono/mcp`'s `StreamableHTTPTransport` mounts into our own existing Hono
    app/server instead), so this resolution was unreachable dead code, but the
    override closes the alert cleanly regardless.
  - `hono` bumped to 4.12.31 (within the existing `^4.12.25` range) across
    `@crowi/api` / `@crowi/api-contract` / `@crowi/plugin-api` / `@crowi/plugin-slack`.
  - `js-yaml` overridden to `3.15.0` / `4.3.0` per major line
    (`js-yaml@>=3.0.0 <3.15.0` / `js-yaml@>=4.0.0 <4.3.0`) — covers every
    transitive consumer (jest/istanbul's 3.x chain, eslint 8/9, changesets,
    the mjml/htmlnano chain, fumadocs, `@redocly/openapi-core`) plus
    `@crowi/api-contract`'s own direct `js-yaml` dependency, bumped to `^4.3.0`.
  - `svgo` and `fast-uri` overridden to `4.0.2` / `3.1.4` — their parents
    (`htmlnano`, `ajv`) already declare wide-enough ranges to permit the
    patched versions but pnpm won't re-resolve a pure-transitive package
    within an already-satisfied range without a forcing mechanism.

  The sharp 0.35 bump changed its TypeScript declarations from the old
  namespace-merged `sharp.Sharp`/`sharp.Metadata`/`sharp.OutputInfo` pattern to
  named exports; `image-display-derivative.ts` updated its type imports
  accordingly (no behavior change). It also surfaced a latent bug in this
  package's own test fixture (an ancillary PNG chunk type `padA` with a
  lowercase reserved-bit byte, which is not PNG-spec-conformant — sharp 0.34's
  bundled `spng` PNG decoder tolerated it, 0.35's `libpng`-backed decoder
  correctly rejects it); the fixture was corrected to `paDA`, no production
  code changed.

- Updated dependencies [d9eb1c0]
- Updated dependencies [a899fdd]
- Updated dependencies [df1ce77]
- Updated dependencies [f1bcd2b]
- Updated dependencies [29b3679]
- Updated dependencies [05648c0]
- Updated dependencies [d680c0c]
- Updated dependencies [a32204f]
- Updated dependencies [b0e2c76]
- Updated dependencies [3b27a67]
  - @crowi/api-contract@2.0.0-alpha.8
  - @crowi/collab@0.1.0-alpha.3
  - @crowi/plugin-api@1.0.0-alpha.4
  - @crowi/runner@0.1.0-alpha.2

## 2.0.0-alpha.7

### Minor Changes

- d413c6d: Validate every Crowi-owned environment variable in a single pass at boot instead of the previous ad hoc mix of throw / warn / silent-fallback behavior scattered across the codebase.

  - `PORT`, `MONGO_URI` (or its legacy aliases), `REDIS_URL` (or its legacy aliases), and `CROWI_ENCRYPTION_KEY` now fail boot immediately with one error message listing every malformed variable, instead of surfacing a confusing low-level error later (a bad `PORT` used to only fail once `server.listen()` ran, a bad `MONGO_URI` only once the driver tried to connect).
  - `CLIENT_URL`, `CROWI_MULTI_INSTANCE`, `NODE_ENV`, `JWT_ACCESS_TOKEN_TTL_SECONDS`, `JWT_REFRESH_TOKEN_TTL_SECONDS`, `COLLAB_MAX_EDITORS_PER_PAGE`, and `MIGRATION_PREFLIGHT_UNAPPLIED_POLICY` now print a single consolidated boot-time warning when malformed, instead of silently falling back to a default or (for `CROWI_MULTI_INSTANCE`) being misinterpreted as truthy.
  - An environment variable that carries a known Crowi prefix (`CROWI_`, `WS_TOKEN_`, `JWT_`, `COLLAB_`, `REDIS*`, `MONGO*`, `MIGRATION_`) but matches no known variable name — a likely typo — is flagged in the same warning report.

  Well-formed configurations are unaffected; only malformed values that previously failed silently or late now surface at boot.

- 1625e85: Markdown images now support a Pandoc-style attribute block right after the image: `![alt](url){width=60% align=center}`. Supported keys are `width` / `height` (a number followed by `%` or `px`, within sane bounds) and `align` (`left`/`center`/`right`) / `float` (`left`/`right`, wins over `align` when both are set). A standalone image (nothing else in its paragraph) renders as a `<figure>` so `align`/`float` apply; an image followed by more text stays inline and only `width`/`height` apply. Any out-of-range or unrecognised value is simply dropped instead of breaking the page, and a plain `![alt](url)` with no attribute block renders exactly as before.

  The new server-side transform is bundled into the core renderer pipeline (`RENDERER_PIPELINE_VERSION` 0.7.0 → 0.8.0), and the web renderer re-validates every display attribute by value — not by trusting the `data-crowi-image-*` attribute names — so the same rules apply whether they came from the Markdown transform or were hand-written as raw HTML. The editor also gained a hover/focus tooltip on image spans for setting width/align/float without typing the `{...}` syntax by hand; it respects read-only mode (including the realtime-collab editor cap being reached mid-session). Uploading an attachment via paste/drag-and-drop/the insert button still emits a plain image with no attributes by default.

- 336eec1: Close two residual paths from the plugin SDK's trust boundary to core/other-plugin secrets, making the "a plugin cannot reach another plugin's or core's secrets through PluginContext" claim true rather than aspirational.

  BREAKING (`@crowi/plugin-api`): credential-vault core models (`Config`, `PersonalAccessToken`, `OAuthClient`, `OAuthAuthorizationCode`, `OAuthDeviceCode`, `OAuthRefreshToken`, `Share`, `ShareAccess`) can no longer be listed in `CrowiPlugin.modelAccess` at all — declaring one now fails boot with a descriptive error (`PluginManager.activate()`'s `assertValidModelAccess()`), and `ctx.model()` also refuses to return one at call time as defense-in-depth. Previously any plugin could declare `modelAccess: ['Config']` and read every core/plugin `@sensitive` value in decrypted form, or read/write `PersonalAccessToken` / OAuth token rows directly — there was no legitimate plugin use case for this, so no first-party plugin is affected.

  BREAKING (`@crowi/plugin-api`): `ctx.dependencyConfig(name)` now also requires the target plugin to opt in with a new `CrowiPlugin.exposesConfigToDependents?: boolean` field. Previously, listing a dependency in `requires` was sufficient to read its decrypted config (`@sensitive` fields included) — a plugin could self-declare `requires: ['@crowi/plugin-aws']` and read AWS credentials without `@crowi/plugin-aws`'s consent. `@crowi/plugin-aws` now declares `exposesConfigToDependents: true` (its whole purpose is sharing credentials with `@crowi/plugin-storage-aws-s3` / `@crowi/plugin-mail-aws-ses`), so that existing dependency chain keeps working unchanged; any other plugin that depended on this implicit access would need to add the flag.

  The `PluginContext` trust-boundary doc (`packages/plugin-api/src/context.ts`), `CrowiPlugin`'s TSDoc, and the plugins developing guide (ja/en) are updated to state the now-true claims, plus the one remaining honest caveat: `modelAccess: ['User']` still returns the raw document (password hash included) — field projection is deferred to a post-2.0 repository/HTTP layer separation.

- 8ff0e64: Narrow the plugin SDK's trust boundary: remove `ctx.crypto` and gate `ctx.model()` behind a declared allow-list.

  BREAKING (`@crowi/plugin-api`): `PluginContext.crypto` (and the `PluginCrypto` type) is removed. It exposed the same global `CROWI_ENCRYPTION_KEY`-derived encrypt/decrypt used for core's sensitive Config and every other plugin's `@sensitive` fields, so any installed plugin could decrypt any other plugin's or core's secrets. No first-party plugin used it — the legitimate way to read a plugin's own `@sensitive` config values is unchanged: `ctx.config<T>()` already returns them transparently decrypted.

  `ctx.model(name)` now requires the plugin to declare the model in a new `CrowiPlugin.modelAccess?: string[]` field (same shape as `requires`). Calling `ctx.model()` for an undeclared model throws `Plugin '<name>' called model('<requested>') but did not declare it in 'modelAccess'.` A model listed in `modelAccess` still gets full (unrestricted) read/write access — there is no read-only mode yet. `PluginManager.activate()` validates every declared model name against the registered core models at boot and fails loudly (isolating just that plugin, same as a bad `configSchema`) on an unknown name.

  `GET /admin/plugins` now includes each plugin's declared `modelAccess` in `PluginInfo`, so an admin can audit which plugins touch which core collections.

  The four first-party plugins that call `ctx.model()` (`@crowi/plugin-search-elasticsearch`, `@crowi/plugin-search-mongo`, `@crowi/plugin-search-opensearch`, `@crowi/plugin-slack`) now declare their actual (read-only) usage: `['Page', 'Bookmark', 'User']` for the ES/OpenSearch drivers, `['Page', 'Revision']` for the Mongo driver, `['Page']` for Slack.

- fa5023f: `GRANT_RESTRICTED` ("Anyone with the link") pages now actually work like a link-share invite. Opening a restricted page's id URL (`/<page._id>`, and the revived legacy `/_r/<page._id>` short link) via `IdRedirector` adds the visitor to the page's `grantedUsers` on first visit, so a follow-up direct visit to the page's real path — or from the list/search — no longer 404s. Previously `GRANT_RESTRICTED` behaved like `GRANT_SPECIFIED` for anyone who hadn't already been added, silently breaking the promise made by the link-share popover. A permanent banner now appears at the top of a `GRANT_RESTRICTED` page (hidden for wip/deprecated/draft/stale-revision views, where the link wouldn't actually be claimable) that honestly states sharing the URL below invites the recipient as an editor, with a copy-to-clipboard control and no dismiss option.

  The grant-on-first-access write is confined to a new `POST /pages/link-access` endpoint called only by `IdRedirector`: it is web-session only (OAuth/PAT tokens are rejected before the per-user rate limiter counts them), rate-limited at 30 req/min/user, and atomic (a concurrent grant change or soft-delete can never be raced into an invite). `GET /pages?page_id=` and every other by-id caller (`/_edit`, `/_attachments`, comment/bookmark/watch helpers) are unchanged — visiting those does not grant access.

  Also fixes a search-index visibility gap surfaced while implementing this: search results could include stale hits for soft-deleted / redirect-stub pages, and the Elasticsearch/OpenSearch drivers now exclude `wip` / `deprecated` pages from the index (matching list visibility) instead of leaving them as permanent dead hits.

- 0dfdd9d: Enforce a 32-character minimum length for `WS_TOKEN_SECRET` — the shared HMAC signing key behind realtime collab, presence, notifications, and mail tokens — as part of the boot-time environment validation added in a previous release.

  A value that is set but shorter than 32 characters now aborts boot under `NODE_ENV=production` (also the default when `NODE_ENV` is unset), with an error naming the variable, its current length, the required minimum, and how to generate a strong one (`openssl rand -base64 32`). Under any other `NODE_ENV` (`development`, `test`, ...) the same condition only produces a warning in the consolidated boot-time report, so local development is unaffected. Unset values, values of 32 characters or more, and known placeholder values (still treated as unconfigured, falling back to a random per-process secret as before) are all unaffected by this change.

  This closes a gap where an operator could set a trivially guessable secret (e.g. a dictionary word) that was neither empty nor a known placeholder, and it would silently be accepted as a "configured" signing key for password-reset and invite mail tokens.

### Patch Changes

- 0ee683c: Enforce that `/admin/*` routes only accept web-session authentication, closing a gap where an admin's own PAT or OAuth access token could reach admin endpoints.

  `createJwtAdminRequired` now rejects any request whose `authContext.kind` is not `web` with the existing `403 ADMIN_REQUIRED` response, before checking `user.admin`. RFC-0010 reserves `admin:*` scopes so no PAT/OAuth token is meant to carry admin access — this closes the gap where a scoped, non-admin-intent PAT issued by an admin user could still reach every `/admin/*` endpoint regardless of its scopes. Web-session admin requests (the existing UI flow) are unaffected; non-admin requests keep their existing `403 ADMIN_REQUIRED` behavior.

- 134de8b: `GET /app/info`'s `capabilities` field is now documented and validated as a closed `Capability` enum (`STATIC_CAPABILITIES` + the three runtime-detected tags `search` / `collab` / `collab:redis`) instead of a generic `string[]`, in both the exported Zod schema and the generated OpenAPI spec. `@crowi/api-contract` exports the new `Capability` type, `CapabilitySchema`, and `DYNAMIC_CAPABILITIES` / `ALL_CAPABILITIES` constants alongside the existing `STATIC_CAPABILITIES`. The `@crowi/api` handler's internal `buildCapabilities()` now returns `Capability[]`, so its literals are compiler-checked against this same vocabulary and the handler and the wire schema can no longer silently drift apart.

  `apiVersion` intentionally stays a plain `string` (not narrowed to a `"v2"` literal): the `@crowi/cli` end-user CLI parses `app/info` with a lenient, partial schema parse to implement its WARN-ONLY version-skew note, and a literal type there would make that parse reject the whole response — not just the mismatched field — the moment a future server advertises a different API surface version, silently defeating the very warning it exists to produce.

- 8631cc3: Enforce page permissions on `GET /backlinks`.

  The endpoint now grant-checks the target `page_id` before listing its backlinks, returning 404 (hiding existence) to callers who cannot read the page — previously any authenticated user could probe the existence and link graph of a private page by id. Each `fromPage` in the response is now also grant-checked individually and dropped if the caller cannot read it, the same way hidden-draft `fromPage`s already were. The route gains a `404` response in its contract.

- c863808: `GET /pages` now returns 500 (`INTERNAL_ERROR`) instead of 404 (`PAGE_NOT_FOUND`) for an unknown error raised after the page was already found — most notably a transient render-artifact/renderer failure — so a client reconciling its cache (or any other caller) can no longer mistake "failed to render" for "page was deleted".
- d779c60: Fix a page-visibility bug where a non-creator (e.g. an admin) changing a private page's grant could silently drop the page from the creator's own listings/search/portal results, even though the creator could still open it directly by id. `visiblePageGrantOr` (the query-time `$or` filter used by all listing/search/portal queries) now includes a creator clause, deriving from the same rule as the in-memory `isGrantedFor` check. `Page.updateGrant` also keeps the creator in `grantedUsers` alongside whoever changed the grant, and `isGrantedFor`'s membership check now uses ObjectId value comparison (`.equals()`) instead of reference comparison, fixing a case where populated `grantedUsers` entries could be missed.
- 0e15f17: Make `onInstall` install-once and idempotent, matching the `@crowi/plugin-api` SDK contract.

  `PluginManager.activate()` previously called every plugin's `onInstall(ctx)` unconditionally on every boot, even though the SDK's TSDoc already promised "idempotent — the runtime tracks which plugins have already had `onInstall` invoked and skips on subsequent boots." A plugin author who writes a one-shot legacy config migration in `onInstall` (the documented use case) would see it re-applied on every restart, and any operator edits made after boot would get clobbered by the migration re-running. `activate()` now checks a new `plugin-installed` Config namespace (`plugin-install-tracker.ts`) before calling `onInstall`, and only records the plugin as installed after `onInstall` completes without throwing — a failed `onInstall` is retried on the next boot instead of being silently marked done. No first-party plugin implements `onInstall` yet, so this closes the contract gap ahead of any real usage rather than fixing an observed regression.

- d697e26: Isolate a single plugin's boot-time failure so it no longer takes the whole server down with it.

  `PluginManager.bootstrap()`'s activation loop and `mountPluginRoutes`'s `registerRoutes` loop previously had no per-plugin try/catch, unlike the existing `runReconfigure`/`deactivate` lifecycle paths — a plugin that threw during `activate()` (a bad `registerStorage`, a failing `onInstall` migration, ...) or during `registerRoutes` (an exception while building its HTTP routes) took the entire boot down, leaving even the admin UI unreachable for disabling it. Both loops are now isolated per plugin: an `activate()` failure logs `[crowi:plugin:<name>] activation failed; plugin disabled: <message>`, excludes that plugin from `PluginManager.getLoadedPlugins()`/`getLoadedPlugin(name)`, and is recorded in the new `PluginManager.getFailedPlugins()`; a `registerRoutes` failure logs `[crowi:plugin:<name>] registerRoutes failed; this plugin's HTTP routes are not mounted: <message>` but leaves the plugin's driver registrations (and its `getLoadedPlugins()` membership) intact, since activation itself already succeeded. `GET /admin/plugins` now includes failed plugins with `status: 'failed'` and their error message (successful plugins get `status: 'active'`), and the admin plugin list shows an "Activation failed" badge for them. Deliberately out of scope for this change: rolling back a partially-completed `activate()` call's earlier `register*` calls, and a hard-fail path for plugins that provide an implicit-default driver (`storage.driver: 'local'` / `search.driver: 'mongo'`) — every plugin is isolated the same best-effort way for now.

- b20ff59: Plugin SDK: `PluginRouteOptions.public?: boolean` is replaced by `auth?: 'public' | 'user' | 'admin'` (default `'user'`). `makePluginRouterScope` now installs `createJwtAdminRequired` — the same middleware every core `/admin/*` handler uses — for `auth: 'admin'` routes, so plugins finally have a real admin-only tier instead of only "no auth" / "any authenticated user".

  BREAKING (pre-1.0 SDK): plugins passing `{ public: true }` must switch to `{ auth: 'public' }`; the `public` field no longer exists on `PluginRouteOptions`.

  Fixes a real gap in `@crowi/plugin-slack`: its `POST /manifest` `@action` target (which returns the Slack App manifest, including the wiki's base URL and name) was documented as admin-only but was actually reachable by any authenticated non-admin user. It is now mounted with `auth: 'admin'` and returns `403 ADMIN_REQUIRED` for non-admin users. The Events API webhook keeps `auth: 'public'` (Slack's own request-signature check is its authentication).

  Also narrows `@action` annotation parsing (`schema-markers.ts`) to the two verbs a plugin route can actually be mounted on (`GET` / `POST` — `PluginRouteMethod`), so a plugin declaring `@action "..." PUT ...` / `DELETE` no longer produces a silently-dead admin-form button: `getActionAnnotation` still returns `null` for it, and `PluginManager` now logs a boot-time warning identifying the offending plugin and config field.

- 5e857f6: Fail plugin boot loudly when a `configSchema` is built from the wrong zod entry point, instead of silently losing `@sensitive` detection and writing secrets to storage as plaintext.

  `@crowi/plugin-api`'s `peerDependencies: { zod: "^4" }` only says which npm package to install; it does not say which entry point to import from, and every config-schema introspection helper (`@sensitive`/`@action` marker detection, the admin form field serializer, `listSensitiveKeys()`) depends on the internal shape of the `zod/v3` compat subpath the v4 package ships. A `configSchema` built from the top-level `zod` (v4) API has a different internal shape that all of that introspection silently fails to walk. `PluginManager.bootstrap()` now validates every loaded plugin's `configSchema` right after resolving plugin order, before it calls `listSensitiveKeys()` (which is itself zod/v3-dependent), and throws a descriptive error naming the offending plugin when it wasn't built from `zod/v3`; `activate()` keeps its own equivalent per-plugin check for direct/private-call coverage. `schema-serializer.ts`'s kind detection also switched from `instanceof z.ZodXxx` to `_def.typeName` string comparisons, which is more robust against duplicate `zod/v3` module copies and gives the same defense in depth. `@crowi/plugin-api` gains a README (previously missing despite `package.json`'s `files` already listing it) documenting this, plus a `configSchema` TSDoc note.

- 96a531c: `GET /search` no longer trusts the active search driver's grant filtering unconditionally. `Page.findListByPageIds` now accepts an optional viewer id and, when given one, re-applies the same grant `$or` predicate the rest of the app uses (public / legacy-null / pages the viewer is granted on) before returning results. The search handler passes the requesting user's id, so a driver bug, a stale index, or a future third-party `@crowi/plugin-search-*` that forgets to filter by grant can no longer leak a private page's title, path, or snippet into another user's search results.
- Updated dependencies [134de8b]
- Updated dependencies [8631cc3]
- Updated dependencies [336eec1]
- Updated dependencies [8ff0e64]
- Updated dependencies [d697e26]
- Updated dependencies [b20ff59]
- Updated dependencies [d611836]
- Updated dependencies [5e857f6]
- Updated dependencies [fa5023f]
  - @crowi/api-contract@2.0.0-alpha.7
  - @crowi/plugin-api@1.0.0-alpha.3
  - @crowi/runner@0.1.0-alpha.1

## 2.0.0-alpha.6

### Minor Changes

- 8533d15: While viewing a page, another user's comment now appears (or disappears) in the comment list in place, without a reload — the sibling of the live body soft-refresh, targeting the comment list instead of the body revision.

  When someone else posts or deletes a comment on a page you are reading, your comment list updates silently: an added comment is appended and briefly highlighted with the same amber background as the section highlight (fading after a few seconds), and a deleted comment is removed. Your own posts never trigger the append or highlight — your own action already updated the list.

  - The signal rides the already-open `/presence/<pageId>` WebSocket (no new connection): a `comment-changed` frame carries `{ pageId, changeType, commentId, actorUserId? }` — never the comment body, which is re-fetched from the grant-checked `GET /comments?page_id=`. `PresenceServerMessage` gains a third `comment-changed` member of its discriminated union (api-contract).
  - Multi-instance deployments fan out across replicas via a dedicated `crowi:presence:comment-changed` Redis channel. It does not add a subscriber connection — it piggybacks the existing page-updated subscriber as a second channel. Single-instance dev works without Redis.
  - `added` frames from your own account (`actorUserId === selfUserId`) are suppressed; `removed` frames always re-fetch (the deleter is not known at the model event layer, and a redundant idempotent re-fetch is harmless). The new-comment highlight is derived from a client-side seen-set diff, so the origin double-delivery and dropped frames never re-highlight an existing comment.
  - Historical (`?revision_id=`) and draft views are structurally excluded — they never open a presence socket. The header's comment-count chip live-update is out of scope.

- 715c25d: While viewing a page, another user's save now refreshes the body in place (RFC-0003 §v2.1 read-side soft-refresh).

  When someone else saves a new revision of a page you are viewing — over HTTP (`PATCH /api/v2/pages`) or via realtime collaborative editing — the body is swapped to the latest revision with no full reload and no spinner, scroll position is preserved, and a fixed top-center banner announces who saved it.

  - The signal rides the already-open `/presence/<pageId>` WebSocket (no new connection): a `page-updated` frame carries `{ pageId, revisionId, editorUserId, editorDisplayName }` — never the body, which is still fetched from the grant-checked `GET /pages/revisions/{id}` endpoint. `PresenceServerMessage` becomes a discriminated union (api-contract).
  - Multi-instance deployments fan out across replicas via a dedicated `crowi:presence:page-updated` Redis channel, so a reader connected to a different api process than the saver still updates. Single-instance dev works without Redis.
  - The banner offers "read the version I was reading", which renders the pre-swap body from a local snapshot without touching the query cache (the cache always holds the latest), so background refetches / mutation invalidations leave the old-version view intact. A newer save while reading the old version escalates the banner to "show the latest".
  - Your own saves never trigger the swap or banner (`editorUserId === selfUserId`). Bursts of saves are debounced into a single swap, and a `revision.createdAt` monotonicity guard prevents the view from rewinding on out-of-order or cross-instance same-second saves.
  - Historical (`?revision_id=`) and draft views are structurally excluded — they never open a presence socket. Soft/hard deletes are out of scope (no `page-updated` is emitted for them).

### Patch Changes

- 3029520: Fix `Page.commentCount` not decrementing when a comment is deleted — it was only recalculated on comment creation, so the badge stayed stale (showing a higher count than the actual number of comments) until the next comment was posted.
- 86a9fb0: Enforce page permissions on comment read and delete.

  `GET /api/v2/comments` now grant-checks the owning page (resolved from `page_id`, or from the revision's page for `revision_id`) before returning comment bodies, and returns 404 (hiding existence) to callers who cannot read the page. Previously any authenticated user could read the comments of any private page or revision by id. `DELETE /api/v2/comments` now also verifies the target comment actually belongs to the supplied `page_id`, so a user granted on one page can no longer delete a comment on a page they cannot access by passing a mismatched id. The comment list route gains a `404` response in its contract.

- c638ff0: Fix `POST /pages` and `PUT /pages` responses leaking a full stringified Revision document (including another user's id, the full page body, and internal fields) through the `latestRevision` field instead of returning its id as a plain string.
- 95f7862: Fix an unthrottled reconnect loop against `GET /notifications/token` that occurred whenever `WS_TOKEN_SECRET` was left unset (a supported single-instance configuration): the server now reuses one random fallback signing secret per process instead of minting a new one on every call, and the browser now applies capped exponential backoff to repeated invalid-token WebSocket closes as a defense-in-depth safeguard against the same failure mode in other configurations (e.g. a `WS_TOKEN_SECRET` mismatch across instances).
- 46c4424: Upgrade Mongoose 8 → 9 (mongodb driver 6 → 7, mongodb-memory-server 10 → 11) to keep the ORM on its current major — a debt-reduction follow-up to the earlier 6 → 8 bump. Behavior and the API/JSON contracts are unchanged; the fallout was a `pre('validate')` codemod (the `next()` callback argument is gone in v9), the `FilterQuery` → `QueryFilter` type rename, removal of the long-dead `mongoose.Promise = global.Promise` line, and a handful of stricter v9 query/create type casts.

  Also pin the optional-peer `socks` to `^2.8.7` via `pnpm.overrides` to clear the `socks@2.8.4 → ip-address@9.0.5` GHSA advisory chain. That fix is the `socks` override itself — orthogonal to the Mongoose major and equally applicable on Mongoose 8 (socks has always been an optional peer of `mongodb`, never a hard dependency) — folded into this bump so the chain's removal is guaranteed rather than left incidental to re-resolution.

- Updated dependencies [86a9fb0]
- Updated dependencies [8533d15]
- Updated dependencies [715c25d]
  - @crowi/api-contract@2.0.0-alpha.6

## 2.0.0-alpha.5

### Minor Changes

- Wire plugin-contributed HTTP routes into the Hono app: PluginManager registers each plugin's `registerRoutes(scope, ctx)` surface during boot (public + raw body), so plugins such as `@crowi/plugin-slack` can mount their own endpoints. Also fix the plugin dependency-cycle error to report only the actual cycle rather than the acyclic prefix that led into it.

### Patch Changes

- Updated dependencies
  - @crowi/api-contract@2.0.0-alpha.5

## 2.0.0-alpha.3

### Minor Changes

- 6bbbecd: Harden the realtime collaborative editor against data loss and external-edit divergence. This is the full implementation of the reliability work: alpha.2 shipped only a small seed of external-edit invalidation under an over-scoped changeset, and the complete implementation (a ~5k-line overhaul across `@crowi/collab` and the api collab host) lands here.

  Guard the Yjs document state against shrink and loss: compaction never replaces a document with a smaller or empty state, the document's base revision is persisted so a reconnecting client re-materialises from the correct revision body, and an empty-load fallback rebuilds the doc from the stored revision instead of starting blank.

  External (REST / MCP / in-process) edits now invalidate a live collab session in the same api process: after the page commits, Crowi broadcasts a force-reload, tombstones the document so an in-flight stale save is rejected with a reload prompt instead of CONFLICT-looping, gates reconnects so they re-materialise from the new revision, and drains the stale connections (a force-reload was previously a no-op while any client stayed connected). Two concurrent same-process saves carrying a byte-identical body now coalesce into a single success with the loser recorded as a contributor, while a genuine divergence still surfaces as CONFLICT so the user reloads.

  Multi-instance / out-of-process external edits (a live doc on another replica, or an admin-CLI DB-direct edit) remain a documented limitation requiring a future cross-instance invalidation channel; a single api instance is recommended (see the realtime-collab operations doc).

- 89aa2b7: Split the boot-time preflight migration probe by a new per-migration `severity` (`cosmetic` | `blocking`). A `cosmetic` migration (the display-only ones — the body-rewriting `wikilink-format` / `files-url-to-attachments` / `wikilink-html-recover` and the path-relocating `relocate-reserved-api-paths`) that is still pending now only logs a warning and lets the api boot — even under the default `block` policy — while the data-integrity `user-unique-prepare` migration stays `blocking` and still refuses boot under `block` (downgradeable with `MIGRATION_PREFLIGHT_UNAPPLIED_POLICY=warn`). This fixes the deadlock where a newly written page in old wikilink syntax kept a cosmetic migration's corpus-scan probe pending forever and permanently refused the whole cluster's boot. `crowi-admin migrate list` / `migrate plan` now tag each preflight migration `[blocking]` / `[cosmetic]` so operators can judge boot-block risk (boot-layer rows, which are never boot-probed, show `—`).

### Patch Changes

- eb0fca1: Fix a data-corruption hazard in the `files-url-to-attachments` and `wikilink-html-recover` preflight migrations: a `/files/<id>` URL or a `[[/font]]` token written as a code example (inside a fenced code block or an inline code span) is no longer rewritten. Previously only `wikilink-format` excluded code regions; the other two migrations would corrupt such code examples (e.g. rewrite `![pic](/files/<id>)` shown in documentation, or revert a `[[/font]]` written to explain the migration) and could falsely report the migration as pending — which, under preflight + the `block` policy, could keep cluster boot deadlocked forever. All three body-rewrite migrations now route their detection and rewrite through a single shared `rewriteOutsideCode` code-mask primitive, so they behave identically: code regions are passed through byte-for-byte and a page whose only target token lives inside code is correctly reported as not pending.
- 06aeff5: Fix the `wikilink-format` migration so it no longer rewrites `</…>` tokens written inside code examples (fenced code blocks and inline code spans), which previously corrupted code like ` ```tsx </AppShell> ``` ` into `[[/AppShell]]` and could falsely report the migration as pending. Body-rewrite migrations (`wikilink-format`, `files-url-to-attachments`, `wikilink-html-recover`) now also preserve each page's `updatedAt` and `lastUpdateUser` during `apply` instead of bumping them to "now" / the migration bot, so applying a migration no longer reorders recently-updated lists or overwrites a page's "last updated by".
- Updated dependencies [6bbbecd]
- Updated dependencies [ff63cd1]
  - @crowi/collab@0.1.0-alpha.2
  - @crowi/plugin-api@0.1.0-alpha.1

## 2.0.0-alpha.2

### Minor Changes

- 80e2c36: Rewrite v1 `/files/<id>` attachment URLs in page bodies to the v2
  `/api/v2/attachments/<id>` form via a new `files-url-to-attachments` preflight
  migration, and restore a `/files/:id` → 302 redirect as a runtime safety net.

  In v1, attachments and images were embedded in page bodies as `/files/<24hex>`
  (relative, or `https://<host>/files/<id>` when the editor pasted a full URL).
  v2 serves attachments from `/api/v2/attachments/<id>` and the legacy
  `/files/<id>` route was removed with the Express host, so every such embed now
  404s — the image is broken. The attachment id is unchanged between v1 and v2, so
  this is a pure URL rewrite (no id remap): the migration converts relative
  `/files/<id>` unconditionally, relativizes self-host absolute URLs (matched
  against `CLIENT_URL` / `BASE_URL`), and leaves external hosts untouched to avoid
  clobbering third-party images. Markdown image and link syntax are covered; the
  rewrite is idempotent and reports affected pages via `detect`. When neither
  `CLIENT_URL` nor `BASE_URL` is set, only relative URLs are converted.

  As a safety net for un-migrated bodies and relative `/files/<id>` runtime
  accesses, a public `/files/:id{[0-9a-fA-F]{24}}` route now issues a 302 redirect
  to `/api/v2/attachments/<id>`; authorization is delegated to the (JWT-guarded)
  redirect target.

- 6e50682: Harden the built-in MCP server against prompt injection from untrusted wiki
  content (RFC-0011 §10.7).

  - **API** — MCP read and write-echo tools now return the page body in
    `content[0].text` fenced between open/close delimiters that carry a fresh,
    unguessable per-response nonce, prefixed by a "this is data, not
    instructions" notice. The nonce defeats break-out attempts: a body that
    forges the close tag cannot guess the random id, so injected "ignore your
    task" instructions stay inside the data region. `structuredContent.body`
    is kept raw (so programmatic clients parse it cleanly) and tagged
    `trust: "untrusted"`; search snippets are fenced too, while self-authored
    metadata (path / count / pager) is left plain.
  - **Web** — the Personal Access Token issue form now defaults to the
    read-only scopes and recommends them for MCP / AI clients, so the token
    that gates the MCP server is least-privilege by default; write scopes
    remain an explicit opt-in.

  Clients that feed `structuredContent.body` straight to a model without honoring
  `trust` remain a documented residual risk. See the MCP operations docs for the
  defaults and a verification procedure.

- 20556ca: Improve the page-list / portal / sidebar UX and add a "portalize" flow.

  - **Empty-list "Create page" CTA**: an empty folder listing — or a portal whose
    child list is empty — now shows a "Create page" button (pre-filled with the
    current path), instead of dropping the create affordance. Hidden in trash, at
    the root, and in other users' spaces.
  - **Unified sidebar tree for `/x` and `/x/`**: a content page and its portal
    twin now render the identical sidebar tree, and the current node always
    expands its own children, so navigating between a page and its portal no
    longer reshuffles the tree.
  - **Portalize a content page**: the page "⋮" menu gains "Make this a portal",
    which moves `/some-page` → `/some-page/`, leaving a redirect at the old path
    so existing links / bookmarks keep resolving to the new portal (the same as
    any other rename). Opening `/some-page/` while a content page lives at
    `/some-page` now offers the same one-click portalize banner instead of
    "Create Portal". `GET /pages/list` gains a `contentPage` field to drive this.
  - **No more `/x` ↔ `/x/` double-state**: when one of the trailing-slash twins
    exists, creating the other is refused (editor draft creation, `POST /pages`,
    and rename all return 400 — `PAGE_TWIN_EXISTS` on the page endpoints). A
    self-portalize (`/x` → `/x/`) is still allowed. Existing double-state data is
    left untouched.
  - **Reach a content page that is also a folder**: when a content page at `/x`
    also has descendants under `/x/…`, the sidebar now lists `/x` itself as the
    first child under the `x/` folder (it was previously unreachable, since the
    folder node links to the `/x/` listing). The path in the "there is content
    at this path" banner is now a link to that page, and viewing the content
    page `/x` directly shows a "this page has descendants — make it a portal?"
    banner.
  - **Portals keep their page affordances**: a portal now shows the same
    right-rail table of contents as a normal page (over its body's headings),
    and a compact chip row above the child list toggles the portal's comments,
    backlinks, and attachments — so portalizing a page no longer drops its TOC
    or its comment/backlink/attachment sections.

- 065cda0: Add revert-to-revision: a one-click "revert to this version" button on the
  stale-revision banner (normal + portal pages), a new POST
  /pages/revert-to-revision endpoint, and a crowi_revert_to_revision MCP tool.
  Non-destructive — the past body is stacked as a new revision, so all history
  is preserved and the revert simply lands on top of the current latest.

  Also fixes the stale-revision banner never appearing when opening a page at a
  past `?revision_id=`: `latestRevision` is a dynamic field set by
  `populatePageData`, but `pageToResponse` read it off the `toObject()` result
  (which strips dynamic fields), so it was always serialized as `undefined` and
  the client could never tell it was viewing an old version. This affected both
  normal and portal pages.

### Patch Changes

- 014870a: Put the runtime image's `node_modules/.bin` on `PATH` so the bundled CLIs are
  directly invocable. `docker compose run --rm api crowi-admin <cmd>` (and
  `crowi-api`) now resolve by name; previously the base image's
  `docker-entrypoint.sh` mis-read `crowi-admin` as `node crowi-admin` (because
  `.bin` was not on `PATH`) and failed, forcing operators to spell out the full
  `/app/node_modules/.bin/crowi-admin` path.
- 632924b: Add a side gutter to the shared transactional email layout so the white content
  card no longer runs edge-to-edge on mobile. On narrow screens the card
  previously touched both screen edges, leaving the copy cramped against the
  device frame. The card is now wrapped in a gutter that insets it 16px on each
  side, giving the content breathing room. This applies to every HTML email
  (invite, password reset, activation, admin-approval-pending, password-changed,
  email-change, and the test message) since they all share `layout.mjml`; desktop
  rendering is unchanged.
- 3e58ee8: Bump dependencies to clear Dependabot security advisories. Direct deps lifted so
  transitive chains resolve to the patched versions:

  - `hono` 4.10.0 → 4.12.25 (GHSA-88fw-hqm2-52qc / GHSA-rv63-4mwf-qqc2 /
    GHSA-wgpf-jwqj-8h8p / GHSA-wwfh-h76j-fc44 / GHSA-j6c9-x7qj-28xf)
  - `ws` 8.20.1 → 8.21.0 (GHSA-96hv-2xvq-fx4p)
  - `@elastic/elasticsearch` 9.4.0 → 9.4.2 — pulls `@elastic/transport` 9.3.7 and
    `@opentelemetry/core` 2.8.0 (GHSA-8988-4f7v-96qf)
  - `fumadocs-core` / `fumadocs-mdx` / `fumadocs-ui` to their 16.10.4 / 15.0.12
    lines, `eslint-config-next` 16.1.1 → 16.2.9, `vitest` 4.1.6 → 4.1.9,
    `@vitejs/plugin-react` 6.0.1 → 6.0.2 — pull `@babel/core` 7.29.7 and
    `esbuild` 0.28.1 (GHSA-4x5r-pxfx-6jf8 / GHSA-g7r4-m6w7-qqqr)
  - `form-data` ^4.0.6 and `vite` ^8.0.16 lifted into the dev dependencies of
    `packages/api` / `packages/web` / `apps/crowi-site` so the lockfile resolver
    picks the patched range that supertest / vitest / fumadocs-mdx /
    `@vitejs/plugin-react` could not reach via peer constraints alone (form-data:
    GHSA-hmw2-7cc7-3qxx; vite: GHSA-fx2h-pf6j-xcff / GHSA-v6wh-96g9-6wx3).

  The remaining `js-yaml` (eslint 8 chain) and `ip-address` (mongoose 8 →
  mongodb → socks chain) advisories require eslint 8 → 9 and mongoose 8 → 9
  major upgrades respectively.

- Updated dependencies [4d66883]
- Updated dependencies [20556ca]
- Updated dependencies [065cda0]
- Updated dependencies [3e58ee8]
  - @crowi/api-contract@2.0.0-alpha.2

## 2.0.0-alpha.1

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

- 54f7df3: Ship the `views/` mail templates and `public/` static assets in the published
  `@crowi/api` package. The `files` field listed only `dist` + `README.md`, so
  `pnpm deploy --prod` dropped `views/mail/*.{mjml,text}` and
  `public/images/file-not-found.png` from the production Docker image's
  `node_modules/@crowi/api/`. As a result every mail send (test / account
  activation / admin-approval-pending / email change / user invitation /
  password-change notification / password reset) failed at runtime with
  `ENOENT` while resolving its template, and the attachment "file not found"
  placeholder image likewise could not be streamed. Neither reproduced under
  `pnpm dev`, where the full source tree is visible without going through
  `node_modules`. Adding `views` and `public` to `files` fixes both.
- c0ca5c2: Fix MCP read tools dropping the page body for `structuredContent`-preferring clients. `crowi_get_page` and `crowi_get_revision` (and the write tools that echo back a page) placed the body only in `content[0].text` and exposed just metadata in `structuredContent`. Per MCP convention, clients that prefer `structuredContent` and hide the text block lost the body entirely, falling back to search snippets. The body is now carried in both places (`content[0].text` and `structuredContent.body`, RFC-0011 §9), while the update-lock metadata (`revision_id`, `path`, etc.) is preserved. List/search tools are unchanged.
- 9a22d3c: Fix `Page.updatePage` nulling a page's grant on a grant-less update. It computed
  `const grant = options.grant || null`, so any call without an explicit grant
  (e.g. `updatePage(page, body, user, {})` from `rewritePageBody` and the preflight
  migrations that ride it) hit `null != pageData.grant` and re-granted the page to
  `null` with `grantedUsers = [actingUser]` — silently dropping a public page out
  of `grant: GRANT_PUBLIC` queries. It now defaults to the page's current grant
  (`options.grant ?? pageData.grant`), so a body-only update leaves visibility
  untouched while an explicit grant change still applies. The HTTP update handler
  was already passing `grant ?? pageData.grant` defensively and is unaffected.
- 82a1ed5: Reserve the `/api` namespace so it is never treated as a wiki page. Visiting
  `/api` (or any non-proxied `/api/*`) in the web app previously fell through to
  the page catch-all and offered the "create this page" UI, because only
  `/api/v2/*` is reverse-proxied to the api. The bare `/api` segment now renders a
  404 instead, and the server's `Page.isCreatableName` refuses to create or rename
  a page under `/api` (mirroring the existing `admin` / `me` / `files` / … reserved
  prefixes). The match is segment-bounded, so a real page like `/apiary` stays
  creatable.

  The web catch-all's reserved-path guard now mirrors the full set of server
  top-level reserved prefixes (`installer` / `register` / `login` / `logout` /
  `admin` / `me` / `files` / `trash` / `paste` / `comments` / `api`), so the
  "create this page" affordance is no longer offered for any path the server
  would reject. `/user` is intentionally excluded — it renders the member
  directory.

  For wikis upgrading from v1 (where the API lived at `/_api/*`, leaving `/api/*`
  a valid page path), a new `relocate-reserved-api-paths` preflight migration
  moves any surviving page out of `/api/*` into `/api-legacy/*` so the v2
  reservation does not strand it. Run it with `crowi-admin migrate apply`; wikis
  with no `/api/*` pages have nothing to apply.

- fa5733c: Show suspended users' profile pages instead of 404ing them.

  `/user/:username` (and its `/bookmarks` + `/pages` siblings) returned
  `USER_NOT_FOUND` for any non-active account, which swept up suspended users. But
  a suspended author's pages stay visible in the page tree under
  `/user/<username>/...`, so hiding only their profile produced a broken "User not
  found" landing page. Active and suspended accounts are now shown; deleted
  (tombstoned) and invited / registered placeholder accounts remain hidden behind
  the same 404. The member directory (`/users`) is unchanged and still excludes
  suspended users.

- Updated dependencies [0e9a07c]
- Updated dependencies [27ef287]
  - @crowi/api-contract@2.0.0-alpha.1
  - @crowi/collab@0.1.0-alpha.1

## 2.0.0-alpha.0

### Major Changes

- ea2b7db: Remove the external-share admin feature (admin/share endpoints, app:externalShare config, UI surface). The feature will return as a plugin.

  This is a breaking change: the `GET`/`PUT /api/v2/admin/share` endpoints are
  unregistered (now 404), the `app:externalShare` config seed key is removed, and
  the `externalShare` field is dropped from the `/admin/app` response schema. The
  `/admin/share` page and its admin sidebar entry are gone. Page link-sharing
  (LinkSharePopover / `page.share.*`) and the dormant Share / ShareAccess models
  are kept untouched.

- 580a3f9: Remove the legacy site-wide HTTP Basic auth feature. The `security:basicName` /
  `security:basicSecret` settings are gone from the admin Security screen and from
  the `GET`/`PUT /admin/security` request and response shapes (breaking change).
  The credentials were never re-implemented as enforcement in the Next.js + Hono
  architecture — they were a settings-only carryover from the legacy Express app —
  and in a single-page app a server-side Basic-auth challenge cannot reliably gate
  the UI anyway. Operators who need a site-wide Basic-auth gate should configure it
  at their reverse proxy. Any existing `security:basicName` / `security:basicSecret`
  config rows are simply ignored.
- ee935ad: Remove Google/GitHub social-login scaffolding (config seeds, /me googleId/githubId fields, profile + admin coming-soon surfaces). The admin auth toggles disablePasswordAuth/requireThirdPartyAuth are now inert (hidden in the UI and rejected with 400) since third-party sign-in is gone; they will be reactivated when social login returns as a plugin.

### Minor Changes

- dba0f0d: Add a Docker-style boot progress reporter to api startup.

  The boot sequence is now grouped into four layers (core / config / services /
  server) and reported as it runs. On a TTY (dev terminal) each layer shows a
  live spinner that resolves to `✓ <layer> (Nms)`, followed by a `🚀 API ready
<url>` banner. On a non-TTY (prod / CI / `docker logs` / piped output) it
  falls back to structured, grep-able one-line logs (`[boot] core ok (412ms)`).

  A machine-readable readiness marker (`@@crowi:ready api <url>`) is emitted on
  its own line in both modes. Existing boot warnings/errors (missing encryption
  key, Redis connection failure, missing CLIENT_URL, fatal errors) are preserved
  and no longer corrupt the live progress line. The reporter is independent of
  `DEBUG`, so boot progress is visible without `DEBUG=crowi:*`; when `DEBUG` is
  set it degrades to plain mode to avoid interleaving.

- 8851242: Resolve the public origin from CLIENT_URL only.

  `getBaseUrl()` — used to build absolute URLs in emails (invite /
  activation / password reset / email-change) and for CORS — now reads the
  `CLIENT_URL` env exclusively. The dead `app:url` config key and the
  `BASE_URL` fallback are removed (Slack notification URLs switch to the
  same source). The base is deliberately never derived from the request
  Host/Origin (host-header injection would poison reset/activation links).
  When `CLIENT_URL` is unset, the server warns at boot that email links
  will be relative.

- 097a24b: Add a built-in MCP (Model Context Protocol) server (RFC-0011). A new
  Streamable-HTTP `/mcp` endpoint, hosted inside the `@crowi/api` process,
  exposes the wiki to MCP-capable AI clients (Claude Desktop / Claude Code /
  others) as tools. It is protected by Crowi's existing Personal Access Token
  or OAuth access token auth and per-tool scope enforcement, with no new auth
  code: each tool dispatches in-process to the same API routes the web app
  uses, so page grants, scopes, and revision conflicts behave identically to
  the rest of the API.

  v1 ships 13 page tools — 8 read (`crowi_search_pages`, `crowi_get_page`,
  `crowi_list_pages`, `crowi_list_child_pages`, `crowi_get_page_history`,
  `crowi_get_revision`, `crowi_get_backlinks`, `crowi_autocomplete_pages`)
  and 5 write (`crowi_create_page`, `crowi_update_page`, `crowi_rename_page`,
  `crowi_delete_page`, `crowi_revert_page`). The endpoint is stateless
  (per-request session) and per-user rate-limited; Bearer-token auth is its
  gate (DNS-rebinding `Host` pinning is intentionally off — redundant for an
  authenticated, non-browser endpoint). A read-only token (`pages:read`)
  yields a read-only MCP; `admin:*` scopes are never issuable, so admin
  operations are unreachable. See the operations docs for setup and a
  prompt-injection note.

- 7fa76b5: Drop the legacy AWS config migration and the core `upload:aws:*` settings.
  Third-party credentials (AWS for S3 storage / SES mail, SMTP password, etc.)
  now live exclusively in their plugin's config namespace
  (`crowi:plugin:<name>:<field>`, encrypted via the plugin's `@sensitive`
  fields). The boot-time copy of legacy `upload:aws:*` into the plugin namespace,
  the `aws:*` → `upload:aws:*` rename, and the `upload:aws:*` install defaults
  were removed, along with their entries in the encrypt-at-rest registry.

  Operator impact: when upgrading from old Crowi, AWS/S3 credentials are no
  longer migrated automatically. Enable `@crowi/plugin-aws` (and
  `@crowi/plugin-storage-aws-s3`) and re-enter the credentials in the admin
  Plugins screen; they are stored in the plugin namespace and encrypted. OAuth
  (Google / GitHub) secrets remain in core config until auth providers become
  plugins.

- ce294dd: Rebuilt the Markdown editor on CodeMirror 6 and brought back the two-column live preview. The `/_edit` page now uses a dedicated viewport-width layout — editor on the left, preview on the right (Tabs toggle on narrow widths) — and the preview follows typing with a 250ms debounce. The preview goes through the server-side renderer pipeline (`POST /api/v2/pages/preview`), so it renders via the same mdast → React path as page display, making the editing and saved views look identical.

  `MarkdownEditor` is implemented as a controlled component (`value` / `onChange` / `readonly` / `extraExtensions`). The `extraExtensions` slot is the foundation for injecting the `yCollab` extension in the future realtime collab work (RFC-0003).

- a804e1c: The `/_edit` page now uses a layout that fills the whole viewport, with the editing header and save footer pinned to the screen while the editor and preview each scroll independently inside.

  In addition, **bidirectional scroll sync** between editor and preview is implemented. Rather than legacy Crowi's simple proportional scrollTop, it syncs via fractional-line interpolation combining line + in-block offset ratio, so it follows continuously even inside long blocks like code fences or lists instead of snapping to the top of a line. The server embeds `data-source-line` on each top-level node of the preview mdast (`POST /api/v2/pages/preview`), and the web-side `useScrollSync` hook bridges those markers to CodeMirror's line-block info with linear interpolation. The editor → preview / preview → editor round-trip is a bijection, so the position doesn't drift as you move back and forth.

- ad0cc9b: Notification updates now reflect in realtime (polling removed, replaced by a WebSocket invalidation signal).

  Removed the polling where `useUnreadCount` hit `GET /notifications/status` every 30 seconds, and added a `/notifications/<userId>` WebSocket channel to the api process. When a server operation such as Notification.create / markAsRead / markAsOpened / markAllAsRead happens, the api instance the affected user is connected to pushes `{"type":"changed"}` via Redis pub/sub (channel: `crowi:notifications:user:<userId>`). On receiving the signal, the web side invalidates the react-query keys under `notificationKeys.all` and refetches the latest value from the existing REST API (i.e. a hybrid that does not push the data itself).

  - New endpoint: `GET /api/v2/notifications/token` (short-lived JWT, issuer=`crowi-notifications`, TTL 60s)
  - New WebSocket: `/notifications/<userId>?token=<jwt>`
  - Redis required: a multi-instance setup needs `REDIS_URL` (the same pub/sub mechanism as presence / collab). Single-instance dev without `REDIS_URL` runs in a degraded mode where the WS connects but invalidation signals don't arrive.
  - Compatibility: the existing REST API is unchanged; the only difference from the UI is that the polling requests disappear.

- 32f5965: Watchers are now notified when a page they watch is updated.

  Saving a new revision of a page body (over HTTP or via realtime collaborative editing) now fans out an `UPDATE` notification to the page's watchers, alongside the existing `COMMENT` / `LIKE` / `MENTION` notifications.

  - The audience is the page's WATCH watchers, minus IGNORE opt-outs, the editor themselves, and inactive users — the same fan-out the comment / like notifications use. Editors are auto-watched on save, so they join the watcher set without notifying themselves.
  - Repeated saves and saves by multiple editors collapse into a single unread notification per recipient, with the actors bundled (rendered as "A and N others updated …").
  - Only body updates that create a new revision notify. Rename / move and other metadata-only changes, and soft-deletes (moving a page to trash), do not.
  - New `NotificationAction` enum value `UPDATE` (api-contract); the web notification list / bell render it with an "updated" action label and navigate to the target page on click.
  - No new endpoint, no schema migration, and existing notification behaviour is unchanged. Mail / Slack notifier plugins pick up the new action automatically via the existing fan-out.

- 548e0c8: Add HTML email templates (MJML) and token-based invitations.

  Transactional emails are now branded, responsive HTML built with MJML
  and rendered by the core MailService (sender plugins still only deliver
  the finished message). Email copy is localized to the recipient's
  language (en / ja), and each message ships both an HTML and a plain-text
  part.

  Invitations are reworked to be secure: instead of emailing a plaintext
  temporary password, an admin invite now sends a signed, expiring
  invite-link. The invitee lands on a public `/invite/accept?token=…`
  page, chooses their own username / name / password, and is signed in on
  acceptance (account flips from invited to active). The invite token uses
  the same JWT scheme as the WebSocket tokens (`WS_TOKEN_SECRET`,
  per-purpose claims).

  Activation (registration email confirmation) and self-service password
  reset ship their MJML templates and localized copy in this release; their
  end-to-end flows land in a follow-up.

  BREAKING: invite emails no longer contain a temporary password — invited
  users set their own credentials via the invite link.

- a52d03f: Initial publish preparation: monorepo restructure complete (RFC-0002 →
  feature-monorepo-packages-restructure). All packages now use
  workspace: protocol internally, peerDependencies for plugin boundaries,
  shared @crowi/tsconfig presets, and a publish-ready layout under
  packages/\*.
- a0f4ada: Two fixes to the visibility and display of the page list (`/...slug.../`, `/`):

  - **Fixed the grant filter on the root / no-path branch**: the old implementation hard-coded `grant: { $in: [1, 2] }`, which (a) dropped the viewer's own GRANT_OWNER / GRANT_SPECIFIED pages, and (b) risked leaking GRANT_RESTRICTED pages to non-members because grantedUsers was not checked. Aligned it to combine the Page model's `visiblePageGrantOr` / `visiblePageStatusOr` with `$and`, unifying the behaviour with the path-based listings.
  - **Visual identification of draft pages**: added `'draft'` to `PageStatusSchema` (path-based listings already included the viewer's own drafts via RFC-0004, but the status field couldn't be represented in TypeScript without the enum value, so the badge couldn't be shown). Added an amber "Draft" badge to `PageListItem`, so your own drafts are distinguishable at a glance even when sitting next to published pages.

- 966d133: Make email delivery plugin-based.

  Email sending is now a pluggable transport. The core assembles every
  message (from / subject / rendered body) so it is identical regardless of
  which sender is active, and a mail sender plugin only delivers the
  finished message. The active sender is selected by
  `crowi.config.json:mail.driver` (default `smtp`), mirroring the storage
  and search single-active-driver model.

  - New `@crowi/plugin-mail-smtp` (default-on) delivers over SMTP via
    nodemailer.
  - New `@crowi/plugin-mail-resend` and `@crowi/plugin-mail-aws-ses`
    (depends on `@crowi/plugin-aws`) official senders.
  - New `registerMailSender` plugin hook + `MailSender` / `EmailMessage`
    contract in `@crowi/plugin-api`.
  - `/admin/mail` now owns only the sender-independent `from` address, shows
    the active sender, and sends a test mail through it; each sender's
    credentials are configured under `/admin/plugins`.

  BREAKING: the legacy `mail:smtp*` / `mail:aws:*` Config keys and the SMTP
  / SES fields of the `admin.mail` API are removed. SMTP credentials live in
  the `@crowi/plugin-mail-smtp` plugin config namespace instead.

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

- f04c524: Upgrade Mongoose from 6.x to 8.24.0 (API and the embedded collab library) and
  replace the unmaintained `mongoose-paginate` with `mongoose-paginate-v2`.

  This is a version-follow upgrade: behavior and the API/JSON contracts are
  unchanged. The pagination result envelope rename (`total`→`totalDocs`,
  `pages`→`totalPages`) is absorbed inside the admin handlers, so the
  `/admin/users` pager JSON shape is identical to before. Model statics that
  used Mongoose-6 callback queries (`save`/`find`/`exec`/`findById`/`updateOne`
  callbacks, `Document#remove()`, `findOneAndRemove`, callback-form `connect`)
  were migrated to the promise/async forms that Mongoose 7/8 require, while
  keeping their public callback signatures so call sites are unaffected.

- e7296c0: Add more transactional emails on the shared HTML design system.

  - **Test mail** is now the branded HTML template (was plain text), so the
    admin can verify the real look from `/admin/mail`.
  - **Password-changed notification**: a security notice is sent to the
    account when its password is changed (self-service reset or `/me`
    password change).
  - **Admin approval-pending notification**: under restricted registration,
    every active admin is emailed when a user self-registers and awaits
    approval.
  - **Email-change confirmation**: changing your email via `/me` no longer
    applies immediately — a confirmation link is sent to the new address and
    the change is applied only after clicking it (`/confirm-email?token=…`),
    preventing typo / hijack via an unverified address.

  All four reuse the localized (en / ja) MJML templates and the mail-token
  scheme (new `email-change` purpose).

- ec00876: Add an OAuth 2.0 authorization-server foundation so the Crowi CLI / SDK can
  drive the API "as a user" with scoped, revocable tokens, and replace the
  legacy API token (RFC-0010).

  - **Scopes** — per-resource read/write scopes with a canonical `SCOPES`
    catalog and a `scopeSatisfies` implication helper (write→read, umbrella
    read/write) from `@crowi/api-contract`. The unified Bearer middleware is
    scope-aware and a `requireScope(...)` guard is applied per route. Web
    sessions hold all scopes (UI behaviour unchanged); insufficient scope
    returns `403 INSUFFICIENT_SCOPE` with a `WWW-Authenticate` header.
  - **Personal Access Tokens** — issue scoped, optionally-expiring
    `crowi_pat_…` tokens from the settings screen (`GET/POST/DELETE
/me/access-tokens`); only the SHA-256 hash is stored, the plaintext is
    shown once, and token management is web-session only. **Breaking:** the
    legacy `User.apiToken` and `GET/POST /me/apiToken` are removed with no
    compatibility shim — existing API-token users must re-issue a PAT.
  - **Authorization Code + PKCE** — `POST /oauth/authorize` (web-session only) - `POST /oauth/token` (authorization code with `S256`, or refresh-token
    rotation with reuse detection that revokes the whole chain) + `POST
/oauth/revoke` (RFC 7009) + a consent screen. A first-party `crowi-cli`
    public client is seeded idempotently at boot.
  - **Device Authorization Grant** (RFC 8628) — `POST /oauth/device/authorize`,
    the `urn:ietf:params:oauth:grant-type:device_code` token grant
    (`authorization_pending` / `slow_down` / `access_denied` / `expired_token`),
    `GET /oauth/device` + `POST /oauth/device/verify`, and a `user_code`
    consent screen for headless clients.
  - **Discovery** — `GET /.well-known/oauth-authorization-server` (RFC 8414),
    with every public URL built from the trusted `CLIENT_URL` (never the
    request `Host`, which is attacker-controllable).
  - **History** — each revision records its edit channel (`editVia`:
    `web` / `oauth` / `pat`); the page history view shows an "app" chip
    (tooltip: edited via the API with a token) next to the author for OAuth /
    PAT edits, so web vs API edits are distinguishable at a glance.

  Access tokens are short-lived scope-bearing JWTs; refresh tokens,
  authorization / device codes and PATs are stored as SHA-256 hashes only.

- 8f12462: Add sorting to the directory / portal page listing. The list page now offers a sort control with three options — last updated, date created, and name — surfaced as a dropdown in the listing's section header.

  `GET /pages/list` gains optional `sort` (`updatedAt` | `createdAt` | `path`) and `order` (`asc` | `desc`) query parameters, defaulting to `updatedAt` descending so existing callers are unaffected. Sorting applies to the path and root listings; the per-user "created pages" listing keeps its own newest-authored-first order.

- 7f77407: Plugins can now localize their admin config-form field labels and descriptions.
  A plugin declares a `configI18n` catalog (`locale → field → { label, description }`)
  and the admin API overlays the entry matching the requesting admin's locale on
  top of the schema-derived field; the Zod `.describe()` text remains the default
  when a translation is missing. The `GET /admin/plugins/config` endpoint accepts
  an optional `locale` query parameter, and `PluginField` gained an optional
  `label`. The PlantUML renderer ships Japanese translations for its server URL
  and image format fields as the first consumer.
- d293151: Fix new-user registration controls to match the documented (legacy) behavior.

  The registration email whitelist (`security:registrationWhiteList`) is now
  enforced at sign-up time in every non-closed registration mode — previously the
  new `/auth/register` endpoint ignored it, so a configured whitelist had no
  effect on public registration (a regression from the legacy app). When the
  whitelist is non-empty, only matching addresses can register; an empty
  whitelist imposes no restriction.

  The admin Security screen labels were also corrected to describe what each mode
  actually does: Restricted = "admin approval required" (was mislabeled as
  "whitelist only"), Closed = "invite only" (public sign-up disabled, admins can
  still invite), and the whitelist is described as a cross-mode gate.

- deb6a26: Require email confirmation for self-registration.

  When a user signs up themselves (open registration), the account is no
  longer activated immediately. Registration now creates a pending account
  and emails a signed activation link (localized MJML template); the public
  `/activate?token=…` page confirms the address via `POST /auth/activate`
  and signs the user in. Login is blocked with an "email not confirmed"
  message until then.

  Accounts created by an admin invite, by the installer, or by an admin
  are treated as already confirmed (the invite link itself proves email
  control), so those flows are unchanged. Restricted-registration mode
  still gates on admin approval.

  BREAKING: `POST /auth/register` no longer returns auth tokens; it returns
  `{ status: 'confirmation_required' | 'approval_required' }` and the user
  must confirm their email (or await approval) before signing in.

- b8c067b: Rename a page together with its whole subtree

  `POST /pages/rename` now accepts an `include_descendants` flag. When set, the
  page is moved together with every grant-visible descendant under it: paths are
  rewritten to the new base, redirects are created from each old (non-portal)
  path, and the original timestamps are preserved so a bulk move does not flood
  the "recently updated" list. Destination collisions and invalid names are
  detected up-front and returned as a structured `PAGE_RENAME_TREE_FAILED` 400
  that names the offending paths. The response also reports `renamed_count`.

  In the rename dialog, the "move subpages together" switch is now wired up: it
  moves the subtree, navigates to the new path, shows how many pages moved, and
  lists any conflicting paths on failure.

- ab063fe: Realtime collaborative editing (RFC-0003) v2.1 alpha is now available. The page editor (`/_edit?page_id=<pageId>`) runs in a Google Docs-style realtime co-editing mode where multiple users can edit the same page simultaneously. It ships with Hocuspocus attached in-process as the `@crowi/collab` library, so `/collab/*` WebSockets are handled on the same host as the api (no separate process to start).

  The `@crowi/api-contract` minor bump is for `GET /api/v2/pages/:id/yjs-token` (wsToken issuance) and the new `savedBy` / `contributors` fields on the `Revision` schema.

  Main features:

  - Live cursors / awareness display visualise other members' cursor positions and selection ranges in realtime. An `Alice (with Bob, Carol)` style contributors display is also added to the revision history.
  - Save = checkpoint model: an explicit Save button creates a `Revision`; autosave is intentionally absent. `renderedAst` is updated at the same time via `Revision.prepareRevision` (RFC-0002).
  - Concurrent-editor cap of 20 (configurable with `COLLAB_MAX_EDITORS_PER_PAGE`). The 21st editor and beyond receive live updates in read-only mode.
  - In multi-instance deployments `@hocuspocus/extension-redis` auto-attaches when `REDIS_URL` is set, doing pub/sub across all api replicas without sticky sessions.
  - Persistence is a 3-layer structure: `Page.yjsState` (live snapshot) / `PageYjsUpdate` (high-frequency deltas, TTL 1h) / `Revision` (checkpoint on save).

  See `apps/crowi-site/content/docs/{ja,en}/operations/realtime-collab.mdx` for operations (reverse-proxy config / required multi-instance env / 2-instance smoke test), `apps/crowi-site/content/docs/{ja,en}/realtime-editing.mdx` for the user-facing guide, and `docs/rfcs/0003-realtime-collaborative-editing.md` for the design rationale.

- 87f35d4: Editor UX enhancement (RFC-0004) v2.2 is now available. Four features were added on top of the minimal CodeMirror 6 editor introduced in RFC-0003, lifting the editor from "usable" to "productive".

  Main features:

  - **Autocomplete**: `@` + characters suggests users, `[[` + characters suggests pages, in a dropdown under the cursor. Three-way separation of display / insert / view (insertion uses the canonical `@username` / `[[/full/path]]` forms), 100ms debounce, LRU cache + a footer Refresh, suppressed inside code blocks / math / link syntax and at mobile widths.
  - **Paste handler**: smart-converts a single pasted URL to `[text](url)` / autolink, uploads image blobs to `POST /api/v2/attachments/upload` with auto-naming `pasted-<ts>.<ext>`, and updates an `![Uploading…(%)…]()` placeholder in-place via a Yjs transaction.
  - **Drag & drop upload**: dropping files uploads with progress at the cursor position and inserts a reference (images `![](url)` / others `[](url)`), processes multiple files serially, and is disabled in read-only mode.
  - **Draft pages**: a new page starts as `Page.status: 'draft'` and transitions one-way to `'published'` on save. `POST/GET/DELETE /api/v2/pages/drafts`, same-path conflicts return 409 + owner info, with a `/me/creating-pages` management view. Drafts are author-only and excluded from listing / search / collab.
  - **Toast notification utility**: a minimal `notify.info/warn/error` shared by the above.

  The `@crowi/api-contract` minor bump is for the new autocomplete / drafts / attachment-upload contracts and the added `status` field on the `Page` schema. Uploads enforce a 20/min/user rate limit, size caps (paste 10MB / D&D 50MB), and a file-type allow-list.

  See `apps/crowi-site/content/docs/ja/guide/` (`attachments.mdx` / `pages.mdx` / `markdown.mdx`) for the user-facing guide, `apps/crowi-site/content/docs/ja/operations/storage.mdx` for operator upload limits, and `docs/rfcs/0004-editor-ux-enhancement.md` for the design rationale.

- be5fcee: Page presence & header UI (RFC-0005) v2.2 is now available. A live presence row showing "who is viewing right now" in realtime was added to the page view, and the header meta row was restructured into unified clickable chips.

  Main features:

  - **Live presence row**: above the page title, shows realtime avatars of the users currently viewing the page. Anyone with the realtime co-editing editor open gets a `✏️` badge. Up to 5 avatars + a `[+N]` popover (20-item cap), with your own marked "(you)". The whole row is hidden when you're the only one; on narrow screens it collapses to a `[👁 N]` chip that expands into a sheet. New joins are smoothed in with a 3-second anti-flicker delay.
  - **Restructured meta-chip row**: the static author / updated-time elements plus the four like / view / comment / backlink items are converted into unified `[icon][count][label]` clickable chips. Like and view open modals; comment and backlink smooth-scroll to the relevant section + focus its heading. count=0 is greyed out + non-interactive + tooltip. Pressing the like button optimistically updates the chip count (reverting via toast on failure).
  - **"Who liked" modal**: a new modal shaped like the existing "who viewed" modal. The v1.x viewer avatar stack is removed and replaced by the view chip + modal.
  - **Presence WebSocket / endpoints**: added `GET /api/v2/pages/:id/presence-token` (short-lived JWT issuance) and a `/presence/:pageId` WebSocket. Like RFC-0003's `/collab`, the WebSocket attaches to the api process's `http.Server` in `ws noServer` mode, needing no separate process or port. Viewer state is a Redis hash and multi-instance propagation reuses the existing Redis via pub/sub (no dedicated infra). `isEditing` is computed by joining against RFC-0003's editor-cap Set at broadcast time.

  The `@crowi/api-contract` minor bump is for the new endpoints (`GET /pages/:id/presence-token` / `GET /pages/:id/likers`) and the presence WebSocket message schema.

  See `apps/crowi-site/content/docs/{ja,en}/guide/pages.mdx` for the user-facing guide, `apps/crowi-site/content/docs/{ja,en}/operations/realtime-collab.mdx` for the operator `/presence/*` reverse-proxy note, and `docs/rfcs/0005-page-presence.md` for the design rationale.

- 088f922: Add self-service password reset.

  Users who forget their password can now request a reset link from the
  sign-in page. `POST /auth/forgot-password` emails a signed, 1-hour reset
  link (always returns 200 to avoid revealing whether an email is
  registered); the public `/reset-password?token=…` page sets the new
  password via `POST /auth/reset-password` and signs the user in. The reset
  email reuses the localized MJML template (en / ja).

- 10ac192: Add a light / dark / system theme switch. The app already shipped a full set
  of `.dark` design tokens but had no way to activate them; this wires them up
  and covers the rendering that lives outside the token system.

  - **Theme toggle** — a system / light / dark switch in the header user menu
    and on the sign-in screen (next to the language switcher), backed by
    `next-themes` (`class` strategy, `system` default). The selection persists
    and is applied before hydration, so there is no flash of the wrong theme on
    reload (no FOUC, no hydration warning). `system` follows the OS setting.
  - **Token-driven UI** — activating `.dark` switches the whole shadcn +
    `--crowi-*` surface (background, text, borders, buttons, alerts, avatars,
    header, sidebar) and `color-scheme` aligns native UI (scrollbars, form
    controls) to the theme.
  - **Outside-the-tokens rendering** — Shiki code blocks render dual-theme via
    CSS variables (`--shiki-light` / `--shiki-dark`) so highlighting follows the
    theme; the CodeMirror editor, the page-history diff viewer, and sonner
    toasts all track the active theme. KaTeX inherits `currentColor`.
  - **Cross-device persistence** — the chosen theme is stored on the user
    account (`User.theme`) via a dedicated `PATCH /me/theme` and reconciled on
    load, so the preference follows the user across devices rather than living
    only in per-device localStorage.
  - **Fixed-colour diagrams** — server-generated PlantUML (and future Mermaid)
    SVGs keep their baked-in colours; under dark mode they are wrapped in a
    neutral light background so they stay legible.

- 56babec: Add a user-approval queue to the admin panel. When one or more sign-ups are
  awaiting administrator approval (status REGISTERED, produced by the Restricted
  registration mode), a "User approval" entry appears under User management in
  the admin sidebar with a live count badge, linking to a dedicated screen that
  lists the pending users and approves them one click at a time. Backed by a new
  `GET /admin/users/pending-count` endpoint and a `status` filter on the user
  list endpoint.

  Invited users now have a deliberately minimal row menu (change email / delete)
  and can be removed via a new `DELETE /admin/users/{id}` endpoint, which
  physically removes never-activated (INVITED) accounts only.

- a469da3: Turn the special `/user/` page into a member directory. It now leads with a card grid of workspace members (avatar + display name + @username, each linking to that user's page) above the usual list of pages under `/user/`. A "Show all" link opens a dedicated `/_user` directory with a username/name search box and pagination. Creating a portal document at `/user/` is no longer offered (and is rejected server-side), since the path is reserved for the directory; individual user pages such as `/user/alice` are unaffected.

  Adds a new authenticated endpoint `GET /users` that lists active users (name-ascending, searchable by username/name, offset-paginated). The directory payload is intentionally minimal — avatar, display name, and username only; email is never exposed.

- 4594ad2: Notifications are now driven solely by explicit page watchers, and participating in a page auto-subscribes you.

  Previously the notification audience for comments / likes was an implicit set (the page creator plus everyone who had ever commented or edited the page) unioned with explicit WATCH watchers. A one-time editor of a page they did not watch could therefore keep receiving notifications and could only stop by explicitly ignoring the page.

  The audience is now exactly the explicit `WATCH` watchers, minus `IGNORE` opt-outs, minus the acting user, minus inactive users. To keep the effective reach the same while making it controllable, participation now materialises a real watcher row:

  - Creating a page or saving a new revision auto-watches the acting user. This covers both HTTP saves and realtime (collab) saves, which flow through the same page-save event.
  - Commenting auto-watches the commenter. The add-comment response now returns `newlyWatching: boolean`; when it is `true` the web UI shows a one-shot "you're now watching this page" hint with a stop-watching action.
  - An existing `IGNORE` row is always respected — auto-watch never flips an opt-out back to watching.
  - Liking a page does not auto-watch.

  `getWatchStatus` now reports watch state purely from the presence of a watcher row (the previous derive-from-implicit-set fallback is removed), so the watch toggle is the single source of truth. No schema change; existing pages are not backfilled (auto-watch applies to new activity going forward).

- 3f937ae: Add `crowi-admin watcher backfill` for pages created before auto-watch.

  Auto-watch only materialises WATCH rows for participation going forward
  (create / edit / comment), and the notification fan-out is now watcher-only, so
  pages that predate the feature have no watcher rows and their past participants
  stop being notified. The command walks every non-redirect page and creates a
  WATCH row for its implicit notification set (creator + comment authors +
  revision authors), respecting existing IGNORE opt-outs and leaving existing
  WATCH rows untouched. Idempotent; supports `--dry-run`.

### Patch Changes

- 5a775a3: Fix profile pictures disappearing a few minutes after upload on the S3
  storage driver. The upload handler persisted a _time-limited signed_ S3
  URL (5-minute TTL) into `user.image` and served it verbatim, so the
  avatar 403'd once the signature expired. Profile pictures now store the
  stable `by-key` streaming-proxy path (`/api/v2/attachments/by-key/...`)
  regardless of driver — it never expires and is reachable from an
  `<img>` via the access-token cookie. Existing avatars uploaded before
  this fix need to be re-uploaded to pick up the stable form.
- 60a3cda: Fix the bookmark list rendering an empty placeholder ring instead of each
  page's avatar. `Bookmark.populatePage` populated the page's revision but
  not its `creator` / `lastUpdateUser`, so the user fields arrived as bare
  ids and the page row had no one to credit. Populate them alongside the
  revision, matching the `/pages/list` listing.
- 20e6395: Make `@crowi/api` plugin-free again: it now depends only on its SDK
  (`@crowi/plugin-api`) and core packages, not on the first-party driver
  plugins (storage / mail / search / renderer). Which drivers ship is owned by
  the _runner project_ that boots the api, not by the api package itself.

  This is the final alpha1 deployment model. The official full Docker image is
  built from `apps/crowi-runner` (`@crowi/runner-app`), a reference runner
  project that declares `@crowi/api` plus the full first-party plugin set and
  holds `crowi.config.json`. The api boots with the runner project as its
  `projectDir`, and `@crowi/runner` resolves the configured plugins from there
  via `createRequire` — operators (or the official image) pick the plugin set
  by editing the runner project's `package.json` + `crowi.config.json`, with no
  api rebuild. An earlier interim approach promoted all 11 driver plugins to
  production dependencies of `@crowi/api` directly; that has been reverted so a
  local+mongo-only operator no longer pulls in the S3 / ES / OpenSearch / SES
  SDKs.

  The plugin↔SDK relationship is unchanged and stays correct: every
  first-party plugin (plus `@crowi/runner`) declares `@crowi/plugin-api` — and
  the AWS-based plugins also `@crowi/plugin-aws` — as a real `dependencies`
  entry (`workspace:^`) rather than a `peerDependencies` semver range. The
  plugins import the SDK at runtime, so a real dependency is correct, and it
  lets the runner project's `pnpm deploy --prod` resolve the SDK from the
  workspace instead of hitting the npm registry for an unpublished package.

- f0d69c2: Invalidate the collaborative editor's Y.Doc snapshot on external (REST/API)
  page edits. `Page.updatePage` now drops `Page.yjsState` and re-points
  `currentRevision` to the new revision (RFC-0003 §"Server-side direct Markdown
  edits"). Previously an API edit left the stale `yjsState` in place, so opening
  the editor restored the pre-edit document and its next autosave silently
  reverted the external edit — making the edit appear to "not show" on the page.
- 9c55f6c: Fix other users' draft pages leaking into the page list. The `include_deleted` query param used `z.coerce.boolean()`, which is JS `Boolean(v)` — so the string `"false"` (how the web client serialises `false` on the query string) coerced to `true`. That flipped `include_deleted` on for every listing request, making the server skip the draft/status visibility filter and return drafts owned by anyone, not just the viewer. The param now parses the string explicitly so only `"true"` / `true` is truthy.
- 8bfb1fd: Fix the portal document being stuck on "Rendering…" in the page list, even after publishing. `listPages` projected the portal with the lean `pageToResponse` (no `renderedAst`), but the web client renders the portal as a full page and needs the AST. The portal response now emits `renderedAst` and runs the same on-the-fly fallback as the page detail endpoint, so legacy / renderer-version-mismatched revisions render too.
- f568734: Disallow renaming a user's home page (`/user/<username>`). Its path is bound
  to the username, so the rename action is hidden in the page menu and the
  rename API rejects it with 400 PAGE*INVALID_NAME (mirroring the existing
  delete guard). The guard covers every route into a rename: the single-page
  rename (source and destination — a page can't be moved \_onto* a home path
  either) and the folder/subtree move (a `/user/` subtree that would sweep in
  every home page is refused). Pages under the home (e.g.
  `/user/<username>/memo`) are unaffected.
- 1fa5a4c: Stop listing a portal's own document among its child rows. When viewing a
  portal (e.g. `/crowi/`), the portal page is already rendered as the portal
  card / header, so it no longer also appears as a row in the page list below
  — where it was a redundant, no-op self-link. Applies to draft portals too.
- dbc4b0a: Refine how portals appear in the sidebar tree. Directory rows now keep the
  folder icon and show a small portal marker after the name (e.g. `crowi/ ◎`)
  instead of swapping the leading folder icon for a compass. Draft (unpublished)
  portals no longer count as portals in the sidebar — a draft-only path is not
  shown at all, and a folder that merely has a draft portal shows as a plain
  folder without the marker.
- 8e3d4bf: Promote `@crowi/plugin-search-mongo` to an always-on **implicit default** and
  add a **slim** Docker image as the minimal start-up set.

  `IMPLICIT_DEFAULT_PLUGINS` (in `@crowi/runner`) now loads the trio
  `@crowi/plugin-storage-local` + `@crowi/plugin-search-mongo` +
  `@crowi/plugin-mail-smtp` on every boot, so a fresh install — backed by
  **MongoDB alone**, with no Elasticsearch / S3 / external mail relay — comes up
  as a working Wiki (local file storage, MongoDB `$regex` search, SMTP mail)
  without any extra plugin install or `crowi.config.json` entry. The
  `crowi.config.json` schema already defaults `search.driver` to `'mongo'`, so
  this matches the documented defaults.

  A new slim reference runner project (`apps/crowi-runner-slim`,
  `@crowi/runner-app-slim`) bundles exactly those three drivers and is the build
  source for the slim Docker image — a small base/starter for operators who want
  to fully customize their plugin set. The full image (`apps/crowi-runner`,
  all twelve first-party drivers, switchable via config with no rebuild) gains
  `@crowi/plugin-search-mongo` too. Both images build from the same
  parameterized `packages/api/Dockerfile` (`--build-arg RUNNER_APP=...`).

- 9899d5f: Narrow `User.lang` to the live `en` / `ja` locales. The legacy regional
  variants (`en-US` / `en-GB`) were retired — only `en` and `ja` ship UI
  messages — so the language enum (`LanguageSchema` / `UserLanguageSchema`),
  the Mongoose enum, and the `User.lang` type are all tightened to `en` / `ja`,
  and the new-user default moves from `en-US` to `en`.

  Existing rows that still hold a legacy value are handled without a data
  migration: they are normalised to `en` on read (`GET /me`) and coerced on
  write via a `User` `pre('validate')` hook, so the tightened enum never
  rejects a save. Also fixes a latent copy-paste bug where the `User.LANG_EN_GB`
  model static was assigned the `en-US` value.

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
- Updated dependencies [7f77407]
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
  - @crowi/plugin-api@0.1.0-alpha.0
  - @crowi/runner@0.1.0-alpha.0
  - @crowi/collab@0.1.0-alpha.0
