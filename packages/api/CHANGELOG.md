# @crowi/api

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
