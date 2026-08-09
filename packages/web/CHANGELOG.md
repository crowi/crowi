# @crowi/web

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

- 21044fc: Fix plugins disappearing from the admin sidebar. A plugin whose `adminPlacement.section` named a section the sidebar has no heading for — `auth` or `notification`, both of which the plugin contract allows — was dropped instead of placed, leaving its settings page reachable only by typing the URL. Auth-provider plugins hit this by default, since the section is inferred from `registerAuth`. Such entries now fall back to the general settings group. Google and Slack also get their real logos in the sidebar and, for Google, on the sign-in button, replacing the generic key and share glyphs.
- d3350be: Security fix: the `crowi.accessToken` mirror cookie — written so headerless `<img src="/api/attachments/...">` requests can authenticate without an `Authorization` header — is now scoped to `path=/api/attachments` instead of `path=/`. Previously the browser attached this cookie to every same-origin request (pages, admin, every other API route); now it is only sent to the three attachment-delivery routes it exists for.

  `storeTokens` and `clearTokens` also explicitly expire any pre-existing `path=/` cookie from a prior deploy, so upgrading clients don't retain a stray root-scoped copy of the token across login, silent refresh, or logout.

- 0b62bc0: An account with one or more linked federated identities (Google, or any other configured provider — RFC-0014) can no longer move its own email address through `PUT /me`. The address on a federated account was verified by the identity provider at sign-in; letting the holder of a stolen `profile:write` credential (a leaked personal access token or OAuth grant) redirect the confirmation link to an address they control would hand the account's recovery identifier away. A request that submits a different email now fails with `400 EMAIL_LOCKED_BY_FEDERATED_IDENTITY` and applies nothing from that request — name and language changes sent in the same request are not saved either, so the outcome is all-or-nothing. Resubmitting the current, unchanged address still saves name/language normally, and accounts with no linked identity are completely unaffected — the confirm-by-email flow behaves exactly as before.

  The profile response (`GET /me` and `PUT /me`) now carries a `federated` boolean. The Profile tab uses it to disable the email field and show a note pointing to the Security tab, where the linked account can be reviewed or unlinked; this is a UX aid only; the server-side rule above is what actually enforces the lock.

- Updated dependencies [9a06104]
- Updated dependencies [0b2656a]
- Updated dependencies [0b62bc0]
  - @crowi/api-contract@2.0.0-alpha.13

## 2.0.0-alpha.12

### Minor Changes

- 5d5fa9a: Close the auth cookie-fallback gap RFC-0019 §7.5 flagged and scope `/mcp` to Personal Access Tokens only, so a JSON-RPC API and non-attachment routes can no longer be reached with just an ambient browser cookie.

  BREAKING (`@crowi/api`): `createJwtAuth`'s cookie fallback (the `crowi.accessToken` cookie, previously accepted whenever the `Authorization` header was missing OR unparseable) is now header-only for every consumer except attachment delivery — admin, `/pages/*`, `/auth/me`, `/auth/logout`, the protected `/oauth/*` routes, `/search`, and every plugin route registered with the default `auth: 'user'` tier. A request that used to succeed via a stray or forged `crowi.accessToken` cookie with no (or a malformed) `Authorization` header now gets a `401 AUTHENTICATION_REQUIRED`; a normal browser session, which always sends the header from `localStorage`, is unaffected.

  BREAKING (`@crowi/api`): the `crowi.accessToken` cookie fallback is now accepted ONLY on `GET`/`HEAD` for the three headerless attachment delivery routes — `/attachments/:id`, `/attachments/:id/original`, and `/attachments/by-key/*` (plus the `/files/:id` redirect target) — matching exactly the `<img src>` / direct-navigation shape the cookie exists for. Every other attachment route (upload, meta, delete, add) now requires the header.

  BREAKING (`@crowi/api`): `/mcp` is now Personal Access Token (PAT) only. A web-session Bearer token, the `crowi.accessToken` cookie, and an OAuth access token (`oauth_access`) are all rejected with a JSON-RPC `401` — MCP previously rode the same shared auth as the rest of the API and accepted any of those. This is a deliberate defense-in-depth narrowing ahead of RFC-0022's resource/audience-bound OAuth support; once that lands, a properly scoped `oauth_access` token will be accepted again.

  `@crowi/web`'s `apiFetch`, `useAddAttachment`, the editor's paste/drag-and-drop upload, and the admin plugin-action button no longer send a request with no `Authorization` header when the access token is missing — they recover it through the existing refresh flow first, and fail closed (the existing session-expired handling) instead of depending on the ambient cookie a normal page load already sends.

- c5f243a: Admins now see a non-blocking warning banner (on every wiki page and in `/admin/plugins`) when the currently selected storage or search driver is missing configuration it needs to actually work — such as the S3 bucket name, or the Elasticsearch/OpenSearch cluster URL — so misconfiguration is caught before it causes an upload or search failure instead of only surfacing as a 500 later.

  - New `CrowiPlugin.readiness` SDK declaration lets a plugin state which of its own config fields must be set once a specific driver is selected; `@crowi/plugin-storage-aws-s3` (`bucket`), `@crowi/plugin-search-elasticsearch`, and `@crowi/plugin-search-opensearch` (`url`) declare it.
  - New admin-only `GET /admin/plugins/readiness` endpoint reports only the plugin name, its admin placement, and the unset field names — never the actual config value, URL, or any secret.
  - The wiki header and the `/admin/plugins` list link straight to the affected plugin's config screen; saving the missing field clears the warning on the next refetch.
  - Non-admins never see the banner and never trigger the readiness request.

### Patch Changes

- df8fbea: Fix the admin user list becoming unclickable after closing a dialog opened from a row's action menu — resetting a password, editing a user, or changing an email address left the whole page unresponsive behind an invisible overlay, with a reload the only way out.
- Updated dependencies [d4342cd]
- Updated dependencies [c5f243a]
- Updated dependencies [8b42663]
- Updated dependencies [f6a3ffe]
  - @crowi/api-contract@2.0.0-alpha.12

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

- 5d9c379: The "New page" button on the drafts page now opens the shared create-page modal instead of expanding a bare path field. The modal completes the path against existing pages as you type, which the plain input could not do, so the two entry points no longer offer different levels of help for the same task.
- 5ee250d: Enlarging a diagram (PlantUML, Mermaid) now scales it up to fill the lightbox instead of showing the same-sized picture in a wider box. Diagrams larger than the lightbox still open at full size and scroll, so wide sequence diagrams stay readable.
- Updated dependencies [ce69b4a]
- Updated dependencies [4736e06]
- Updated dependencies [7a7394f]
  - @crowi/api-contract@2.0.0-alpha.11

## 2.0.0-alpha.10

### Minor Changes

- ec999f5: Add an MCP setup guide to the user settings page, and rename the tab that holds it from "Security" to "Password / API tokens / MCP" so its contents are discoverable from the tab strip.

  The new "MCP setup" card sits between the password form and the personal access tokens list, mirroring the order a user actually follows: issue a PAT (noting that a write scope is what lets the AI create and edit pages), then register the server. It shows the instance's own `/api/v2/mcp` endpoint (resolved from `NEXT_PUBLIC_API_URL` or the browser origin, so it is correct for both same-origin and split-host deployments) and copy-pasteable registration snippets for both Claude Code (`claude mcp add --transport http …`) and the Codex CLI (`codex mcp add … --bearer-token-env-var`, plus the equivalent `~/.codex/config.toml` block), each with its own verification step and a link to the MCP operations documentation.

- c771334: Rework live presence on narrow screens into a dedicated card, and stop treating a brief reconnect as "presence is gone".

  Below 768px, "who is viewing this page right now" used to be a `[👁 N]` chip above the title — which sat awkwardly close to the historical `[👁 N] Seen` chip below the title, two different facts wearing the same icon and number. It is now a dedicated card placed directly under the statistics chips, so the mobile header reads title → author/updated → statistics → live presence → body. The card shows up to three overlapping avatars plus `+N`, a plain-language count that includes you ("5 viewing now" / 「5 人が現在閲覧中」), and a connection indicator that is readable from its text rather than colour alone. The whole card is one tap target opening the same viewer sheet as before, and the 60px compact header keeps a short `Live · N` trigger. Wide-viewport headers are unchanged.

  The card also collapses away entirely when you are the only person present and expands smoothly when someone joins, compensating your scroll position so the body text never jumps while you are reading. On the connection side, the client now distinguishes an automatic reconnect that is still being retried from a connection that has terminally failed: during a retry the card stays put in a neutral "Reconnecting…" state showing the viewers it last knew about, instead of vanishing on every momentary network blip, and the green `Live` indicator only appears once viewer updates have actually arrived on the current connection.

### Patch Changes

- 0af3af0: Fixed the trash page list (`/trash/...`) double-decoding legacy `+`-joined path segments, which could mangle deleted pages whose name used the `+`-as-space URL convention.
- 8a5433c: Fix four presence (live "who's viewing this page") consistency bugs.

  Viewer membership is now refcounted per WebSocket connection instead of per user, so closing one tab of a multi-tab/multi-replica session no longer makes the user vanish from the viewer list while a sibling tab is still open — only the last connection leaving actually removes them. Viewer-list broadcasts now carry a monotonically increasing per-page generation number (a backward-compatible additive field on the `viewers` WebSocket message) so an old, out-of-order snapshot can never overwrite a newer one on the client. Navigating between pages no longer flashes the previous page's viewer list (including their identities) on the next page's first render. Finally, when the server fails to register a viewer (e.g. a transient Redis error) it now closes the WebSocket so the client's existing reconnect logic recovers, instead of leaving the connection open with a permanently stale viewer list.

- Updated dependencies [8a5433c]
  - @crowi/api-contract@2.0.0-alpha.10

## 2.0.0-alpha.9

### Patch Changes

- b4a6d8e: Fix Mermaid diagrams rendering as invisible (0×0) on both the saved page view and the live editor preview.

  Three independent root causes, all fixed:

  - Mermaid's generated SVG declares `width="100%"` with no absolute height (only a `viewBox`), giving the base64-embedded `<img>` no resolvable intrinsic size once placed inside the diagram wrapper's `inline-block` element (whose own width is itself `auto`, sized from its content) — the two collapsed to 0×0. The renderer now derives `width`/`height` attributes from the sanitized SVG's own `viewBox` and adds them to the emitted `<img>` tag.
  - The page view and editor preview's `img:` markdown component overrides were both dropping any `width`/`height` a renderer plugin declared instead of forwarding them to the rendered `<img>` element, silently discarding the fix above.
  - Gantt charts specifically rendered with a corrupted, negative-width layout (not just invisible) — traced to Mermaid's Gantt renderer falling back to a 0px layout width because jsdom's `offsetWidth` (used by this plugin's isolated render-worker) always returns `0` rather than `undefined`, so Mermaid's own `undefined`-only fallback never activated. The render worker now sets Mermaid's `gantt.useWidth` config explicitly to sidestep that measurement entirely.

  Existing pages with a Mermaid diagram saved before this fix keep serving their previously-rendered (invisible) markup until next edited and saved — this matches how this renderer's cache versioning has always behaved for schema changes.

  - @crowi/api-contract@2.0.0-alpha.9

## 2.0.0-alpha.8

### Minor Changes

- 708c0d5: Add `@[card](url)` link-card embeds with editor affordance.

  New core `@[card](url)` embed tag (`registry.addEmbedTag(name, renderer)` embed-tag registration seam, RFC-0002; a later release folded the original `@crowi/plugin-renderer-link-card` plugin implementation directly into `@crowi/api` as a core-reserved embed tag and removed the plugin package, see the emoji/link-card core-absorption changeset). Writing `@[card](url)` fetches the target page's OGP meta tags (`og:title` / `og:description` / `og:image` / `og:site_name`) and renders a title / description / domain / image preview card. A page with no `og:image` renders as a text-only card; a fetch failure (timeout, non-2xx, blocked, bad scheme, oversized response) degrades to the unified fallback card (see the emoji/link-card core-absorption changeset) — a plain link to the original URL, with no OGP fields and no error-red styling. The fetch is SSRF-guarded (rejects private / loopback / link-local / unique-local / metadata addresses, whether specified directly, via DNS resolution, or via a redirect target — each of up to 3 manual redirect hops is re-validated), time-capped at 5s, size-capped at 512KB, and concurrency-capped at 5 simultaneous fetches. `og:image` is always linked directly to the source site (no proxying or caching).

  The web editor gains a hover/focus affordance that converts a bare `http(s)://` URL to `@[card](url)` and back, leaving an already-labelled `[label](url)` link untouched.

- d680c0c: Add server-side Mermaid diagram rendering (RFC-0002 Phase 6.1).

  New `@crowi/plugin-renderer-mermaid` plugin: ` ```mermaid ` fenced code blocks are rendered entirely server-side in an isolated, network-denied child process (no client-side Mermaid JS ever ships to the browser) and embedded as a sanitized, base64-encoded SVG `<img>`. Supports flowchart, sequence, class, state, ER, journey, pie, and git-graph diagrams, with a shared, independently-tested DOM-based SVG sanitizer (new, private `@crowi/svg-sanitize` package) that also replaces `@crowi/plugin-renderer-plantuml`'s previous regex-only sanitizer. No operator configuration is required, and existing pages keep rendering their `mermaid` fences as plain code blocks until the author explicitly re-saves them.

  The editor's live preview now renders Mermaid diagrams as you type, not just after saving: a new `previewPolicy` opt-in on `CodeBlockRenderer` lets a renderer participate in non-persistent preview rendering (page-less, no cache writes), gated by the same per-user admission-control concurrency limits and priority scheduling used for saved-page rendering, plus a per-user rate limit on the preview endpoint and proper request cancellation when a newer keystroke supersedes an in-flight preview.

  The page-view diagram wrapper (click-to-enlarge, cap-to-width, dark-mode-neutral surface) is generalized from PlantUML-only to any diagram renderer, so Mermaid diagrams get the same affordance PlantUML diagrams already had.

- a32204f: Absorb the emoji shortcode transform and the `@[card](url)` link-card embed directly into `@crowi/api` core — both are now always-on Markdown features and no longer need to be installed as separate renderer plugins. The `@crowi/plugin-renderer-emoji` and `@crowi/plugin-renderer-link-card` packages have been removed from the workspace entirely; they are no longer published.

  Link-card OGP fetching is controlled by a new admin Security setting, "Allow link cards for external URLs" (default ON, matching the previous plugin-installed behaviour and GitHub/Slack/Notion-style link unfurling). Disabling it stops all new outbound OGP requests immediately — including bypassing the render cache entirely, so a card fetched while enabled is never served stale after a disable, and a disable never leaves a cached fallback behind after a re-enable — and every render that cannot show a real preview (a disabled toggle, a fetch failure, a blocked/air-gapped host) now shows the exact same non-error-styled fallback card (a plain link to the original URL) instead of the old dedicated error-card variant.

  Operators upgrading with `@crowi/plugin-renderer-emoji` or `@crowi/plugin-renderer-link-card` still listed in `crowi.config.json` (or their npm packages still listed as a runner dependency) see a one-time boot warning instead of a hard failure — remove the two entries (and the matching `dependencies`) once convenient; they no longer do anything, and the packages no longer exist to install.

  `@crowi/plugin-api`'s `EmbedRenderer` gains an optional `shouldBypassCache(input)` hook — a renderer whose output depends on a runtime policy toggle (like link-card's) can use it to skip the render cache entirely for a given dispatch instead of only checking the toggle inside `render()`, which would otherwise let a stale cache hit serve pre-toggle output.

- 3b27a67: Add a "Subpages" tab to the user page.

  `/user/<username>` now has a third footer tab, "Subpages", listing every page that actually exists under `/user/<username>/` (recursively, across all depths), regardless of who created it — distinct from the existing "Pages" tab, which lists pages this user created regardless of path. The preview shows up to 10 rows plus the total count, with a "View all" link to `/user/<username>/pages` for the full, paginated listing (30 per page). Visibility follows the same grant/status rules as every other page listing.

  Also hardens draft creation (`POST /pages/drafts`): if the seed revision fails to save after the draft `Page` document was created, the orphaned `Page` is now compensating-deleted so it can no longer resurface as a permanently broken row in listings such as the new Subpages tab.

### Patch Changes

- 284bb9a: Keep preview content visible near the end of documents when editor and preview line heights differ.
- 5ff7a04: Fold unchanged lines by default in the page history revision diff, GitHub-style: only the changed lines (with 3 lines of surrounding context) render, and unchanged regions collapse behind a click-to-expand indicator. A new toggle next to the existing split/unified view button switches to showing every line, including unchanged context, and back. Comparing two identical revisions now shows a plain "no changes" message instead of a diff container.
- a775598: Fix the editor image display-attribute affordance showing two stacked panels over the same image. When the caret sat inside an image's Markdown while the mouse also hovered it (e.g. right after clicking the markup to edit it), the hover trigger and the cursor trigger each rendered their own identical panel. The hover trigger now yields to the (stable) cursor trigger on the same image span, and if a hover panel is already open when the caret enters that span it closes so only one panel remains. A hover panel for a different image is left untouched.
- 91537b4: Editor image display-attribute affordance: the `align` / `float` controls now show icons instead of the text labels `align: left` … `float: right`. The `align` icons depict where the image box sits within the frame; the `float` icons depict an image box with text wrapping around it, so the effect is recognisable at a glance. The former text label is preserved as each button's hover tooltip and accessible name (`aria-label`), and the selected-state highlight is unchanged. Separately, floated images now always clear at the next section heading (`#`–`######`) in both page view and the editor preview, so a heading no longer wraps alongside a preceding floated image.
- a207caa: Fix the mobile page-actions menu's share item, which was mislabeled "Title + URL" while silently copying just the bare URL with no confirmation or way to grab the title/Markdown variants.

  It's now labeled "Copy URL" and opens the same share panel as the desktop link-share popover in a modal: the id URL is still auto-copied the instant it opens (with the "URL Copied!" confirmation), and the panel also offers "Title + URL" and Markdown rows with their own copy buttons — matching the desktop experience exactly, since both surfaces now share one panel component.

- c447269: Bump `next` 16.2.6 → 16.2.11 to clear 9 Dependabot security advisories
  (alerts #638-#664, 3 manifest locations × 9 advisories: `packages/web/package.json`,
  `apps/crowi-site/package.json`, `pnpm-lock.yaml`), all patched in 16.2.11 per
  GitHub's advisory data (vulnerable range `>=16.0.0, <16.2.11` for each):

  - Denial of Service in App Router using Server Actions
  - Middleware / Proxy bypass in App Router applications using Turbopack and single locale
  - Unauthenticated disclosure of internal Server Function endpoints
  - Denial of Service in the Image Optimization API using SVGs
  - Server-Side Request Forgery in rewrites via attacker-controlled destination hostname
  - Unbounded Server Action payload in Edge runtime
  - Cache confusion of response bodies for requests with bodies containing invalid UTF-8 byte sequences
  - Cache confusion of response bodies for requests with bodies
  - Server-Side Request Forgery in Server Actions on custom servers

  Direct dependency bump in both consumers (`@crowi/web`, `@crowi/site`), no
  override needed. No code changes required; type-check/test/build green for
  both packages.

- b953a17: Fixed `GET /.well-known/oauth-authorization-server` returning a 500 in self-hosted production. `next.config.ts`'s `rewrites()` used to proxy that path to an absolute API URL that gets frozen into `routes-manifest.json` at `next build` time for `output: 'standalone'` builds; since the Docker image never sets that build-time URL, it always baked in the dev fallback (`http://localhost:4301`), and nothing listens on that port inside the production web container. `next.config.ts` is now exported as a phase-gated function so this rewrite is only included for `next dev` (where the destination is evaluated fresh from the environment each time the dev server starts, so it always stays correct); production builds no longer carry it at all, so web never attempts to proxy this path itself.
- 1a4d883: Stop the presence WebSocket from reconnecting every ~4.5 minutes. The presence token is a handshake-only credential — the server never re-verifies it once a connection is established — so the old proactive `refetchInterval` that re-minted it before every expiry only tore the live socket down and re-broadcast the viewer list to every viewer of the page, for no auth benefit. The token query now holds a single token for the connection's whole life (matching the collab editor's token hook), and recovery from a genuinely expired token (a 4401 close) goes through an explicit token invalidate with capped exponential backoff instead of the removed timer.
- 785f0bd: Improve link-card editing with a single conversion action near the active editor position and a clear, static preview card before metadata is fetched on save.
- 7819e03: The editor/preview scroll sync now uses a "sliding reference" alignment instead of always pinning the matched line at the viewport top. As you scroll toward the end of the document (the common state while appending text), the alignment point slides down toward the viewport bottom, so the freshly-rendered end of a taller preview stays visible instead of being pushed off-screen. Scrolling to the very top still aligns both panes' tops exactly as before, and the transition in between is continuous — no sudden jump at any point while scrolling either pane.
- b6feef8: Fix editor↔preview scroll sync jumping backwards and then snapping at the end of a document. Source-line anchors are only injected on top-level block starts, so every line after the last anchor (a trailing list's remaining items, a trailing paragraph's continuation lines, and the editor's bottom padding) collapsed onto that anchor's position. The sliding-reference alignment then moved the preview UP as the editor scrolled DOWN, and the endpoint pin closed the accumulated gap as one visible jump. The line-to-position mapping now extends to the true document edges, so the preview tracks the editor monotonically and reaches the bottom continuously.
- Updated dependencies [d9eb1c0]
- Updated dependencies [a899fdd]
- Updated dependencies [f1bcd2b]
- Updated dependencies [29b3679]
- Updated dependencies [a32204f]
- Updated dependencies [b0e2c76]
- Updated dependencies [3b27a67]
  - @crowi/api-contract@2.0.0-alpha.8

## 2.0.0-alpha.7

### Minor Changes

- 1625e85: Markdown images now support a Pandoc-style attribute block right after the image: `![alt](url){width=60% align=center}`. Supported keys are `width` / `height` (a number followed by `%` or `px`, within sane bounds) and `align` (`left`/`center`/`right`) / `float` (`left`/`right`, wins over `align` when both are set). A standalone image (nothing else in its paragraph) renders as a `<figure>` so `align`/`float` apply; an image followed by more text stays inline and only `width`/`height` apply. Any out-of-range or unrecognised value is simply dropped instead of breaking the page, and a plain `![alt](url)` with no attribute block renders exactly as before.

  The new server-side transform is bundled into the core renderer pipeline (`RENDERER_PIPELINE_VERSION` 0.7.0 → 0.8.0), and the web renderer re-validates every display attribute by value — not by trusting the `data-crowi-image-*` attribute names — so the same rules apply whether they came from the Markdown transform or were hand-written as raw HTML. The editor also gained a hover/focus tooltip on image spans for setting width/align/float without typing the `{...}` syntax by hand; it respects read-only mode (including the realtime-collab editor cap being reached mid-session). Uploading an attachment via paste/drag-and-drop/the insert button still emits a plain image with no attributes by default.

- fa5023f: `GRANT_RESTRICTED` ("Anyone with the link") pages now actually work like a link-share invite. Opening a restricted page's id URL (`/<page._id>`, and the revived legacy `/_r/<page._id>` short link) via `IdRedirector` adds the visitor to the page's `grantedUsers` on first visit, so a follow-up direct visit to the page's real path — or from the list/search — no longer 404s. Previously `GRANT_RESTRICTED` behaved like `GRANT_SPECIFIED` for anyone who hadn't already been added, silently breaking the promise made by the link-share popover. A permanent banner now appears at the top of a `GRANT_RESTRICTED` page (hidden for wip/deprecated/draft/stale-revision views, where the link wouldn't actually be claimable) that honestly states sharing the URL below invites the recipient as an editor, with a copy-to-clipboard control and no dismiss option.

  The grant-on-first-access write is confined to a new `POST /pages/link-access` endpoint called only by `IdRedirector`: it is web-session only (OAuth/PAT tokens are rejected before the per-user rate limiter counts them), rate-limited at 30 req/min/user, and atomic (a concurrent grant change or soft-delete can never be raced into an invite). `GET /pages?page_id=` and every other by-id caller (`/_edit`, `/_attachments`, comment/bookmark/watch helpers) are unchanged — visiting those does not grant access.

  Also fixes a search-index visibility gap surfaced while implementing this: search results could include stale hits for soft-deleted / redirect-stub pages, and the Elasticsearch/OpenSearch drivers now exclude `wip` / `deprecated` pages from the index (matching list visibility) instead of leaving them as permanent dead hits.

- 30bd5df: Add a fullscreen expand affordance for Markdown tables on the page view.

  Every table (GFM or raw HTML) now gets a small, always-present "Expand table" button in a toolbar row above it — low-opacity by default, full-opacity on hover/focus, and always full-opacity on touch (coarse-pointer) devices, since discoverability without hovering was the whole point on mobile. Clicking it opens the same table at near-fullscreen size in a Radix `Dialog`, with both horizontal and vertical scrolling, so wide or tall tables are far easier to read on small viewports. The table itself is mounted in exactly one place at a time (inline or in the dialog), so `id` attributes and `url(#id)` SVG references inside a table never collide or break. This is a page-view-only change — the editor preview's table rendering is untouched.

### Patch Changes

- 8631cc3: Enforce page permissions on `GET /backlinks`.

  The endpoint now grant-checks the target `page_id` before listing its backlinks, returning 404 (hiding existence) to callers who cannot read the page — previously any authenticated user could probe the existence and link graph of a private page by id. Each `fromPage` in the response is now also grant-checked individually and dropped if the caller cannot read it, the same way hidden-draft `fromPage`s already were. The route gains a `404` response in its contract.

- 484c4d7: Fix the CodeMirror markdown editor's list Tab/Shift-Tab indent width and Backspace behavior. Tab/Shift-Tab now indent or dedent a nested list item by exactly one nesting level (2 spaces for `- `, 3 for `1. `) regardless of how deeply the item is already nested — previously the indent width grew with the item's existing indentation, so nesting under a level-1 item added 4 spaces instead of 2. When marker kinds mix (an ordered parent with a bullet child, or an ordered list whose digit count changes, e.g. `10.` nesting `9.`), Tab/Shift-Tab now use the marker width of the item actually being nested under or dedented from, instead of the current item's own marker width, which previously produced malformed indentation or left a stray space on dedent. Backspace at a list item's content start (right after the marker) or at a blockquote's content start now always deletes exactly one character; it no longer intermittently strips the marker/quote or snaps the content to the parent's column depending on how the current indentation happened to parse. As a result, Enter's tight list continuation is now active in production (it was previously shadowed by an upstream binding), and pressing Enter mid-list in an ordered list correctly renumbers the following items instead of leaving a duplicate number.
- c863808: Page viewing now self-heals when the live push channel misses an update: a viewer's tab going hidden then visible again, the presence socket reconnecting after a sleep/network drop, and a 3-minute background timer all trigger a reconcile against the server's current head, catching up on any save that happened while disconnected — the previous push-only sync could permanently miss updates made while a tab was backgrounded. A save made from another tab or device by the viewer themself now also swaps in silently (no banner) instead of never appearing, and losing read access while viewing a page now switches the view to the access-denied state automatically instead of leaving the protected content on screen.
- ef8e05b: Fix Markdown tables collapsing into a one-character-per-line column on narrow (mobile) screens when a cell holds a long unbroken token such as a file path or identifier — the table now keeps its column structure and scrolls horizontally within its existing wrapper instead, matching GitHub / Claude Code table behaviour. The fix is scoped to table cells only (`th`/`td`); ordinary paragraph and list text keeps wrapping long tokens exactly as before, and it applies equally to GFM `|...|` tables and raw HTML `<table>` written directly in the page body.
- d697e26: Isolate a single plugin's boot-time failure so it no longer takes the whole server down with it.

  `PluginManager.bootstrap()`'s activation loop and `mountPluginRoutes`'s `registerRoutes` loop previously had no per-plugin try/catch, unlike the existing `runReconfigure`/`deactivate` lifecycle paths — a plugin that threw during `activate()` (a bad `registerStorage`, a failing `onInstall` migration, ...) or during `registerRoutes` (an exception while building its HTTP routes) took the entire boot down, leaving even the admin UI unreachable for disabling it. Both loops are now isolated per plugin: an `activate()` failure logs `[crowi:plugin:<name>] activation failed; plugin disabled: <message>`, excludes that plugin from `PluginManager.getLoadedPlugins()`/`getLoadedPlugin(name)`, and is recorded in the new `PluginManager.getFailedPlugins()`; a `registerRoutes` failure logs `[crowi:plugin:<name>] registerRoutes failed; this plugin's HTTP routes are not mounted: <message>` but leaves the plugin's driver registrations (and its `getLoadedPlugins()` membership) intact, since activation itself already succeeded. `GET /admin/plugins` now includes failed plugins with `status: 'failed'` and their error message (successful plugins get `status: 'active'`), and the admin plugin list shows an "Activation failed" badge for them. Deliberately out of scope for this change: rolling back a partially-completed `activate()` call's earlier `register*` calls, and a hard-fail path for plugins that provide an implicit-default driver (`storage.driver: 'local'` / `search.driver: 'mongo'`) — every plugin is isolated the same best-effort way for now.

- Updated dependencies [134de8b]
- Updated dependencies [8631cc3]
- Updated dependencies [8ff0e64]
- Updated dependencies [d697e26]
- Updated dependencies [fa5023f]
  - @crowi/api-contract@2.0.0-alpha.7

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

- 95f7862: Fix an unthrottled reconnect loop against `GET /notifications/token` that occurred whenever `WS_TOKEN_SECRET` was left unset (a supported single-instance configuration): the server now reuses one random fallback signing secret per process instead of minting a new one on every call, and the browser now applies capped exponential backoff to repeated invalid-token WebSocket closes as a defense-in-depth safeguard against the same failure mode in other configurations (e.g. a `WS_TOKEN_SECRET` mismatch across instances).
- Updated dependencies [86a9fb0]
- Updated dependencies [8533d15]
- Updated dependencies [715c25d]
  - @crowi/api-contract@2.0.0-alpha.6

## 2.0.0-alpha.5

### Patch Changes

- Version bump to stay in lockstep with the fixed `@crowi/api` / `@crowi/api-contract` group (no `@crowi/web` code change).

## 2.0.0-alpha.4

### Patch Changes

- c840f8b: Centralize the web client's auth state on a single React Query source so session changes propagate consistently across the whole UI.

  Logging out — or a session expiry / a logout in another tab — now wipes the entire client cache, so signing in as a different user afterwards never shows the previous user's pages, notifications, or other cached data. A logout in another tab also propagates to the current tab, which navigates to the login screen instead of staying on a stale authed view; re-logging in as a different account in another tab likewise swaps the current tab over to the new user.

  Re-authenticating inline in the editor (the session-expiry modal) now restores the signed-in user immediately instead of leaving the header empty, and if another tab logs out while the editor holds an unsaved buffer, the current tab opens the inline re-auth modal in place rather than redirecting and discarding the buffer. Authenticated reloads and transient server (5xx) blips at startup no longer flash the header into a "logged out" state.

## 2.0.0-alpha.2

### Minor Changes

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

- 7315b1a: PlantUML diagrams now stay within the article width instead of overflowing the
  column (and dragging the page wider than the viewport). Hovering a diagram
  reveals a `+` affordance, and clicking it opens a near-full-screen lightbox that
  shows the diagram at natural size with scroll/pan, so wide sequence diagrams
  stay readable. Applies on both the page view and the editor preview, for the SVG
  embed and the PNG fallback.
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

- 4c45f41: Fix the page becoming unclickable after closing a rename or delete dialog
  opened from an actions ("...") menu — on a page, and on items/folders in page
  lists. A modal Radix dropdown and a modal Radix dialog each toggle
  `pointer-events: none` on `<body>`; when the dialog opened as the menu closed,
  their add/remove races left the style stuck on `<body>`, blocking all clicks.
  Those menus are now non-modal, so only the dialog manages body pointer-events
  and it is cleaned up correctly on close.
- 7315b1a: Stop iOS Safari from zooming the viewport when focusing the page search box or
  the editor. A theme-level rule now enforces a 16px minimum font-size on all
  editable surfaces (inputs, textareas, selects, contenteditable, and the
  CodeMirror editor) on iOS only, so every current and future mobile screen is
  zoom-safe without per-component overrides. Non-iOS sizing is unchanged.
- b51b611: Fix the page-history list not refreshing after an edit or a revert. Revision
  creating mutations (page update, revert-to-revision) now invalidate the
  `['revisions']` query, so a newly-pushed revision shows up in `/_history`
  immediately instead of being hidden behind the 60s default React Query
  `staleTime` until a full browser reload.
- cd0d9f8: Fix portal edits not appearing after save. Saving a portal and returning to it
  kept showing the pre-edit body: the post-save cache invalidation refreshed the
  single-page detail query (`['page']`) but not the list/portal family
  (`['pages']`) that the portal view is rendered from. Both save paths (the
  realtime `crowi:save` flow and the HTTP `useUpdatePage` fallback) now share one
  `invalidatePageContentQueries` helper that refreshes the page detail, the
  list/portal + sidebar family, page history, and drafts together, so the
  invalidation set can no longer drift between them.
- 10faee9: Rename dialog: when it opens, pre-select just the page name (the last path
  segment) instead of placing the cursor at the end. You can immediately retype
  the leaf without disturbing the parent path — the same affordance as renaming a
  file in an editor. Parent folders and the trailing slash of folder paths stay
  unselected.
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
  major upgrades respectively; tracked in TODO.md.

- Updated dependencies [4d66883]
- Updated dependencies [20556ca]
- Updated dependencies [065cda0]
- Updated dependencies [3e58ee8]
  - @crowi/api-contract@2.0.0-alpha.2

## 2.0.0-alpha.1

### Minor Changes

- 470269f: Make the web Docker image runtime-configurable so a single `crowi/crowi-web`
  image can target any api without a rebuild — for both same-origin and
  cross-origin topologies.

  **Same-origin (reverse-proxy, default):** the browser always talks to relative
  paths (`/api/v2`, `/files/...`) on its own origin, and the Next server's
  `rewrites()` proxy forwards them to the api at the runtime-injected
  `CROWI_API_URL` server env (read at boot, not baked into the client bundle).
  WebSocket endpoints (collab / presence / notifications) derive their URL from
  `window.location` by default, so realtime works same-origin with no build-time
  URL bake. The Dockerfile no longer accepts a `NEXT_PUBLIC_API_URL` build-arg.

  **Cross-origin (split web/api hosts):** `NEXT_PUBLIC_API_URL` /
  `NEXT_PUBLIC_COLLAB_URL` are now read at runtime via `next-runtime-env`
  (`<PublicEnvScript />` in the root layout injects the operator's start-time env;
  the client reads it instead of a build-time-inlined value). A single image can
  therefore be pointed at any api origin (HTTP + WS) just by setting those env
  vars at container start — no rebuild required. The api side needs `CLIENT_URL`
  set to the web origin for CORS (documented in the deployment topologies guide).

  `NEXT_PUBLIC_API_URL` is still honored as a dev / Vercel build-time fallback, so
  `pnpm dev` and Vercel deployments are unchanged. Env-unset deployments keep the
  previous same-origin behavior (relative paths + `window.location` WS).

### Patch Changes

- 0e51181: Fix the page breadcrumb overflowing the viewport on mobile. A deep page path
  previously ran off the right edge of narrow screens, leaving the trailing
  ancestors clipped and unclickable. The breadcrumb now collapses the middle
  ancestors behind a `…` dropdown below the `md` breakpoint — keeping Home, the
  first level, and the immediate parent on a single line, with the hidden levels
  still reachable from the dropdown. From `md` up the full trail keeps rendering
  inline, so desktop is unchanged.
- ea3f255: Always redirect to the installer when the instance is not yet installed. The
  `InstallerGate` previously rendered the requested page (login / register /
  wiki) while the install-status check was still loading and even while the
  redirect to `/installer` was in flight, so a fresh, not-yet-installed instance
  would briefly show a usable-looking login form. The gate now holds back the
  page behind a loading state until the status is known and only reveals
  `children` once the instance is confirmed installed (or the user is legitimately
  on `/installer`). A per-origin "installed" flag is cached so already-installed
  instances skip the gate on subsequent loads without an extra round-trip.
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

- Updated dependencies [0e9a07c]
  - @crowi/api-contract@2.0.0-alpha.1

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
  rename API rejects it with 400 PAGE*INVALID_NAME (mirroring the existing
  delete guard). The guard covers every route into a rename: the single-page
  rename (source and destination — a page can't be moved \_onto* a home path
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
