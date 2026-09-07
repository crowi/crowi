# @crowi/api-contract

## 2.0.0-alpha.19

## 2.0.0-alpha.18

### Patch Changes

- a334308: Upgrade TypeScript 5.8 → 6.0 across the whole workspace catalog, plus the two tools whose own peer ranges gated it: `ts-jest` 29.3 → 29.4 (the current version still excluded TS 6) and `@typescript-eslint` 6.21 → 8.68 (moved into the catalog so all five workspaces that declare it directly stay in lockstep). `eslint` itself is untouched, jest stays on the same major, and TypeScript 7 (a native/Go rewrite still landing ecosystem-wide support) is out of scope — this bump is the sanctioned bridge release for that eventual move.

  Runtime behavior and every public type/API shape are unchanged; the generated `.d.ts` output was diffed against the pre-upgrade build across all 316 declaration files and the only differences found were union-member reordering (an internal declaration-emitter artifact, byte-identical content once sorted) with zero content changes.

  Two compiler-level fallouts were absorbed without weakening `strict` or any other type-safety setting:

  - TS 6 hard-errors on two now-deprecated `tsconfig` options that will disappear in TS 7 (`moduleResolution: "node"` and any `baseUrl`, the latter also implicitly injected by `tsup`'s own declaration bundler on every workspace that ships a `.d.ts`). The shared `tsconfig/base.json` now sets `ignoreDeprecations: "6.0"`, which is TypeScript's own documented bridge flag for this exact transitional release; actually migrating off these options is real resolution-strategy work that belongs with the eventual TS 7 move, not this version bump.
  - TS 6 stopped auto-including `@types/*` packages for workspaces using `moduleResolution: "bundler"` unless a tsconfig's `types` array names them explicitly. Several `library.json`-based packages picked up this newly-required `types: ["node"]` / `types: ["jest", "node"]`, matching the explicit-`types` convention several sibling packages (`svg-sanitize`, `admin-cli`, the search plugins, etc.) already used for the same reason.

  `@typescript-eslint` 8's `recommended` preset also added `no-require-imports` (superseding the deprecated `no-var-requires` most call sites already had a justified `eslint-disable` comment for) and tightened `no-empty-object-type` against empty `interface X extends Y {}` declarations. Every new diagnostic was resolved individually: existing suppression comments were extended to cover the new rule name, a handful of genuinely dead/redundant `require()` calls were deleted, two `require()` calls were converted to static imports, and three `Pick<...>`-only marker interfaces became plain type aliases (a mechanical, meaning-preserving rewrite, not a design change).

  `@crowi/web` and `@crowi/site` lint through `eslint-config-next`, which bundles its own `typescript-eslint` dependency rather than reading the workspace catalog. That bundled copy (8.53.0) declared `typescript: >=4.8.4 <6.0.0`, a TS6-excluding range. A `pnpm.overrides` entry (`"typescript-eslint@<8.68.0": "8.68.0"`) forces it to the same 8.68.0 already used directly by the five workspaces above, whose peer range (`>=4.8.4 <6.1.0`) accepts TS 6. No new lint errors surfaced in either workspace after the bump.

  One TS6-excluding tool remains in the graph with no available fix: `openapi-typescript` 7.13.0 (used only by `@crowi/api-contract`'s dev-time OpenAPI-types codegen script, `scripts/generate-openapi-types.ts`) declares `typescript: ^5.x`, and 7.13.0 is still the latest release. This surfaces only as a non-fatal `pnpm install` peer-dependency warning — pnpm does not fail installs on unmet peers by default, and the tool isn't part of `type-check` / `build` / `test` / `lint`. It was verified functionally: `pnpm --filter @crowi/api-contract generate` runs clean under TS 6, and `pnpm check:openapi` confirms the regenerated artifacts are byte-identical to the committed ones. Revisit once openapi-typescript ships a TS6-compatible release.

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

### Patch Changes

- 5270087: Saving admin settings that fail to persist to the database now returns an error instead of a false 200, and the failed value is no longer applied to the running instance or its replicas — a reload used to silently show the pre-save value with no indication anything had gone wrong.
  This also fixes plugin config saves: a connectivity-check notice ("saved, but verification failed") could previously appear for a value that was never actually written to the database.
  `PUT /admin/app` and `PUT /admin/mail` can now return a 500 on a write failure, matching the existing behavior of `/admin/auth`, `/admin/security`, and `/admin/plugins/config`.

## 2.0.0-alpha.16

### Major Changes

- 9a288e3: Linking a federated identity (Google, or any other configured provider — RFC-0014) from `/me` is rebuilt as three authenticated steps instead of one unauthenticated top-level redirect. Pressing "link" on an unlinked provider now sends an authenticated request that mints the identity-provider authorization URL, then the browser navigates there directly; returning from the provider shows a one-time confirmation on the Security tab ("Link the Google account `xxx@example.com`?", or just the provider name when the provider doesn't return a displayable email) that the user must explicitly confirm before the identity is attached — closing the dialog or navigating away links nothing. The previous flow was unauthenticated at the point the identity provider redirected back, which meant a copied authorization link could be used by anyone to attach an identity provider account they controlled to whichever Crowi account had started that link — a permanent backdoor into that account for whoever opened the copied link. The new flow authenticates both the start and the final confirmation, binds the target account to the server-resolved session at start time (never to anything the callback carries), and re-validates that the account is still active with an unchanged authentication state immediately before attaching the identity.

  **Breaking**: the `POST /api/auth/providers/:name/link-grants` endpoint and the `link`/`link_grant` query parameters on `GET /api/auth/providers/:name/start` are removed; a request using either now fails instead of degrading to a plain sign-in. Normal federated sign-in, unlinking, and `GET /api/auth/providers/identities` are unchanged.

  **Operator note**: because this release replaces the shared OAuth state cookie's linking payload with a flow-specific one, deployments running more than one API replica must drain and replace all replicas at the same time for this release — a one-at-a-time rolling update is not supported, since an old replica can still read (and delete before validating) the new cookie format during the overlap window, which would also break unrelated in-flight sign-ins on that replica. Single-instance deployments satisfy this automatically. Multi-instance deployments must also have `REDIS_URL` configured so the confirmation code is visible to whichever replica handles the follow-up confirmation request.

## 2.0.0-alpha.15

### Patch Changes

- c1cb3d5: Admins can now see which users have a linked federated identity (RFC-0014) and disconnect one from the user list — the users table shows a linked-account icon per row, and a new row action unlinks a provider. If the target user has no password, the admin unlink issues a random one and shows it once (mirroring the existing password-reset flow); an existing password is left untouched. An admin can never unlink their own identity from this screen, and unlinking is refused instance-wide while password sign-in is disabled, since either would strand the account. The unlink removes the same registration-journal row the self-service unlink already cleans up, so the disconnected provider account cannot walk straight back into the account through the sign-in screen.

  An account with a linked federated identity can no longer have its email address changed by an admin either: `PUT /admin/users/{id}/email` now refuses a different address with `409 EMAIL_LOCKED_BY_FEDERATED_IDENTITY`, the same way the self-service `PUT /me` already does. Unlinking the identity first is the only way to change it. The user-edit dialog no longer has an email field at all — `PATCH /admin/users/{id}` now updates only the display name, and email changes go exclusively through the dedicated "Change email" dialog, so there is exactly one email-writing path to lock.

## 2.0.0-alpha.14

### Minor Changes

- cb0608a: Render a document-leading YAML frontmatter block as a muted key/value table instead of letting it fall through as a broken horizontal rule and paragraph.

  Pages that start with a `---`-delimited frontmatter block (common when pasting a spec, RFC, or other document with metadata headers) used to render that block as a mangled paragraph, since the renderer had no concept of frontmatter at all. The pipeline now parses a document-leading `---` block, scans it line-by-line into an ordered list of key/value entries (never a full YAML parse, so there is no anchor/alias expansion attack surface), and displays it as a compact two-column table above the body. A frontmatter block that is empty renders nothing; one that is malformed, or exceeds a bounded size, is preserved verbatim as a fenced `yaml` code block so no content is ever lost. A `---` anywhere other than the very first line of the document is unaffected and still renders as an ordinary horizontal rule. Existing pages pick up the new rendering the next time they're viewed; an operator can also run `crowi-admin rebuild rendered-ast` to backfill the stored copy in bulk.

- 8e881d0: The server now publishes its upload policy at `GET /attachments/upload-policy` (allowed MIME types, extension-to-MIME hints, and per-route size limits), so clients no longer have to guess what an instance accepts. `@crowi/cli`'s `attach add` fetches (and caches per profile) this policy before uploading and rejects an oversized file or a disallowed type locally, instead of waiting for a 413/415 round trip; against an older server that lacks the endpoint (404), it falls back to its built-in extension table exactly as before, so nothing regresses. Profile picture uploads (`POST /me/picture`) now resolve the effective MIME type from the filename when the client doesn't declare a `Content-Type` (the same fallback already used by attachment uploads), so CLI, curl, and MCP clients can finally set a profile picture without declaring one. Profile picture acceptance also moves from an unbounded `image/*` pattern to the same finite image-type allow-list attachments use, plus a 5MB size cap matching the web client's existing crop-dialog guard; a declared `image/*` type outside that list (e.g. `image/tiff`) or a file over 5MB is now rejected, which it previously was not.
- 5096980: Attachment uploads now share a single 50 MB size limit across the "Attach file" button, editor paste, and drag-and-drop — previously these disagreed (100 MB / 10 MB / 50 MB respectively), and the paste limit in particular did nothing to bound memory usage since the request body was already fully buffered before it was checked. Operators can lower the limit with the new `CROWI_UPLOAD_MAX_BYTES` environment variable (a value above 50 MB is clamped to 50 MB, since the limit is also the per-upload memory budget); see the environment variables table in the configuration docs. `GET /attachments/upload-policy` now reports this single limit as `maxBytes.attachment` (the separate `paste`/`dnd` figures are gone), and the editor upload request no longer sends an `intent` field — the web drag-and-drop handler now reads its size ceiling from this policy response instead of a hard-coded constant. If a reverse proxy sits in front of crowi and rejects an upload with its own (smaller) body-size limit before the request reaches the api, the web editor and the `crowi attach add` CLI command now recognize that the rejection didn't come from crowi itself and tell the user to check the proxy configuration instead of reporting crowi's own limit; the deployment docs gained a section on setting the proxy's body-size limit (nginx defaults to 1 MB) to a margin above crowi's own limit, since an exact match can still reject a request crowi would have accepted.

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

- 0b62bc0: An account with one or more linked federated identities (Google, or any other configured provider — RFC-0014) can no longer move its own email address through `PUT /me`. The address on a federated account was verified by the identity provider at sign-in; letting the holder of a stolen `profile:write` credential (a leaked personal access token or OAuth grant) redirect the confirmation link to an address they control would hand the account's recovery identifier away. A request that submits a different email now fails with `400 EMAIL_LOCKED_BY_FEDERATED_IDENTITY` and applies nothing from that request — name and language changes sent in the same request are not saved either, so the outcome is all-or-nothing. Resubmitting the current, unchanged address still saves name/language normally, and accounts with no linked identity are completely unaffected — the confirm-by-email flow behaves exactly as before.

  The profile response (`GET /me` and `PUT /me`) now carries a `federated` boolean. The Profile tab uses it to disable the email field and show a note pointing to the Security tab, where the linked account can be reviewed or unlinked; this is a UX aid only; the server-side rule above is what actually enforces the lock.

## 2.0.0-alpha.12

### Minor Changes

- c5f243a: Admins now see a non-blocking warning banner (on every wiki page and in `/admin/plugins`) when the currently selected storage or search driver is missing configuration it needs to actually work — such as the S3 bucket name, or the Elasticsearch/OpenSearch cluster URL — so misconfiguration is caught before it causes an upload or search failure instead of only surfacing as a 500 later.

  - New `CrowiPlugin.readiness` SDK declaration lets a plugin state which of its own config fields must be set once a specific driver is selected; `@crowi/plugin-storage-aws-s3` (`bucket`), `@crowi/plugin-search-elasticsearch`, and `@crowi/plugin-search-opensearch` (`url`) declare it.
  - New admin-only `GET /admin/plugins/readiness` endpoint reports only the plugin name, its admin placement, and the unset field names — never the actual config value, URL, or any secret.
  - The wiki header and the `/admin/plugins` list link straight to the affected plugin's config screen; saving the missing field clears the warning on the next refetch.
  - Non-admins never see the banner and never trigger the readiness request.

### Patch Changes

- d4342cd: Requesting an email address change now cancels any earlier change still awaiting confirmation, and a confirmation link no longer works while the account is suspended. Previously the only way a pending change stopped being confirmable was the address actually changing or the requesting session being revoked — so a change requested from a stolen session could not be called off by asking for a different address, and suspending an account did not stop a link issued beforehand from moving the address that account recovers through.
- 8b42663: Security dependency updates. `hono` moves to `4.13.0` (the declared floor is now `^4.12.34`, the first release without GHSA-advisory-affected versions) — for `@crowi/plugin-api` this also raises its `hono` peer range, so a plugin pinning an older 4.12.x will need to move up. Transitively, `undici` 7.x reaches `7.29.0` and `ip-address` reaches `10.4.0`, both within their existing parents' ranges. No `pnpm.overrides` entries were needed for any of these.
- f6a3ffe: Enforce a single, shared username validation contract across self-registration, invite acceptance, and first-admin (installer) creation.

  Username input is now restricted to ASCII letters, digits, `_`, and `-`, 1-64 characters, matching what the `@mention` renderer already recognizes. Previously each of the three account-creation forms validated username with a different (and looser) rule, and the `User` model itself did not validate the field at all — so an empty, whitespace-only, or otherwise malformed username could reach the database and break the `/user/<username>` page namespace. Non-conforming values are now rejected with the existing `400 VALIDATION_ERROR` response before any account is created or activated. Installer account creation, which previously also allowed `.` in usernames, now uses the same rule as the other two forms. Existing usernames already stored in the database are left untouched — this only applies to new or changed usernames.

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

- 4736e06: `GET /user/{username}` now returns `likesCount` and `commentsCount` alongside the existing `createdPagesCount` / `bookmarksCount` — the number of pages the target user has liked and the number of comments they have written, computed via `countDocuments` on the indexed `Page.liker` / `Comment.creator` fields. These are the target user's own actions, not activity their pages received from others, and are not re-filtered by the viewer's grants.

  `GET /pages/list` now returns a top-level `total`: the exact, viewer-visible count of the full (unpaginated) listing, computed with the same match conditions as the page rows themselves and shared across every branch (root, path prefix, `user=`, `/trash`/`include_deleted`). `total` excludes whatever `portalPage` / `contentPage` already excludes from `pages`, so the two never disagree, and stays constant across `offset`/`limit`. `PagerSchema` is unchanged — `total` is a new sibling field, mirroring `ListUsersResponseSchema.total`.

- 7a7394f: Make `renderedAst` a client-agnostic typed contract (RFC-0023). Renderer producers (shiki, KaTeX, Mermaid, PlantUML, link cards, placeholders) now stamp typed sidecar data onto the byte-identical `html` nodes they already emit, and clients that declare `X-Crowi-Ast-Version: 1` receive a validated `{astVersion, root}` envelope in which those nodes are projected into typed nodes (`code` with themed tokens, `math`/`inlineMath` with TeX source, `crowiDiagram` with intrinsic dimensions, `crowiLinkCard`, `crowiPlaceholder`) — the foundation for native (non-HTML) rendering such as the iOS app. Requests without the header — including the web, permanently — keep receiving the stored bare mdast Root verbatim, so existing clients and open tabs are unaffected. Responses now also carry `renderedAstArtifactKey`, which fixes a web bug where a pending diagram that finished rendering (or a freshness-mismatch recompute) was not re-drawn on refetch because the render memo only keyed on the revision id. Operators: this release bumps the renderer pipeline to 1.0.0 and removes the missing-version freshness special case — run the new `crowi-admin rebuild rendered-ast` (real writes) immediately after deploying, and use `--dry-run` only before that; see the admin guide's "rebuild rendered-ast" section for the rollout and completion procedure.

## 2.0.0-alpha.10

### Patch Changes

- 8a5433c: Fix four presence (live "who's viewing this page") consistency bugs.

  Viewer membership is now refcounted per WebSocket connection instead of per user, so closing one tab of a multi-tab/multi-replica session no longer makes the user vanish from the viewer list while a sibling tab is still open — only the last connection leaving actually removes them. Viewer-list broadcasts now carry a monotonically increasing per-page generation number (a backward-compatible additive field on the `viewers` WebSocket message) so an old, out-of-order snapshot can never overwrite a newer one on the client. Navigating between pages no longer flashes the previous page's viewer list (including their identities) on the next page's first render. Finally, when the server fails to register a viewer (e.g. a transient Redis error) it now closes the WebSocket so the client's existing reconnect logic recovers, instead of leaving the connection open with a permanently stale viewer list.

## 2.0.0-alpha.9

## 2.0.0-alpha.8

### Major Changes

- f1bcd2b: The canonical attachment URL (`/api/v2/attachments/:id`) now serves a display-optimized derivative (resized to at most 1728px wide, metadata stripped) for JPEG/PNG/WebP images whenever one is available, falling back transparently to the original for every other case (SVG/GIF/animated images, images already within the target width, or a missing/failed derivative). This is a real response-content contract change on an existing, unversioned endpoint: clients that relied on this URL always returning byte-identical originals (e.g. right-click "Save image as…" on an embedded image) now get the optimized bytes instead. `AttachmentSchema` gains a new `originalUrl` field (propagating to `AttachmentMetaSchema`/`AddAttachmentResponseSchema`) pointing at the new `GET /api/v2/attachments/:id/original` endpoint, which always serves the unmodified original and requires the `attachments:read` scope. The attachment detail modal's preview/download links were updated to use `originalUrl`. Operators can backfill/repair/reclaim derivatives for existing attachments with the new `crowi-admin rebuild attachment-display-derivatives` command (`--dry-run`/`--force`/`--repair-missing`/`--gc`).

### Minor Changes

- d9eb1c0: `GET /pages/children` now optionally returns `lastUpdatedAt` and `updater` on each `PageChildSegment`: for a segment that is itself a page, its own last-updated timestamp and updater; for a portal-style segment, the most-recently-updated page in its subtree and that page's updater. Both fields are additive and optional, so existing clients (the web sidebar tree) keep working unchanged; the iOS page list is the first consumer.
- 29b3679: Seed a trusted first-party `crowi-ios` OAuth client (RFC-0016 Phase 0) alongside the existing `crowi-cli` one. The redirect-uri validator now accepts an exact-match custom URI scheme (`crowi-ios://callback`) only for clients that are both `trusted` and first-party — every other client, including `crowi-cli`, keeps the existing http(s)/loopback-only behavior unchanged. A new public `GET /oauth/client-info` endpoint exposes a client's non-secret metadata (`clientId` / `name` / `firstParty` / `trusted`), and the web `/oauth/authorize` consent screen uses it to auto-approve trusted clients (skipping the consent card) while leaving the flow for every other client, including `crowi-cli`, exactly as it was.
- a32204f: Absorb the emoji shortcode transform and the `@[card](url)` link-card embed directly into `@crowi/api` core — both are now always-on Markdown features and no longer need to be installed as separate renderer plugins. The `@crowi/plugin-renderer-emoji` and `@crowi/plugin-renderer-link-card` packages have been removed from the workspace entirely; they are no longer published.

  Link-card OGP fetching is controlled by a new admin Security setting, "Allow link cards for external URLs" (default ON, matching the previous plugin-installed behaviour and GitHub/Slack/Notion-style link unfurling). Disabling it stops all new outbound OGP requests immediately — including bypassing the render cache entirely, so a card fetched while enabled is never served stale after a disable, and a disable never leaves a cached fallback behind after a re-enable — and every render that cannot show a real preview (a disabled toggle, a fetch failure, a blocked/air-gapped host) now shows the exact same non-error-styled fallback card (a plain link to the original URL) instead of the old dedicated error-card variant.

  Operators upgrading with `@crowi/plugin-renderer-emoji` or `@crowi/plugin-renderer-link-card` still listed in `crowi.config.json` (or their npm packages still listed as a runner dependency) see a one-time boot warning instead of a hard failure — remove the two entries (and the matching `dependencies`) once convenient; they no longer do anything, and the packages no longer exist to install.

  `@crowi/plugin-api`'s `EmbedRenderer` gains an optional `shouldBypassCache(input)` hook — a renderer whose output depends on a runtime policy toggle (like link-card's) can use it to skip the render cache entirely for a given dispatch instead of only checking the toggle inside `render()`, which would otherwise let a stale cache hit serve pre-toggle output.

- 3b27a67: Add a "Subpages" tab to the user page.

  `/user/<username>` now has a third footer tab, "Subpages", listing every page that actually exists under `/user/<username>/` (recursively, across all depths), regardless of who created it — distinct from the existing "Pages" tab, which lists pages this user created regardless of path. The preview shows up to 10 rows plus the total count, with a "View all" link to `/user/<username>/pages` for the full, paginated listing (30 per page). Visibility follows the same grant/status rules as every other page listing.

  Also hardens draft creation (`POST /pages/drafts`): if the seed revision fails to save after the draft `Page` document was created, the orphaned `Page` is now compensating-deleted so it can no longer resurface as a permanently broken row in listings such as the new Subpages tab.

### Patch Changes

- a899fdd: Fix a correctness hole where a live collaborative editor open before a page was renamed, soft-deleted, or reverted could still save its content afterwards, silently clobbering the renamed/deleted state instead of being rejected.
  The fix introduces a monotonic collab lifecycle epoch (`Page.collabLifecycleVersion`) that advances atomically with every rename/delete/revert/body-replace and is enforced at four boundaries — wsToken mint, WebSocket authentication, document load, and the atomic save compare-and-set — so a stale editor session is refused rather than allowed to overwrite the page, including across multiple api replicas.
  Rename/delete now also opens the existing reload-prompt dialog on any live editor for that page, and soft/hard delete purge the page's collaborative editing state (Yjs snapshot and pending updates) as defense-in-depth.
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

## 2.0.0-alpha.7

### Minor Changes

- 134de8b: `GET /app/info`'s `capabilities` field is now documented and validated as a closed `Capability` enum (`STATIC_CAPABILITIES` + the three runtime-detected tags `search` / `collab` / `collab:redis`) instead of a generic `string[]`, in both the exported Zod schema and the generated OpenAPI spec. `@crowi/api-contract` exports the new `Capability` type, `CapabilitySchema`, and `DYNAMIC_CAPABILITIES` / `ALL_CAPABILITIES` constants alongside the existing `STATIC_CAPABILITIES`. The `@crowi/api` handler's internal `buildCapabilities()` now returns `Capability[]`, so its literals are compiler-checked against this same vocabulary and the handler and the wire schema can no longer silently drift apart.

  `apiVersion` intentionally stays a plain `string` (not narrowed to a `"v2"` literal): the `@crowi/cli` end-user CLI parses `app/info` with a lenient, partial schema parse to implement its WARN-ONLY version-skew note, and a literal type there would make that parse reject the whole response — not just the mismatched field — the moment a future server advertises a different API surface version, silently defeating the very warning it exists to produce.

- 8ff0e64: Narrow the plugin SDK's trust boundary: remove `ctx.crypto` and gate `ctx.model()` behind a declared allow-list.

  BREAKING (`@crowi/plugin-api`): `PluginContext.crypto` (and the `PluginCrypto` type) is removed. It exposed the same global `CROWI_ENCRYPTION_KEY`-derived encrypt/decrypt used for core's sensitive Config and every other plugin's `@sensitive` fields, so any installed plugin could decrypt any other plugin's or core's secrets. No first-party plugin used it — the legitimate way to read a plugin's own `@sensitive` config values is unchanged: `ctx.config<T>()` already returns them transparently decrypted.

  `ctx.model(name)` now requires the plugin to declare the model in a new `CrowiPlugin.modelAccess?: string[]` field (same shape as `requires`). Calling `ctx.model()` for an undeclared model throws `Plugin '<name>' called model('<requested>') but did not declare it in 'modelAccess'.` A model listed in `modelAccess` still gets full (unrestricted) read/write access — there is no read-only mode yet. `PluginManager.activate()` validates every declared model name against the registered core models at boot and fails loudly (isolating just that plugin, same as a bad `configSchema`) on an unknown name.

  `GET /admin/plugins` now includes each plugin's declared `modelAccess` in `PluginInfo`, so an admin can audit which plugins touch which core collections.

  The four first-party plugins that call `ctx.model()` (`@crowi/plugin-search-elasticsearch`, `@crowi/plugin-search-mongo`, `@crowi/plugin-search-opensearch`, `@crowi/plugin-slack`) now declare their actual (read-only) usage: `['Page', 'Bookmark', 'User']` for the ES/OpenSearch drivers, `['Page', 'Revision']` for the Mongo driver, `['Page']` for Slack.

- d697e26: Isolate a single plugin's boot-time failure so it no longer takes the whole server down with it.

  `PluginManager.bootstrap()`'s activation loop and `mountPluginRoutes`'s `registerRoutes` loop previously had no per-plugin try/catch, unlike the existing `runReconfigure`/`deactivate` lifecycle paths — a plugin that threw during `activate()` (a bad `registerStorage`, a failing `onInstall` migration, ...) or during `registerRoutes` (an exception while building its HTTP routes) took the entire boot down, leaving even the admin UI unreachable for disabling it. Both loops are now isolated per plugin: an `activate()` failure logs `[crowi:plugin:<name>] activation failed; plugin disabled: <message>`, excludes that plugin from `PluginManager.getLoadedPlugins()`/`getLoadedPlugin(name)`, and is recorded in the new `PluginManager.getFailedPlugins()`; a `registerRoutes` failure logs `[crowi:plugin:<name>] registerRoutes failed; this plugin's HTTP routes are not mounted: <message>` but leaves the plugin's driver registrations (and its `getLoadedPlugins()` membership) intact, since activation itself already succeeded. `GET /admin/plugins` now includes failed plugins with `status: 'failed'` and their error message (successful plugins get `status: 'active'`), and the admin plugin list shows an "Activation failed" badge for them. Deliberately out of scope for this change: rolling back a partially-completed `activate()` call's earlier `register*` calls, and a hard-fail path for plugins that provide an implicit-default driver (`storage.driver: 'local'` / `search.driver: 'mongo'`) — every plugin is isolated the same best-effort way for now.

- fa5023f: `GRANT_RESTRICTED` ("Anyone with the link") pages now actually work like a link-share invite. Opening a restricted page's id URL (`/<page._id>`, and the revived legacy `/_r/<page._id>` short link) via `IdRedirector` adds the visitor to the page's `grantedUsers` on first visit, so a follow-up direct visit to the page's real path — or from the list/search — no longer 404s. Previously `GRANT_RESTRICTED` behaved like `GRANT_SPECIFIED` for anyone who hadn't already been added, silently breaking the promise made by the link-share popover. A permanent banner now appears at the top of a `GRANT_RESTRICTED` page (hidden for wip/deprecated/draft/stale-revision views, where the link wouldn't actually be claimable) that honestly states sharing the URL below invites the recipient as an editor, with a copy-to-clipboard control and no dismiss option.

  The grant-on-first-access write is confined to a new `POST /pages/link-access` endpoint called only by `IdRedirector`: it is web-session only (OAuth/PAT tokens are rejected before the per-user rate limiter counts them), rate-limited at 30 req/min/user, and atomic (a concurrent grant change or soft-delete can never be raced into an invite). `GET /pages?page_id=` and every other by-id caller (`/_edit`, `/_attachments`, comment/bookmark/watch helpers) are unchanged — visiting those does not grant access.

  Also fixes a search-index visibility gap surfaced while implementing this: search results could include stale hits for soft-deleted / redirect-stub pages, and the Elasticsearch/OpenSearch drivers now exclude `wip` / `deprecated` pages from the index (matching list visibility) instead of leaving them as permanent dead hits.

### Patch Changes

- 8631cc3: Enforce page permissions on `GET /backlinks`.

  The endpoint now grant-checks the target `page_id` before listing its backlinks, returning 404 (hiding existence) to callers who cannot read the page — previously any authenticated user could probe the existence and link graph of a private page by id. Each `fromPage` in the response is now also grant-checked individually and dropped if the caller cannot read it, the same way hidden-draft `fromPage`s already were. The route gains a `404` response in its contract.

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

- 86a9fb0: Enforce page permissions on comment read and delete.

  `GET /api/v2/comments` now grant-checks the owning page (resolved from `page_id`, or from the revision's page for `revision_id`) before returning comment bodies, and returns 404 (hiding existence) to callers who cannot read the page. Previously any authenticated user could read the comments of any private page or revision by id. `DELETE /api/v2/comments` now also verifies the target comment actually belongs to the supplied `page_id`, so a user granted on one page can no longer delete a comment on a page they cannot access by passing a mismatched id. The comment list route gains a `404` response in its contract.

## 2.0.0-alpha.5

### Minor Changes

- Add the admin plugin-config `@action` schema so plugin manifests can declare action buttons that the admin auto-form renders and executes.

## 2.0.0-alpha.2

### Minor Changes

- 4d66883: Fix the HTML-tag handling in headings / TOC and recover the close-tag corruption the earlier `wikilink-format` migration could introduce.

  - **`wikilink-format` close-tag clobber fix**: the deprecated presentational tags `font` / `center` / `marquee` / `blink` / `applet` are now treated as known HTML elements, so `</font>` etc. are no longer mistaken for v1 angle-bracket wikilinks and rewritten to `[[/font]]`. No new corruption can occur.
  - **`wikilink-html-recover` preflight migration**: reverts bodies already mangled into `[[/<x>]]` back to `</x>`, scoped to exactly those five deprecated tags (the only names the misfire could have produced). Genuine single-segment wikilinks — including ones named after standard HTML elements such as `[[/section]]` / `[[/div]]` — are preserved. A `[[/font]]` is left untouched when a live (published, non-redirect) page literally named `/font` exists, and reported for manual review instead.
  - **Clean TOC anchors + labels, with no data rewrite**: heading anchor ids are slugged from the HTML-stripped heading text, so in-page anchors are clean and `id == href`; the TOC label strips inline HTML at display time using the same shared helper. Stored `meta.toc[].text` and page bodies are left raw (as authored) — nothing is migrated — and re-saving a page upgrades its anchor hash to the clean slug. A literal `<` in heading text (`## price < 100`) or an unknown tag-like token (`## Using List<int> in C#`) is preserved verbatim.

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

## 2.0.0-alpha.1

### Minor Changes

- 0e9a07c: Extend the public `GET /api/v2/app/info` response with a version-skew /
  feature-detection signal: `version` (the running server version), `apiVersion`
  (`"v2"`), and `capabilities` (a coarse list of exposed subsystems — the
  always-on set plus dynamically-detected ones such as `search` when a search
  driver is active and `collab` / `collab:redis`). The existing `title` /
  `confidential` fields are unchanged, and clients that ignore the new fields keep
  working. This is the signal the `crowi` end-user CLI reads to tolerate version
  drift across self-hosted instances.

## 2.0.0-alpha.0

### Major Changes

- ea2b7db: Remove the external-share admin feature (admin/share endpoints, app:externalShare config, UI surface). The feature will return as a plugin.

  This is a breaking change: the `GET`/`PUT /api/v2/admin/share` endpoints are
  unregistered (now 404), the `app:externalShare` config seed key is removed, and
  the `externalShare` field is dropped from the `/admin/app` response schema. The
  `/admin/share` page and its admin sidebar entry are gone. Page link-sharing
  (LinkSharePopover / `page.share.*`) and the dormant Share / ShareAccess models
  are kept untouched.

- ee935ad: Remove Google/GitHub social-login scaffolding (config seeds, /me googleId/githubId fields, profile + admin coming-soon surfaces). The admin auth toggles disablePasswordAuth/requireThirdPartyAuth are now inert (hidden in the UI and rejected with 400) since third-party sign-in is gone; they will be reactivated when social login returns as a plugin.

### Minor Changes

- 8d8e04d: Surface the confidentiality notice (`app:confidential`) in the app header. The
  public `GET /app/info` response now includes a `confidential` field, and the
  authenticated web shell renders the operator-set text as an always-on marker:
  a compact muted-amber label in the header's right cluster on desktop (which
  yields while the global search box is focused so the search can expand), and a
  thin centered line directly under the header on mobile where the right cluster
  has no room. The notice is hidden entirely when unset. This makes screenshots
  and printouts visibly carry the confidentiality marker, satisfying corporate
  IT requirements.
- c7443c4: Add a "Create page" modal to the header. Previously the only way to make a
  new page was to navigate to an unknown path by hand. The modal lets you
  build a `/`-rooted path with Tab-cycle completion against existing pages:
  Tab/Shift+Tab cycle through prefix-matching paths (shallowest first) and
  write the choice straight into the input, so you can keep typing to reach
  the path you want. Paths that already exist are flagged and can't be
  re-created; submitting opens the create-mode editor for the new path.

  Backed by a new `anchor=prefix` mode on `GET /pages/autocomplete` so the
  completion list only contains true prefixes of what the user has typed.

- ce294dd: Rebuilt the Markdown editor on CodeMirror 6 and brought back the two-column live preview. The `/_edit` page now uses a dedicated viewport-width layout — editor on the left, preview on the right (Tabs toggle on narrow widths) — and the preview follows typing with a 250ms debounce. The preview goes through the server-side renderer pipeline (`POST /api/v2/pages/preview`), so it renders via the same mdast → React path as page display, making the editing and saved views look identical.

  `MarkdownEditor` is implemented as a controlled component (`value` / `onChange` / `readonly` / `extraExtensions`). The `extraExtensions` slot is the foundation for injecting the `yCollab` extension in the future realtime collab work (RFC-0003).

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

- 637f0c9: Add a left rail mirroring the right-rail table of contents (same width,
  sticky offset, and breakpoint). Its shared top section — Top / My page /
  Members / Notifications, plus an Admin shortcut for administrators — shows
  on every page so it no longer disappears on non-wiki routes; full-bleed
  routes (editor / history) opt out, and the member directory and the
  `/me`, `/trash`, OAuth, and `_`-prefixed routes show the nav links
  without a tree.

  Below it, the current path's ancestry renders as a single expanded tree,
  identical for list (portal) and content pages: each ancestor level lists
  its sibling directories and the branch toward where you are opens one
  level deeper, down to the current node — a content page is highlighted
  among its siblings, a portal directory is highlighted and expanded so its
  own children show below it. The directory you're in always renders as a
  labelled node (viewing `/crowi/rfc/0002` surfaces `rfc/` rather than a
  bare page list). Navigating to an ancestor portal keeps the surrounding
  tree in place instead of collapsing to its children. Portal directories
  carry a compass icon.

  A user space (`/user/{username}/…`, including the my-page / bookmarks /
  created-pages routes) is topped with that user's home as a node — their
  avatar (uploaded image, else a generated fallback) — and roots there with
  no "⤴", since the roster is reached from the nav links; the member
  directory itself is never shown as a tree node.

  Backed by a new `GET /pages/children` endpoint that aggregates the
  immediate child segments under a path server-side (respecting page grant
  and draft visibility), returning the complete first-level set rather than
  a paginated slice.

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

- 97e6543: Introduce a shared error-code contract so the server returns stable identifiers and the web app localizes them.

  `@crowi/api-contract` now ships an `ErrorCode` ledger (`ERROR_CODES` / `ErrorCodeSchema` / `type ErrorCode`) and `ApiErrorSchema.error.code` is typed as `ErrorCodeSchema` instead of a free-form string. Every modern Hono handler now returns an `ErrorCode`, so the API can only emit known codes, and the web app maps each code to a paraglide message through an exhaustive `Record<ErrorCode, MessageFn>` — adding a code without a localization is a compile error. The me and public auth forms (login / register / reset-password / invite accept) route their error display through this helper, so localized copy replaces the raw English server message. Because `@crowi/api-contract` is in a linked group, `@crowi/api` and `@crowi/web` bump together. Mail i18n (recipient `User.lang`) is unchanged, and the legacy `status:'error'` envelope is left as-is.

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

- 4594ad2: Notifications are now driven solely by explicit page watchers, and participating in a page auto-subscribes you.

  Previously the notification audience for comments / likes was an implicit set (the page creator plus everyone who had ever commented or edited the page) unioned with explicit WATCH watchers. A one-time editor of a page they did not watch could therefore keep receiving notifications and could only stop by explicitly ignoring the page.

  The audience is now exactly the explicit `WATCH` watchers, minus `IGNORE` opt-outs, minus the acting user, minus inactive users. To keep the effective reach the same while making it controllable, participation now materialises a real watcher row:

  - Creating a page or saving a new revision auto-watches the acting user. This covers both HTTP saves and realtime (collab) saves, which flow through the same page-save event.
  - Commenting auto-watches the commenter. The add-comment response now returns `newlyWatching: boolean`; when it is `true` the web UI shows a one-shot "you're now watching this page" hint with a stop-watching action.
  - An existing `IGNORE` row is always respected — auto-watch never flips an opt-out back to watching.
  - Liking a page does not auto-watch.

  `getWatchStatus` now reports watch state purely from the presence of a watcher row (the previous derive-from-implicit-set fallback is removed), so the watch toggle is the single source of truth. No schema change; existing pages are not backfilled (auto-watch applies to new activity going forward).

### Patch Changes

- 9c55f6c: Fix other users' draft pages leaking into the page list. The `include_deleted` query param used `z.coerce.boolean()`, which is JS `Boolean(v)` — so the string `"false"` (how the web client serialises `false` on the query string) coerced to `true`. That flipped `include_deleted` on for every listing request, making the server skip the draft/status visibility filter and return drafts owned by anyone, not just the viewer. The param now parses the string explicitly so only `"true"` / `true` is truthy.
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
