# Crowi (Apple)

Native Apple client for [Crowi 2.0](https://crowi.wiki) — [RFC-0016](../../docs/rfcs/0016-ios-native-app.md).
A universal iPhone + iPad SwiftUI app (macOS-ready, not yet shipped) that
signs into and reads/edits multiple independent Crowi workspaces over
`/api/v2`, the same HTTP surface `@crowi/cli` (RFC-0012) and MCP (RFC-0011)
use.

> Status: **Phase 1 (workspace + auth + persistence, `feature-ios-phase1-workspace-auth`)**.
> Phase 0 (`.feature-state/specs/feature-ios-phase0-gates.md`) scaffolded the
> repo layout and cleared the 3 GO/NO-GO gates (generator, redirect
> transport, renderer image path). Phase 1 builds the real multi-workspace
> shell on top of that: add-workspace (HTTPS gate → lenient `/app/info` probe
> → minimum-version gate → OAuth sign-in), per-workspace Keychain + SwiftData
> persistence, a single-flight refresh actor, and the Slack-style workspace
> switcher UI. The read surface (page tree, render, search, images-in-context)
> is `feature-ios-phase1-read`, next.

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
│   ├── Sources/CrowiApp/       # @main entry point + the adaptive shell:
│   │   │                       #   RootScene (NavigationSplitView ⇔
│   │   │                       #   NavigationStack, §9) / WorkspaceSwitcherView
│   │   │                       #   / AddWorkspaceView / EmptyWorkspaceHomeView
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
│   │   │                       #   §14 structural isolation), AddWorkspaceFlow
│   │   │                       #   (HTTPS gate → lenient probe → version floor
│   │   │                       #   → sign-in)
│   │   ├── Config/              # MinimumVersionFloor — the single placeholder
│   │   │                       #   floor constant (OQ-6)
│   │   ├── Auth/                # OAuthSignInFlow (real ASWAS + PKCE + discovery
│   │   │                       #   + token exchange, replacing the Phase 0
│   │   │                       #   GateASpike), KeychainTokenStore,
│   │   │                       #   RefreshCoordinator (single-flight actor),
│   │   │                       #   AuthenticatingMiddleware (the §5.1 auth
│   │   │                       #   transport wrapper), SignOutFlow
│   │   ├── Persistence/         # WorkspaceModelContainerFactory + SchemaVersionMarker
│   │   │                       #   — per-workspace SwiftData container, §7
│   │   ├── API/                 # gate B: generated-client smoke + lenient /app/info decode
│   │   └── Images/              # gate C: the §6.1 same-origin-Bearer + redirect-strip loader,
│   │                             #   plus the swift-markdown-ui ImageProvider wired to it
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

## What's here today (Phase 1) vs. what Phase 1.5 (read) adds

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
  regular/iPad width), `EmptyWorkspaceHomeView` (Phase 1's own read surface
  is intentionally empty — `feature-ios-phase1-read` is next).

None of the read/write surface (page tree, render, search, quick-edit) exists
yet — Phase 1's own scope ends at "add a workspace, sign in with no consent
screen, see an empty home, add a second workspace, switch instantly, sign out
of one without touching the other."
