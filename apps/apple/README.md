# Crowi (Apple)

Native Apple client for [Crowi 2.0](https://crowi.wiki) — [RFC-0016](../../docs/rfcs/0016-ios-native-app.md).
A universal iPhone + iPad SwiftUI app (macOS-ready, not yet shipped) that
signs into and reads/edits multiple independent Crowi workspaces over
`/api/v2`, the same HTTP surface `@crowi/cli` (RFC-0012) and MCP (RFC-0011)
use.

> Status: **Phase 0 (scaffold + gate spikes)**. This is not yet the real app —
> see "## Gate 判定" in
> [`.feature-state/specs/feature-ios-phase0-gates.md`](../../.feature-state/specs/feature-ios-phase0-gates.md)
> for the decisions this scaffold exists to prove, and RFC-0016 for the full
> design. Phase 1 (`feature-ios-phase1-workspace-auth`) builds the real
> `WorkspaceStore` / auth / read UI on top of this.

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
├── Package.swift              # the App manifest (`import AppleProductTypes`,
│                               #   Xcode-only — see "Two packages" below)
├── Sources/CrowiApp/           # @main SwiftUI entry point (thin; Phase 1 builds
│                               #   the real WorkspaceStore/shell here)
├── Support/AdditionalInfo.plist  # merged into the app's Info.plist —
│                               #   CFBundleURLTypes declares `crowi-ios`
├── CrowiKit/                   # plain SwiftPM library: client/auth/render
│   │                           #   logic, testable with the bare `swift` CLI
│   ├── Package.swift
│   ├── Sources/CrowiKit/
│   │   ├── openapi.json        # SYMLINK → ../../../../packages/api-contract/openapi.json
│   │   │                       #   (in-tree, never a pinned copy — RFC-0016 §5.1/§10)
│   │   ├── openapi-generator-config.yaml
│   │   ├── Auth/                # gate A: PKCE S256 + RFC 8414 discovery
│   │   ├── API/                 # gate B: generated-client smoke + lenient /app/info decode
│   │   └── Images/              # gate C: the §6.1 same-origin-Bearer + redirect-strip loader,
│   │                             #   plus the swift-markdown-ui ImageProvider wired to it
│   └── Tests/CrowiKitTests/
└── .gitignore                  # excludes .build/ (incl. the generated Swift
                                 #   client — build-time only, never committed)
```

### Two packages, one reason: `AppleProductTypes` isn't parseable by the bare `swift` CLI

The root `Package.swift` declares the `.iOSApplication` product (via
`import AppleProductTypes`) that makes this directory build as a real iOS app
— universal iPhone/iPad, iOS 17 floor, `CFBundleURLTypes` declaring the
`crowi-ios` scheme — **entirely from a `Package.swift`, no `.xcodeproj`
needed**. This only works inside Xcode's own SwiftPM integration: the bare
`swift build`/`swift test` CLI cannot even **parse** a manifest that imports
`AppleProductTypes` (`error: no such module 'AppleProductTypes'` — verified
directly during Phase 0). So `swift test` cannot run against the root
manifest at all, ever, by construction — not a fixable bug.

All the shared, unit-testable logic therefore lives in **`CrowiKit/`**, a
plain local SwiftPM package with an ordinary manifest (no `AppleProductTypes`
import), which the App target depends on
(`.package(path: "CrowiKit")`). `swift test` runs there.

## Objective gate commands (extraGates)

These are the exact, verified commands — copy-paste them, they are not
placeholders:

```bash
# from apps/apple/ — builds the whole app (incl. CrowiKit + all SwiftPM deps)
# for the iOS Simulator destination.
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
- No `npm install` / `pnpm install` step — this island has no JS tooling.
- First build resolves SwiftPM dependencies over the network
  (swift-openapi-generator / -runtime / -urlsession, swift-markdown-ui) —
  needs outbound access to GitHub once; subsequent builds are cached.

## What's here today (Phase 0) vs. what Phase 1 adds

Phase 0 is a **scaffold + 3 gate spikes**, not the real app:

- `Sources/CrowiApp/` is a placeholder screen proving the App ⇄ CrowiKit
  wiring builds and links — no `WorkspaceStore`, no real UI.
- `CrowiKit/Sources/CrowiKit/Auth/` — PKCE S256 (byte-compatible with
  `packages/api/src/util/pkce.ts`) + RFC 8414 discovery-document decoding
  (gate A design pieces; the actual ASWAS end-to-end run is blocked on
  `feature-ios-companion-server` landing — see the spec's Gate 判定 section).
- `CrowiKit/Sources/CrowiKit/API/` — the swift-openapi-generator client
  generated from the real, in-tree `openapi.json` (gate B), plus the
  hand-written lenient `/app/info` decoder that pins where tolerant decoding
  lives (the generated response types are intentionally NOT used for parsing
  — see the doc comments on `AppInfoLenient` and `GeneratedClientSmoke`).
- `CrowiKit/Sources/CrowiKit/Images/` — `WorkspaceImageLoader`, the §6.1
  same-origin-Bearer + redirect-strip image loader (gate C), proven against a
  **real** local dev Crowi attachment (see
  `WorkspaceImageLoaderTests.testLiveRealAttachmentThroughFilesRedirectIfAvailable`,
  self-skipping when no live target is configured so CI stays hermetic); plus
  `WorkspaceMarkdownImageProvider`, the selected renderer's (swift-markdown-ui)
  `ImageProvider` conformance wired to that same loader — also proven against
  a real attachment (`WorkspaceMarkdownImageProviderTests`).

None of this is wired into a real UI yet, and none of it is the final shape
of the Phase 1 code — it exists to answer the three gate questions. See the
spec's "## Gate 判定(Phase 0 実施結果)" section for the decisions and their
rationale.
