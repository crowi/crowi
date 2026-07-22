---
"@crowi/api": minor
"@crowi/api-contract": minor
"@crowi/plugin-api": minor
"@crowi/plugin-aws": minor
"@crowi/plugin-storage-local": minor
"@crowi/plugin-storage-aws-s3": minor
"@crowi/plugin-search-elasticsearch": minor
"@crowi/plugin-renderer-katex": minor
"@crowi/plugin-renderer-plantuml": minor
"@crowi/plugin-renderer-crowi-legacy": minor
"@crowi/admin-cli": minor
"@crowi/runner": minor
---

Initial publish preparation: monorepo restructure complete (RFC-0002 →
feature-monorepo-packages-restructure). All packages now use
workspace: protocol internally, peerDependencies for plugin boundaries,
shared @crowi/tsconfig presets, and a publish-ready layout under
packages/*.
