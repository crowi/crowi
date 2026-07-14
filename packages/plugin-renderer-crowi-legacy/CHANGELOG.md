# @crowi/plugin-renderer-crowi-legacy

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
