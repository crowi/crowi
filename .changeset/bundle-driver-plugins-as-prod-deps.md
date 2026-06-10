---
"@crowi/api": patch
---

Bundle all first-party driver plugins (storage / mail / search / renderer) as production dependencies of `@crowi/api` so the `pnpm deploy --prod` Docker image contains them. Previously they were `devDependencies` and were stripped from the production image, causing the api to fail at boot when the runner resolved the implicit-default plugins (`@crowi/plugin-storage-local`, `@crowi/plugin-mail-smtp`) and hit `MODULE_NOT_FOUND`.

In addition, every first-party plugin (plus `@crowi/runner`) now declares `@crowi/plugin-api` — and the AWS-based plugins also `@crowi/plugin-aws` — as a real `dependencies` entry (`workspace:^`) instead of relying on a `peerDependencies` semver range. The plugins import the SDK at runtime, so a real dependency is the correct relationship. The previous peer range (`^0.1.0`) could not be satisfied by `pnpm deploy --prod`: the SDK is an unpublished workspace package at `0.1.0-dev`, so pnpm tried to resolve the peer from the npm registry and failed with a 404. Declaring it as a workspace dependency makes the production deploy tree resolve the SDK from the workspace instead of the registry.

The runner resolution logic is unchanged; operators still toggle drivers on/off via `crowi.config.json`.
