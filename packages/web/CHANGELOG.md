# @crowi/web

## 2.0.0-alpha.0

### Minor Changes

- 7f77407: Restructure the admin sidebar into clearer sections. User management now sits
  directly under Settings, followed by a new "Shared services" position, then
  Storage / Mail / Notifications. Two new sections were added: "Search" (holds
  the search index page and search-backend plugins such as Elasticsearch) and
  "Renderers" (holds renderer plugins such as PlantUML). The Authentication entry
  moved into the Settings section (just under Security), and the Backlinks entry
  was removed from the admin UI (rebuilding backlinks is now an `crowi-admin` CLI
  operation). Plugins are auto-placed by their registered hook: `registerSearch`
  → Search, `registerRenderer` → Renderers.
- 22050f6: Profile picture upload now opens a crop dialog: you pick a square region (drag to reposition, slider to zoom), and only the cropped image — downscaled to 256×256 and re-encoded (WebP, PNG fallback) on the client — is uploaded. Previously the originally selected file was sent as-is, so a multi-megapixel phone photo would upload at full size. The API contract is unchanged (same multipart `file` field).
- c7443c4: Add a "Create page" modal to the header. Previously the only way to make a
  new page was to navigate to an unknown path by hand. The modal lets you
  build a `/`-rooted path with Tab-cycle completion against existing pages:
  Tab/Shift+Tab cycle through prefix-matching paths (shallowest first) and
  write the choice straight into the input, so you can keep typing to reach
  the path you want. Paths that already exist are flagged and can't be
  re-created; submitting opens the create-mode editor for the new path.

  Backed by a new `anchor=prefix` mode on `GET /pages/autocomplete` so the
  completion list only contains true prefixes of what the user has typed.

- 3147560: Redesigned `/me/creating-pages` (pages in progress) from its information architecture up. Drafts are unpublished triage targets — the layout now prioritises answering "is this still live work?" and "keep it or discard it?" at a glance, so the row structure and actions were rebuilt.

  - Two-line row layout: path (mono / link to the editor) on top, then created-at · last-edited-at. `updatedAt` was previously unused and is now surfaced, but is omitted right after creation (within 1 minute) where it would be redundant. `Page.updatedAt` is advanced by the Hocuspocus compaction store, so it keeps moving during Yjs editing.
  - Row-end actions are two icon-only ghost buttons (edit / cancel), cutting the row height down from the previous two labelled outline buttons.
  - The "start a new page" form changed from a heavy Card+Header+Description+Body structure to a lightweight inline panel toggled by a "+ New page" button in the header. This also removes the duplicated copy where the H1 subheading and the form description said the same thing twice.

  Body preview / character count was intentionally left out: a draft's body lives in the Hocuspocus Y.Doc / `Page.yjsState` as the source of truth, and `Page.revision.body` only reflects it on an explicit save. Reconstructing the Y.Doc from the listing could show it accurately, but the cost isn't worth it, so the two-line layout was kept.

- ce294dd: Rebuilt the Markdown editor on CodeMirror 6 and brought back the two-column live preview. The `/_edit` page now uses a dedicated viewport-width layout — editor on the left, preview on the right (Tabs toggle on narrow widths) — and the preview follows typing with a 250ms debounce. The preview goes through the server-side renderer pipeline (`POST /api/v2/pages/preview`), so it renders via the same mdast → React path as page display, making the editing and saved views look identical.

  `MarkdownEditor` is implemented as a controlled component (`value` / `onChange` / `readonly` / `extraExtensions`). The `extraExtensions` slot is the foundation for injecting the `yCollab` extension in the future realtime collab work (RFC-0003).

- aa6ced5: Rework the editor action layout. The Cancel button moves to a close (X)
  button in the editor's top-right corner, and a new page-settings button
  sits next to Save: it opens a bottom drawer that holds the page's
  visibility (grant) selector, which used to live in the header. The drawer
  is the home for any future per-page setting so the editor chrome stays
  uncluttered.
- a0a34f9: Editor quality-of-life for new pages. Creating a page now opens the editor
  ready to write: the editor auto-focuses and the caret lands on the blank
  line below a path-derived H1 title that is pre-filled for you. The title is
  derived so a daily note keeps its context — `/user/foo/memo/2026/06/08`
  seeds `# memo/2026/06/08`, while `/crowi/qa/rfc-0011-mcp-server` seeds
  `# rfc-0011-mcp-server`.

  Saving now leaves the editor and returns to the page view, which loads the
  revision you just saved instead of a stale cached copy — a freshly created
  page no longer briefly shows "page not found", and an existing page no
  longer shows its pre-edit content, on return.

- a804e1c: The `/_edit` page now uses a layout that fills the whole viewport, with the editing header and save footer pinned to the screen while the editor and preview each scroll independently inside.

  In addition, **bidirectional scroll sync** between editor and preview is implemented. Rather than legacy Crowi's simple proportional scrollTop, it syncs via fractional-line interpolation combining line + in-block offset ratio, so it follows continuously even inside long blocks like code fences or lists instead of snapping to the top of a line. The server embeds `data-source-line` on each top-level node of the preview mdast (`POST /api/v2/pages/preview`), and the web-side `useScrollSync` hook bridges those markers to CodeMirror's line-block info with linear interpolation. The editor → preview / preview → editor round-trip is a bijection, so the position doesn't drift as you move back and forth.

- bdd5426: Keep editors signed in when a session expires mid-edit instead of bouncing them to the login screen. When the access token lapses while editing a page, the app first tries a silent refresh using the still-valid refresh token, so in the common case nothing is shown and editing continues uninterrupted. Only when the refresh token has also expired does a non-dismissible re-login modal appear in place, letting the user re-authenticate without leaving the editor. Throughout, the in-progress Y.Doc and any unsaved input are preserved (the editor is never unmounted), and on recovery the collaborative connection, autosave, and presence all reconnect by refetching the short-lived collab/presence tokens. Re-authenticating in one browser tab also recovers every other open editor tab via a storage event, closing their modals and reconnecting them. The new-page (create) flow is out of scope and keeps its previous behaviour of redirecting to login.
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

- 24f1872: Fix the installer re-showing after a successful first-run install, and add post-install onboarding. Creating the first admin now signs them in, lands on `/admin` with a one-shot congratulations dialog, and shows a setup checklist (storage / search / mail / users). Logging in with no explicit `?continue=` target now lands on the user's own page (`/user/<username>`) instead of the site root.
- b071c9c: Redesigned the page list (the list page at trailing-`/` paths) for scannability. Each row is now a title-first two-line layout that brings the last path segment forward as the page name and groups the directory path, author, and updated time into a muted second line. Like / comment counts are right-aligned so they form columns, making cross-row comparison easy. A layout-matching skeleton is shown while loading.

  When a portal page exists, its body and page actions (rename / delete / like / bookmark / watch) are shown as before, marked with a "Portal" label.

  Added a renameTree UI to the rename dialog for moving the subpages underneath as a batch (subtree count display + move preview). Executing the batch move is guarded until the backend supports it; for now only a single page can be moved.

  Made the page-name display logic date-hierarchy aware. A path whose tail is consecutive numeric segments, like `/user/foo/diary/2026/05/23`, displays "2026/05/23" rather than "23" as the page name everywhere — in the list, the page-header H1, and the browser tab title. This is a faithful display-side expression of Crowi's path-based page-name design — the structure where `/diary/2026/` shows a per-year list and `/diary/2026/05/` a per-month one.

  Rewrote the user-profile "created pages" / "bookmarks" listings (the `/user/<name>` tabs, `/user/<name>/recent-create`, `/user/<name>/bookmarks`) on the same shared primitives as the list page (`PageRowsCard` / `PageRowsSkeleton` / `PageListSectionHeader` / `PageListEmptyCard` / `LoadMoreButton`), unifying the look of rows, card padding, skeletons, count display, and empty states. At the same time the default page sizes were raised — list 50 → 100, user listings 10 → 30 — to match the post-redesign density.

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

- 5fefe85: Add mobile search. The header search input is hidden below 768px, leaving
  phones / narrow tablets with no way to search. A search icon now sits next
  to the logo on those widths; tapping it opens a full-screen search surface
  — an auto-focused search bar pinned at the top with a results area filling
  the rest of the viewport (live suggestions while typing, recently-viewed
  pages when empty, and "see all results" / Enter to open the full search
  page).
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
  - **Authorization Code + PKCE** — `POST /oauth/authorize` (web-session only)
    - `POST /oauth/token` (authorization code with `S256`, or refresh-token
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

- f7446a0: Add copy affordances to page reading. Code blocks now show a GitHub-style
  copy button on hover (top-right) that copies the block's text. The page
  actions (dot) menu gains a "Copy markdown" item that copies the page's
  markdown source to the clipboard, with a toast on success.
- 8f12462: Add sorting to the directory / portal page listing. The list page now offers a sort control with three options — last updated, date created, and name — surfaced as a dropdown in the listing's section header.

  `GET /pages/list` gains optional `sort` (`updatedAt` | `createdAt` | `path`) and `order` (`asc` | `desc`) query parameters, defaulting to `updatedAt` descending so existing callers are unaffected. Sorting applies to the path and root listings; the per-user "created pages" listing keeps its own newest-authored-first order.

- faf5dd7: Render spaces in wiki page paths as `+` in the URL instead of the noisy
  `%20`, and read `+` back as a space — restoring the legacy Crowi
  convention. Visiting
  `/Weall/dev/infra/v0/mysql+connect+to+production+db` now opens the page
  `/Weall/dev/infra/v0/mysql connect to production db`, and every in-app
  link / navigation to a page with spaces (lists, search, backlinks,
  breadcrumbs, sidebar, notifications, rename / restore / delete redirects)
  produces the readable `+` form. Stored paths and the API are unchanged —
  the conversion happens only at the Next.js routing boundary, mirroring the
  server-side `[[wiki link]]` handling. As in legacy Crowi, a literal `+`
  cannot appear in a page path (it is always read as a space).
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

- e04ac03: Make the page view's 3-column layout degrade column-by-column instead of
  dropping both side rails at once. From 1440px up, the left navigation, the
  content, and the right TOC all show (content stays dead-centre as before).
  Below 1440px the left navigation hides but the content keeps its TOC.
  Below 1280px the right TOC rail collapses into a "目次" button in the page
  header (expanded and compact) that opens a popover with the same entries
  and scroll-spy highlight — and it stays available all the way down to
  mobile. The narrowest layout is otherwise unchanged.
- 1f20bee: Add a "Create Portal" CTA and a "What is Portal?" help dialog to portal-less folder paths. When a trailing-slash path (e.g. `/project/`) has no portal page yet, the page list now offers a way to create one (routing to the standard `/_edit?path=` create flow at the portal path), reproducing the legacy `page_list.html` "Create Portal" side button.

  A draft portal is no longer shown as the portal: it is visible only to its creator (RFC-0004) and has no committed revision to render (it showed a perpetual "Rendering…"). Instead, when the current user has a draft portal in progress here, the folder header shows a "portal in progress" notice with a "Continue editing" button into its draft editor; drafts owned by others fall back to the create CTA.

- 8f12462: Redesign portal pages (the document at a trailing-`/` path) as a folder entrance rather than a content page. Portals previously reused the full page header on top of the document's own markdown, which left two competing titles (the path-basename H1 and the document's `# heading`) and a wall of social metadata (the 0-count like / view / comment / backlink chips, plus the watch / bookmark / link-share toolbar) that read as noise on what is really a directory index.

  The portal now leads with a compact context strip: a breadcrumb overline ending in the current folder name, a "Portal" tag shown only when a portal document actually exists, and a single muted provenance line (updater + relative update time). Actions are slimmed to bookmark (kept as a visible button), edit, and a kebab menu that folds like / watch / copy-link in. The path-basename H1 is dropped — the portal document's own leading markdown heading stands as the single page title, and only when the body has no leading H1 does the folder name fall back in as the title.

- d33674c: Localize the public auth screens (en / ja).

  The sign-in, registration, and the new invite-accept / activate /
  password-reset / forgot-password / email-change-confirm pages had Japanese
  copy hardcoded in the components. Their titles, labels, buttons, and
  error/empty states now go through paraglide (`auth.*` messages) so they
  render in the viewer's language.

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

- da3d85e: Harden the web app against server outages, hung connections, and render
  exceptions so it no longer gets stuck on a permanent "Loading…" or a blank
  white screen.

  - `apiV2Fetch` (and the `refreshAccessToken` raw fetch) now carry an
    `AbortController` timeout (default 20s, overridable via
    `NEXT_PUBLIC_API_TIMEOUT_MS`). A hung response is aborted and surfaced as a
    network error instead of spinning forever. The timeout signal is composed
    with any caller-supplied `signal`, so existing react-query cancellation and
    user-initiated aborts keep working and are not misclassified as connection
    failures.
  - Added App Router error boundaries: `app/error.tsx` renders a themed error
    card with a reload action for route-segment render exceptions, and
    `app/global-error.tsx` provides a locale-independent fallback screen when the
    root layout itself throws.
  - Query errors are now aggregated into the existing `ConnectionProvider` via
    `QueryCache.onError`: network/timeout aborts raise the connection banner and
    5xx responses raise the server-error modal, while 401 stays delegated to the
    token-refresh interceptor. react-query retry is tuned to fail fast on 4xx and
    retry network/5xx a small number of times, so spinners resolve into a clear
    error state quickly.

### Patch Changes

- 4807001: Fix dark mode on the pre-auth screens (login / register / reset-password /
  installer). The selected segment of the theme and language toggles is a
  near-white pill, but its label used `text-foreground`, which turns white in
  dark mode and disappeared — it now uses a fixed dark colour. The animated
  backdrop also gained a dark-mode gradient (same brand hues, deeply darkened)
  so it no longer clashes with the dark auth card.
- e9bc1bf: Drop the "No comments yet." empty-state line on pages with no comments and
  instead invite the first comment via the textarea placeholder ("Write the
  first comment on this page..."). The placeholder reverts to "Write a
  comment..." once the page has at least one comment.
- e243a49: Stabilize the create-page modal layout. The modal is now top-anchored so
  the path input stays put around 40% of the viewport instead of drifting
  upward as the candidate list grows; the modal extends down toward the
  bottom (leaving a small gap) and the candidate list scrolls internally
  when there are many matches. Long candidate paths now truncate instead of
  overflowing the modal width.
- d774eb8: In the "this path is already taken / being created by …" draft conflict alert, the owner's name is now a link to their user page (`/user/<username>`), so you can reach out to them directly. Shared by the `/_edit?path=` create flow and the `/me/creating-pages` new-draft form.
- f3fdf10: Add an "Edit" button to the right of the draft-page notice so the author can
  jump straight into the editor (and publish on save) without hunting for the
  header edit action.
- 42344c1: Two editor UI fixes. The page-visibility dropdown no longer wraps its
  longest option ("anyone with the link") onto a second line — the menu now
  grows to fit each label on one line. And the full-screen editor no longer
  lets the page micro-scroll a few pixels at the footer: the editor column's
  reserved height now accounts for the page-grant accent strip under the
  header, so the layout fits the viewport exactly.
- 523bc5d: Soft-wrap long lines in the page editor. Lines previously overflowed off
  the right edge and required horizontal scrolling to read — painful on
  mobile in particular. The editor now wraps like a normal textarea so the
  whole line stays visible.
- 4a16a58: Render the revision-history page (`/_history`) at full viewport width. The
  shared `(auth)` layout caps content at `max-w-4xl`, which left the side-by-side
  revision diff too narrow — long lines wrapped and changes were hard to read. A
  dedicated `_history` layout now breaks out of that column (the same
  viewport-wide escape `_edit` uses), without pinning to the viewport height so
  the page still scrolls normally.
- a20c600: Added an icon indicator to GRANT_RESTRICTED ("anyone with the link") pages. Previously only SPECIFIED / OWNER were distinguished with a Lock icon, leaving RESTRICTED indistinguishable from public. A Link2 icon is now shown at the start of the row in PageListItem and in PageHeader (both expanded and sticky), visually separating "anyone the link was shared with can view" from "only listed users".
- f568734: Disallow renaming a user's home page (`/user/<username>`). Its path is bound
  to the username, so the rename action is hidden in the page menu and the
  rename API rejects it with 400 PAGE_INVALID_NAME (mirroring the existing
  delete guard). The guard covers every route into a rename: the single-page
  rename (source and destination — a page can't be moved _onto_ a home path
  either) and the folder/subtree move (a `/user/` subtree that would sweep in
  every home page is refused). Pages under the home (e.g.
  `/user/<username>/memo`) are unaffected.
- 0a7fd4f: Use the compass icon consistently to mark portal pages. Portal pages (paths ending in `/`) were flagged with three different icons depending on where they appeared — a folder in the page list and a document in the search results / recent-pages dropdown — while the portal header and "What is a portal?" dialog already used a compass. They now all use the compass, so a portal reads the same everywhere and matches the "Portal" sidebar label. The folder icon is kept only on the fallback header shown for folders that have no portal yet, so "has a portal" stays visually distinct from "no portal".
- 8fb4f36: Remove the non-functional "English (US)" / "English (UK)" entries from the
  profile language selector, leaving only the locales we actually ship messages
  for (English / 日本語). Existing users whose saved `lang` is a regional
  variant are shown "English" pre-selected.
- a6d0a2e: Render unrecognised inline HTML tags in a page body as the literal text the
  author typed, instead of silently dropping them. Writing something like `shows
"No <thing> yet" tooltip` previously rendered as `No  yet` — the markdown
  pipeline parsed `<thing>` into an empty unknown DOM element, which both vanished
  from the output and made React log "The tag <thing> is unrecognized in this
  browser…". Unknown raw-HTML tags are now escaped before rendering so they show
  verbatim; recognised HTML/SVG tags, custom elements, and shiki code-highlight
  markup are unaffected. Applies to both the page view and the editor preview.
- cf4f3e7: Fix one-way editor scroll sync in the page editor: scrolling the editor
  no longer failed to move the preview. The collaborative editor remounts
  its inner CodeMirror view (via `key`) once the realtime document becomes
  ready, producing a fresh scroll element. The scroll-sync hook had bound
  its editor→preview listener to the _original_ element and never
  re-bound, so after the ~100ms collab handshake that listener was dead
  (preview→editor kept working because it dereferences the live editor
  handle). The hook now re-binds when the editor view is recreated.
- dbc4b0a: Refine how portals appear in the sidebar tree. Directory rows now keep the
  folder icon and show a small portal marker after the name (e.g. `crowi/ ◎`)
  instead of swapping the leading folder icon for a compass. Draft (unpublished)
  portals no longer count as portals in the sidebar — a draft-only path is not
  shown at all, and a folder that merely has a draft portal shows as a plain
  folder without the marker.
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
