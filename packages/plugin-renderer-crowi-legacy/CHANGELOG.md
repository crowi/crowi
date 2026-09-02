# @crowi/plugin-renderer-crowi-legacy

## 0.1.0-alpha.3

### Patch Changes

- ba38a7e: Upgrade `jest` / `@types/jest` / `jest-environment-node` from the 29.x series to 30.5.0 / 30.0.0 / 30.5.0 across the 16 workspaces that share these versions through the pnpm catalog. `ts-jest` stays on 29.4.12 (already accepts `jest@^30`) and `packages/web`'s vitest stack is untouched — this is a test-tooling-only change with no observable behavior difference for users of any of these packages.

  `@crowi/api`'s three custom Jest extension points (the `CrowiEnvironment` test environment's `handleTestEvent`, the `FailureTaxonomyReporter`'s `onTestResult`/`onRunComplete`, and `globalSetup`'s MongoDB connection resolution) were individually verified against jest 30 and continue to work unchanged, as does the `--no-sparkplug` Node 24 V8 workaround the api's test script depends on.

- Updated dependencies [ba38a7e]
- Updated dependencies [a334308]
  - @crowi/plugin-api@1.0.0-alpha.9

## 0.1.0-alpha.2

### Patch Changes

- Updated dependencies [336eec1]
- Updated dependencies [8ff0e64]
- Updated dependencies [b20ff59]
- Updated dependencies [d611836]
- Updated dependencies [5e857f6]
  - @crowi/plugin-api@1.0.0-alpha.3

## 0.1.0-alpha.1

### Patch Changes

- 3eb9504: Use English admin sidebar labels for the local-storage and Crowi-v1 renderer
  plugins. Their `adminPlacement.label` was hardcoded in Japanese ("ローカルストレージ"
  / "Crowi v1 互換レンダラー") and showed even in the English admin UI; the sidebar
  label has no per-locale mechanism, so this aligns them with every other plugin
  (AWS S3, MongoDB, Elasticsearch, …) which already use neutral English labels.

## 0.1.0-alpha.0

### Minor Changes

- a52d03f: Initial publish preparation: monorepo restructure complete (RFC-0002 →
  feature-monorepo-packages-restructure). All packages now use
  workspace: protocol internally, peerDependencies for plugin boundaries,
  shared @crowi/tsconfig presets, and a publish-ready layout under
  packages/\*.

### Patch Changes

- Updated dependencies [a52d03f]
- Updated dependencies [966d133]
- Updated dependencies [7f77407]
  - @crowi/plugin-api@0.1.0-alpha.0
