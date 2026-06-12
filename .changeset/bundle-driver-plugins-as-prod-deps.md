---
"@crowi/api": patch
---

Make `@crowi/api` plugin-free again: it now depends only on its SDK
(`@crowi/plugin-api`) and core packages, not on the first-party driver
plugins (storage / mail / search / renderer). Which drivers ship is owned by
the *runner project* that boots the api, not by the api package itself.

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
