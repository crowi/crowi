---
"@crowi/admin-cli": patch
"@crowi/api": patch
"@crowi/cli": patch
"@crowi/collab": patch
"@crowi/plugin-api": patch
"@crowi/plugin-google": patch
"@crowi/plugin-renderer-crowi-legacy": patch
"@crowi/plugin-renderer-katex": patch
"@crowi/plugin-renderer-mermaid": patch
"@crowi/plugin-renderer-plantuml": patch
"@crowi/plugin-search-elasticsearch": patch
"@crowi/plugin-search-mongo": patch
"@crowi/plugin-search-opensearch": patch
"@crowi/plugin-slack": patch
"@crowi/runner": patch
---

Upgrade `jest` / `@types/jest` / `jest-environment-node` from the 29.x series to 30.5.0 / 30.0.0 / 30.5.0 across the 16 workspaces that share these versions through the pnpm catalog. `ts-jest` stays on 29.4.12 (already accepts `jest@^30`) and `packages/web`'s vitest stack is untouched — this is a test-tooling-only change with no observable behavior difference for users of any of these packages.

`@crowi/api`'s three custom Jest extension points (the `CrowiEnvironment` test environment's `handleTestEvent`, the `FailureTaxonomyReporter`'s `onTestResult`/`onRunComplete`, and `globalSetup`'s MongoDB connection resolution) were individually verified against jest 30 and continue to work unchanged, as does the `--no-sparkplug` Node 24 V8 workaround the api's test script depends on.
