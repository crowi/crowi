# Crowi (Apple)

Native Apple client for [Crowi 2.0](https://crowi.wiki) — [RFC-0016](../../docs/rfcs/0016-ios-native-app.md).
A universal iPhone + iPad SwiftUI app (macOS-ready, not yet shipped) that
signs into and reads/edits multiple independent Crowi workspaces over
`/api/v2`, the same HTTP surface `@crowi/cli` (RFC-0012) and MCP (RFC-0011)
use.

> Status: **Phase 1 read surface (`feature-ios-phase1-read`)**.
> Phase 0 (`.feature-state/specs/feature-ios-phase0-gates.md`) scaffolded the
> repo layout and cleared the 3 GO/NO-GO gates (generator, redirect
> transport, renderer image path). Phase 1 workspace/auth
> (`feature-ios-phase1-workspace-auth`) built the multi-workspace shell:
> add-workspace (HTTPS gate → lenient `/app/info` probe → minimum-version gate
> → OAuth sign-in), per-workspace Keychain + SwiftData persistence, a
> single-flight refresh actor, and the Slack-style workspace switcher UI. This
> phase (`feature-ios-phase1-read`) fills in the actual read surface on top:
> native Markdown rendering (incl. `[[wikilinks]]`/`@mentions` in-app
> navigation), the §6.1 authenticated image loader wrapped in a per-workspace
> disk cache, the §6.2 scheme allowlist, the §6.3 confidential banner, a
> refreshed `/app/info` capability/confidentiality cache, per-workspace
> SwiftData read caches, and the adaptive page-tree/reader/search/history/
> profile UI. Bounded write (create/quick-edit/comment/engagement) is
> `feature-ios-phase2-write`, next.

## Why this directory has no `package.json`

`apps/apple/` is a **tooling island** (RFC-0016 §10): it is Xcode/SwiftPM's
project, not an npm package, and is deliberately excluded from
`pnpm-workspace.yaml`'s `apps/*` glob and turbo's task graph by simply never
having a `package.json` — `pnpm install` / `pnpm build` / `pnpm lint` never
see it, and turbo's task graph never includes it. Xcode/SwiftPM own this
build end-to-end; a separate, path-gated macOS CI job
(`.github/workflows/apple-ci.yml`) builds and tests it.

(The **carve-out is `package.json`-scoped, not path-scoped**: any `.ts/.js`
tooling file placed under `apps/apple/` — none exist today — would still be
reached by the repo's file-glob Biome/lefthook format/lint. Accepted, tracked
by RFC-0016 OQ-5; not this scaffold's concern.)

## Layout

```
apps/apple/
├── Crowi.swiftpm/              # the App package — MUST keep the `.swiftpm`
│   │                           #   extension (see "Why Crowi.swiftpm, not
│   │                           #   apps/apple/, is what you open" below)
│   ├── Package.swift           # the App manifest (`import AppleProductTypes`,
│   │                           #   Xcode-only — see "Two packages" below)
│   ├── Sources/CrowiApp/       # @main entry point + the adaptive shells:
│   │   │                       #   RootScene (workspace switcher ⇔ workspace,
│   │   │                       #   §9) / WorkspaceSwitcherView / AddWorkspaceView
│   │   │                       #   / WorkspaceHomeView (the read-surface's OWN
│   │   │                       #   NavigationSplitView ⇔ NavigationStack, nested
│   │   │                       #   one level in) / PageTreeView / PageReaderView
│   │   │                       #   / SearchView / RevisionHistoryView / ProfileView
│   │   │                       #   / RecentlyViewedView / ReadDestination
│   └── Support/AdditionalInfo.plist  # merged into the app's Info.plist —
│                               #   CFBundleURLTypes declares `crowi-ios`
├── CrowiKit/                   # plain SwiftPM library: client/auth/render
│   │                           #   logic, testable with the bare `swift` CLI
│   ├── Package.swift
│   ├── Sources/CrowiKit/
│   │   ├── openapi.json        # SYMLINK → ../../../../packages/api-contract/openapi.json
│   │   │                       #   (in-tree, never a pinned copy — RFC-0016 §5.1/§10)
│   │   ├── openapi-generator-config.yaml
│   │   ├── Workspace/           # WorkspaceOrigin/APIBaseURL newtypes (§3), the
│   │   │                       #   non-secret WorkspaceIndexStore (UserDefaults,
│   │   │                       #   OQ-2), WorkspaceStore (observable root),
│   │   │                       #   WorkspaceContext (the workspace-bound handle,
│   │   │                       #   §14 structural isolation — now also the
│   │   │                       #   factory for AppInfoCache/AuthenticatedAPIClient/
│   │   │                       #   WorkspaceImageLoader/WorkspaceImageDiskCache),
│   │   │                       #   AddWorkspaceFlow (HTTPS gate → lenient probe
│   │   │                       #   → version floor → sign-in), WorkspaceSession
│   │   │                       #   (bundles a WorkspaceContext's dependencies +
│   │   │                       #   the refreshed capability/confidential state
│   │   │                       #   behind one object for the read UI)
│   │   ├── Config/              # MinimumVersionFloor — the single placeholder
│   │   │                       #   floor constant (OQ-6)
│   │   ├── Auth/                # OAuthSignInFlow (real ASWAS + PKCE + discovery
│   │   │                       #   + token exchange, replacing the Phase 0
│   │   │                       #   GateASpike), KeychainTokenStore,
│   │   │                       #   RefreshCoordinator (single-flight actor),
│   │   │                       #   AuthenticatingMiddleware (the §5.1 auth
│   │   │                       #   transport wrapper — this phase's first real
│   │   │                       #   consumer, via AuthenticatedAPIClient),
│   │   │                       #   SignOutFlow
│   │   ├── Persistence/         # WorkspaceModelContainerFactory + SchemaVersionMarker
│   │   │                       #   (per-workspace SwiftData container, §7;
│   │   │                       #   `applyRestStateProtections` now takes a
│   │   │                       #   `confidential` param, §6.3/§7.2 escalation),
│   │   │                       #   WorkspaceReadCacheSchema (the @Model list +
│   │   │                       #   bumped schemaVersion, §7.3), and the six
│   │   │                       #   @Model read-cache types (CachedPage,
│   │   │                       #   CachedPageChildren, CachedBacklink,
│   │   │                       #   CachedComment, CachedRevisionSummary,
│   │   │                       #   CachedSearchResult)
│   │   ├── API/                 # gate B smoke + AppInfoLenient/StaticCapabilities
│   │   │                       #   (Phase 0/1) + AppInfoCache (the §5.2 refreshed
│   │   │                       #   cache) + AuthenticatedAPIClient (the §5.1
│   │   │                       #   auth-injected raw-fetch primitive every
│   │   │                       #   *Lenient decoder is built on) + one hand-
│   │   │                       #   written lenient decoder per read screen
│   │   │                       #   (Page/Search/Comments/BookmarkLike/
│   │   │                       #   Backlinks/Revisions/Profile)
│   │   ├── Images/              # gate C: WorkspaceImageLoader (the §6.1
│   │   │                       #   same-origin-Bearer + redirect-strip loader) +
│   │   │                       #   WorkspaceImageDiskCache (the §7.2 per-workspace
│   │   │                       #   disk-cache WRAPPER around it, implementing
│   │   │                       #   the 200-real/200-placeholder/500 (embedded) vs
│   │   │                       #   200-real/404/500 (avatar) trichotomies) +
│   │   │                       #   WorkspaceMarkdownImageProvider (the
│   │   │                       #   swift-markdown-ui ImageProvider, generalized
│   │   │                       #   over `WorkspaceImageFetching` so either the
│   │   │                       #   loader or the disk cache can back it)
│   │   └── Rendering/           # SchemeAllowlist (§6.2, the ONE shared allow-
│   │                             #   list entry point — consumed by BOTH the
│   │                             #   openURL link interceptor and
│   │                             #   WorkspaceImageLoader.fetch's own URL-rebase
│   │                             #   step, so a custom-scheme image is inerted
│   │                             #   before any network I/O too) +
│   │                             #   WikiLinkMentionPreprocessor (mirrors
│   │                             #   WIKILINK_RE/MENTION_RE, raw-body → private-
│   │                             #   pseudo-scheme CommonMark links, skipping an
│   │                             #   `@mention`/`[[wikilink]]`-shaped substring
│   │                             #   already inside an existing Markdown link's
│   │                             #   own label/destination) + WorkspacePageMarkdownView
│   │                             #   (composes both + the image provider via the
│   │                             #   renderer's own `\.openURL` seam) +
│   │                             #   ConfidentialBannerOverlay (§6.3 — non-
│   │                             #   scrolling, always-on, non-dismissible; the
│   │                             #   honest, banner-only v1 scope) +
│   │                             #   WorkspaceAvatarView (a small circular avatar,
│   │                             #   fetched through the SAME `WorkspaceImageFetching`
│   │                             #   conformer as every other embedded image —
│   │                             #   never a bare unauthenticated `AsyncImage`)
│   └── Tests/CrowiKitTests/
└── .gitignore                  # excludes .build/ (incl. the generated Swift
                                 #   client — build-time only, never committed)
```

### Why `Crowi.swiftpm`, not `apps/apple/`, is what you open

Open **`apps/apple/Crowi.swiftpm`** in Xcode (`open apps/apple/Crowi.swiftpm`
or `xed apps/apple/Crowi.swiftpm`) — never the `apps/apple/` folder itself,
and never double-click `Package.swift` directly (macOS's generic `open` on
the bare file opens it as a single untitled source document, not as a
project). Xcode only allows a `.iOSApplication` product (the
`AppleProductTypes` product this app's `Package.swift` declares) inside a
folder whose name ends in `.swiftpm` — this is Apple's "Swift Playground App"
package convention, not specific to Crowi. Opening the manifest from a
differently-named folder builds fine from the plain `xcodebuild -scheme` CLI
(verified — that is exactly what the objective gate command below does) but
fails to even open in Xcode's own project UI with **"iOS app products are
only permitted in Swift Playground packages"** (verified empirically during
Phase 0, discovered when opening the scaffold in Xcode's GUI for the first
time — the CLI gate alone does not catch this).

### Two packages, one reason: `AppleProductTypes` isn't parseable by the bare `swift` CLI

`Crowi.swiftpm/Package.swift` declares the `.iOSApplication` product (via
`import AppleProductTypes`) that makes this directory build as a real iOS app
— universal iPhone/iPad, iOS 17 floor, `CFBundleURLTypes` declaring the
`crowi-ios` scheme — **entirely from a `Package.swift`, no `.xcodeproj`
needed**. This only works inside Xcode's own SwiftPM integration: the bare
`swift build`/`swift test` CLI cannot even **parse** a manifest that imports
`AppleProductTypes` (`error: no such module 'AppleProductTypes'` — verified
directly during Phase 0). So `swift test` cannot run against this manifest
at all, ever, by construction — not a fixable bug.

All the shared, unit-testable logic therefore lives in **`CrowiKit/`**, a
plain local SwiftPM package with an ordinary manifest (no `AppleProductTypes`
import), which the App target depends on
(`.package(path: "../CrowiKit")`). `swift test` runs there.

## Objective gate commands (extraGates)

These are the exact, verified commands — copy-paste them, they are not
placeholders:

```bash
# from apps/apple/Crowi.swiftpm/ — builds the whole app (incl. CrowiKit + all
# SwiftPM deps) for the iOS Simulator destination.
xcodebuild build -scheme Crowi -destination 'generic/platform=iOS Simulator' -skipPackagePluginValidation

# from apps/apple/CrowiKit/ — unit tests for the shared client/auth/render
# logic. Also exercises the swift-openapi-generator build-tool plugin (a
# broken packages/api-contract/openapi.json fails this step).
swift test
```

**`-skipPackagePluginValidation` is required, not optional**, once a target
uses a SwiftPM build-tool **plugin** (here: swift-openapi-generator's). Xcode
normally shows an interactive "Trust and Enable" dialog the first time a
project uses a given plugin; a non-interactive `xcodebuild` invocation (any
CI runner, any scripted build) has no dialog to click and fails with
`Validate plug-in "OpenAPIGenerator" in package "swift-openapi-generator"`
without this flag (verified directly during Phase 0 — the build fails without
it and succeeds with it, using an identical source tree both times).
`.github/workflows/apple-ci.yml` passes it too.

`swift test` needs no equivalent flag — the bare `swift` CLI's plugin
execution isn't gated the same way Xcode's build system's is.

## Setup

- Xcode 16+ with the iOS 17 SDK and an iOS Simulator runtime installed
  (`xcrun simctl list devices available` should list at least one iPhone).
- Open the app in Xcode with `open apps/apple/Crowi.swiftpm` or
  `xed apps/apple/Crowi.swiftpm` (see "Why `Crowi.swiftpm`, not `apps/apple/`,
  is what you open" above — opening anything else fails or falls back to a
  plain single-file editor with no scheme/run button).
- No `npm install` / `pnpm install` step — this island has no JS tooling.
- First build resolves SwiftPM dependencies over the network
  (swift-openapi-generator / -runtime / -urlsession, swift-markdown-ui) —
  needs outbound access to GitHub once; subsequent builds are cached.

## What Phase 1 workspace/auth built (`feature-ios-phase1-workspace-auth`)

Phase 0 (scaffold + 3 gate spikes) is unchanged and still lives under
`CrowiKit/Sources/CrowiKit/API/` (gate B) and `Images/` (gate C); see that
section's git history / the spec's Gate 判定 section for the gate rationale.
Phase 1 adds the real multi-workspace shell on top:

- **`Workspace/`** — `WorkspaceOrigin` (the relocated/renamed Phase 0
  `URLOrigin`) and `APIBaseURL`, the two distinct newtypes §3 requires (no
  raw-URL passthrough between them); `WorkspaceIndexStore` (the non-secret
  `{ id, workspaceOrigin, displayTitle }` list in standard `UserDefaults`,
  OQ-2); `WorkspaceStore` (the observable root: ordered workspace list +
  `activeWorkspaceId`, add/switch/sign-out orchestration — the only place an
  arbitrary `Workspace` value is legitimately in scope); `WorkspaceContext`
  (the §14 **workspace-bound handle** `WorkspaceStore.context(for:)` hands
  out: its credential/refresh-coordinator/middleware/`ModelContainer`
  accessors are all fixed to the one `Workspace` it was constructed with —
  no method takes a differing id, so code holding only a `WorkspaceContext`
  structurally cannot reach another workspace's Keychain item or store;
  `PerWorkspaceIsolationTests` pins this). `context(for:)` itself
  **canonicalizes against the store**: since `Workspace` is a public,
  freely-constructible struct, it only trusts the argument's `id` — the
  `Workspace` actually used to build the returned context is always looked
  up fresh from `workspaces`, never the caller-supplied value's own
  `workspaceOrigin`, so a caller cannot combine workspace B's id with
  workspace A's origin and get back a context that leaks B's credential to
  A's API (`nil` if the id isn't currently in the store); `AddWorkspaceFlow`
  (URL normalize
  → HTTPS gate → lenient `/app/info` probe → minimum-version gate → hands
  off to `OAuthSignInFlow`).
- **`Config/MinimumVersionFloor.swift`** — the single placeholder floor
  constant (OQ-6 — the real value is a release-checklist decision) plus a
  minimal semver-precedence comparator.
- **`Auth/`** — `OAuthSignInFlow` (the real ASWAS + PKCE S256 + RFC 8414
  discovery + form-encoded token exchange, **replacing** the deleted Phase 0
  `GateASpike.swift`); `KeychainTokenStore` (`kSecClassGenericPassword`,
  `service = bundle id`, `account = workspace id`, §4.3);
  `RefreshCoordinator` (the single-flight refresh `actor`, OQ-3 — proactive
  before `expiresAt` + reactive `401` backstop, both funneling through one
  in-flight `Task` so concurrent callers never double-present the same
  rotating refresh token; the reactive path also takes the caller's own
  rejected access token and compares it against the currently-stored one, so
  a **delayed** 401 — one whose caller only gets around to reacting after
  another concurrent request's refresh has already completed — reuses the
  already-refreshed token instead of presenting the refresh token a second
  time); `AuthenticatingMiddleware` (the §5.1 auth-injecting
  `ClientMiddleware` a per-workspace generated `Client` is composed with,
  wired via `WorkspaceContext.makeAuthenticatingMiddleware()`); `SignOutFlow`
  (`POST /oauth/revoke` + Keychain purge, best-effort like the CLI's
  `revokeToken`). `WorkspaceStore.signOut` layers three more explicit
  teardown steps on top of `SignOutFlow`: index-entry removal, that
  workspace's image cache
  (`WorkspaceModelContainerFactory.deleteImagesCacheDirectory`), and its
  on-disk `ModelContainer` store (`deleteWorkspaceDirectory`) — each its own
  named call, so the sign-out contract (revoke + Keychain + image cache +
  ModelContainer, §3/§7.2/§14) stays legible at the call site rather than
  relying only on the image cache directory happening to nest inside the
  store directory.
- **`Persistence/`** — `WorkspaceModelContainerFactory` (per-workspace
  `ModelContainer` at `Application Support/workspaces/<id>/crowi.store`,
  `isExcludedFromBackup` + `NSFileProtection` on iOS) and
  `SchemaVersionMarker` (the §7.3 drop-and-rebuild reconciliation — Phase 1
  passes an empty `@Model` schema; `feature-ios-phase1-read` adds real models
  and bumps `schemaVersion`).
- **`Crowi.swiftpm/Sources/CrowiApp/`** — `RootScene` (the §9 adaptive shell:
  `NavigationSplitView` ⇔ `NavigationStack` by size class),
  `WorkspaceSwitcherView` (Slack-style switcher: tap to switch instantly,
  swipe to sign out), `AddWorkspaceView` (on a successful add, calls the same
  `onSelectWorkspace` callback `RootScene` wires up for tapping an existing
  row, so onboarding navigates straight to the new workspace's home instead
  of leaving the user at the switcher — on both compact/iPhone and
  regular/iPad width).

Phase 1's own scope ended at "add a workspace, sign in with no consent
screen, see an empty home, add a second workspace, switch instantly, sign out
of one without touching the other" — no read/write surface existed yet.

## What this phase (`feature-ios-phase1-read`) adds

The full **read** surface, entirely client-side — the server needed zero
changes (every endpoint this phase reads already existed and is stable).

- **`API/AppInfoCache.swift`** — the ONE refreshed per-workspace `/app/info`
  cache (§5.2): both the `search` capability gate and the §6.3 confidential
  banner read this SAME `actor`, never two independent fetch paths. Forces a
  fetch on workspace `activated()` and app `foregrounded()`; any other read
  (`current()`) serves the cache within a 10-minute TTL. Concurrent callers
  right after a workspace switch single-flight onto one in-flight fetch —
  the same actor-coalescing shape `RefreshCoordinator` (Phase 1) established.
- **`API/AuthenticatedAPIClient.swift`** — the ONE per-workspace
  authenticated-fetch primitive: composes `AuthenticatingMiddleware` (Phase
  1's proactive+reactive single-flight refresh) directly with
  `OpenAPIURLSession.URLSessionTransport` — the SAME `ClientTransport`
  swift-openapi-generator's own generated `Client` uses — WITHOUT going
  through the generated `Client`'s per-operation methods (those decode
  through the strict generated `Output`, the exact seam §5.2 rejects for
  responses). Every hand-written `*Lenient` decoder below is built on this
  one primitive, so `AuthenticatingMiddleware` gets its first real production
  caller here.
- **`API/{Page,Search,Comments,BookmarkLike,Backlinks,Revisions,Profile}Lenient.swift`**
  — one hand-written lenient decoder per read screen, the exact
  `AppInfoLenient` pattern (optionals-first, `JSONSerialization`-based,
  degrade rather than throw). `PageLenient`/`PageRevisionLenient` pin §8's
  `PageSchema.revision` `string | Revision` union: a list/children/portal row
  may carry a bare revision-id string with no `body` at all
  (`needsDetailFetchForBody`), so every read screen that opens a page from
  such a row issues the single-page detail `GET` first.
  `SearchHitLenient.plainSnippet(_:)` strips the driver's unescaped `<mark>`
  highlight tokens — the app must never render them as markup (no HTML/DOM
  render context exists to safely interpret them in).
- **`Images/WorkspaceImageDiskCache.swift`** — a per-workspace disk cache
  WRAPPING `WorkspaceImageLoader` (never forking it): implements the
  200-real/200-placeholder/500-error trichotomy for an embedded
  `/attachments/<id>` URL (placeholder detected by byte-identity against the
  bundled reference `file-not-found.png`, NEVER cached permanently — the next
  fetch always re-hits the network) and the DIFFERENT
  200-real/404-missing/500-error trichotomy for a by-key avatar URL. A `401`
  triggers exactly one reactive refresh through the SAME `RefreshCoordinator`
  a JSON API call would use, then one retry. `WorkspaceMarkdownImageProvider`
  is generalized over a new `WorkspaceImageFetching` protocol so it can be
  backed by either the bare loader (Phase 0 spike/tests) or this real cache
  (production), with zero change to the already-proven renderer integration.
- **`Rendering/SchemeAllowlist.swift`** — the ONE shared §6.2 allowlist:
  `http`/`https`/workspace-relative only; every custom scheme is inerted
  unconditionally, including the app's own `crowi-ios://` OAuth callback.
  `WorkspaceImageLoader.fetch(_:)`'s own URL-rebase step consumes this SAME
  allowlist (not a second, drifted check) — a custom-scheme image URL is
  rejected with `LoaderError.disallowedScheme` before any network I/O, the
  same belt-and-suspenders guarantee the `openURL` link interceptor gives
  taps.
- **`Rendering/WikiLinkMentionPreprocessor.swift`** — mirrors `WIKILINK_RE`/
  `MENTION_RE` (`packages/api/src/renderer/core/{wikilinks,mentions}.ts`)
  byte-for-byte on the raw `revision.body`, rewriting `[[target]]`/
  `[[target|display]]`/`@username` into ordinary CommonMark links against two
  private pseudo-schemes (`crowi-wikilink:`/`crowi-mention:`) BEFORE handing
  the body to swift-markdown-ui — native rendering never consumes
  `renderedAst` (§6). A non-absolute wikilink target (§6's `isValidTarget`
  rule) is left as fully untouched plain text rather than a link. Fenced code
  blocks, inline code spans, AND an existing CommonMark inline link/image's
  own label+destination (`[label](destination)` / `![alt](destination)`) are
  all protected from rewriting — mirroring `mentions.ts`'s `insideLink` skip,
  so e.g. a GitHub-style `[the repo](https://github.com/@bob/crowi)` never has
  its own destination corrupted into a nested mention link.
- **`Rendering/WorkspacePageMarkdownView.swift`** — composes `Markdown(body)`
  + `WorkspaceMarkdownImageProvider` + an `.environment(\.openURL, ...)`
  interceptor (the renderer's own already-exposed link-tap seam) that
  resolves the pseudo-scheme links to in-app navigation and applies
  `SchemeAllowlist` to everything else — the ONE place both concerns meet, so
  neither the allowlist nor the wikilink/mention router is duplicated per
  call site.
- **`Rendering/ConfidentialBannerOverlay.swift`** — §6.3's non-scrolling,
  always-on-top, non-dismissible banner (OQ-11 resolved: v1 ships the banner
  only, no export suppression), applied ONCE at `WorkspaceHomeView`'s chrome
  root, driven by the refreshed `AppInfoCache.confidential`. The SAME
  confidential detection also re-escalates rest-state protection on BOTH the
  image cache (`WorkspaceImageDiskCache.applyConfidentialProtection`) AND the
  SwiftData store directory (`WorkspaceContext.applyConfidentialStorageProtection`,
  new) every refresh — `WorkspaceSession.refreshAppInfo` calls both, not only
  the image cache.
- **`Rendering/SearchCapabilityToolbarButton.swift`** (new) — the ONE
  `search`-capability-gated toolbar entry point. Extracted out of
  `WorkspaceHomeView`'s toolbar closure into CrowiKit specifically so it can
  be rendered/inspected directly from `CrowiKitTests`
  (`SearchCapabilityToolbarButtonTests`, via `ImageRenderer` — proving the
  actual SwiftUI paint output differs when `search` is present vs. absent,
  not only that an upstream `[String]` changed): the App target itself
  cannot be imported into CrowiKit's test target (its package manifest
  depends on `AppleProductTypes`, Xcode-only). `WorkspaceHomeView` places
  this EXACT type inside its `ToolbarItemGroup` rather than re-deriving
  `capabilities.contains("search")` inline, so the tested gate can never
  drift from the shipped one.
- **`Rendering/WorkspaceAvatarView.swift`** (new) — a small circular avatar
  view shared by `ProfileView` (own/public profile) and `PageReaderView`'s
  comments section; fetches through the same `WorkspaceImageFetching`
  conformer (`session.imageCache`) every other embedded image goes through
  (avatar URLs are Bearer-gated `by-key/user/<username>` paths, §6.1), never
  a bare unauthenticated image view.
- **`Persistence/{CachedPage,CachedPageChildren,CachedBacklink,CachedComment,CachedRevisionSummary,CachedSearchResult}.swift`**
  — the six read-cache `@Model` types (§7.2), and
  **`WorkspaceReadCacheSchema.swift`** bumping `schemaVersion` to `2` — Phase
  1 deliberately shipped an EMPTY schema at version 1 specifically so this is
  the first real schema change any installed build ever sees (§7.3
  drop-and-rebuild, never a migration plan).
- **`Workspace/WorkspaceSession.swift`** (new) — bundles one workspace's
  `AppInfoCache`/`AuthenticatedAPIClient`/`WorkspaceImageDiskCache`/
  `ModelContainer` behind one `@MainActor` `ObservableObject`, built through
  `WorkspaceContext`'s factories (`makeAppInfoCache()`/`makeAPIClient()`/
  `makeImageCache()`/`makeModelContainer()`) — never constructed ad hoc from
  a bare `Workspace` value in a view.
- **`Crowi.swiftpm/Sources/CrowiApp/`** — `WorkspaceHomeView` (new; fills in
  `RootScene`'s previously-empty per-workspace slot with the read surface's
  OWN adaptive shell: `NavigationSplitView` sidebar=`PageTreeView`/
  detail=reader on iPad, `NavigationStack` on iPhone — a nested, DIFFERENT
  size-class branch point from `RootScene`'s own outer workspace-switcher
  split); `PageTreeView` (hierarchy sidebar, drills into sub-directories by
  pushing another `PageTreeView`); `PageReaderView` (always opens via the
  detail `GET`, native render, like/bookmark/seen-count display, comments,
  backlinks, revision-history entry point — read-only, no write actions this
  phase); `SearchView` (capability-gated, hides/re-shows live as `search`
  flips); `RevisionHistoryView` (list + read-only past-revision sheet);
  `ProfileView` (own `/me` and public `/user/{username}` — a tapped
  `@mention` navigates here unconditionally, per §6/§15, and lets this
  screen's own `404` surface an unknown user; shows the profile's own avatar
  via `WorkspaceAvatarView`); `RecentlyViewedView`;
  `ReadDestination` (the one navigation-target enum shared by both size
  classes).

`PageTreeView` additionally carries its own toolbar action ("View Portal
Page") whenever the path it lists children FOR is itself a real saved portal
document (`PageChildSegment.hasPortal`) — a segment can be both a portal page
AND a directory of further pages at once, so drilling into its children must
never be the ONLY way to reach that segment's own body.

Every new per-workspace API call goes through `AuthenticatedAPIClient` (never
a bare unauthenticated `URLSession`), every image fetch goes through
`WorkspaceImageDiskCache` (never a bare `WorkspaceImageLoader` constructed ad
hoc), and the SwiftData read caches are best-effort fast-paths only — the app
always prefers a fresh network read when online (§7.2).

Bounded write (create page, quick-edit with `revision_id` optimistic locking,
post a comment, toggle engagement) is `feature-ios-phase2-write`, next.
