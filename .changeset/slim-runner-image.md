---
"@crowi/api": patch
---

Promote `@crowi/plugin-search-mongo` to an always-on **implicit default** and
add a **slim** Docker image as the minimal start-up set.

`IMPLICIT_DEFAULT_PLUGINS` (in `@crowi/runner`) now loads the trio
`@crowi/plugin-storage-local` + `@crowi/plugin-search-mongo` +
`@crowi/plugin-mail-smtp` on every boot, so a fresh install — backed by
**MongoDB alone**, with no Elasticsearch / S3 / external mail relay — comes up
as a working Wiki (local file storage, MongoDB `$regex` search, SMTP mail)
without any extra plugin install or `crowi.config.json` entry. The
`crowi.config.json` schema already defaults `search.driver` to `'mongo'`, so
this matches the documented defaults.

A new slim reference runner project (`apps/crowi-runner-slim`,
`@crowi/runner-app-slim`) bundles exactly those three drivers and is the build
source for the slim Docker image — a small base/starter for operators who want
to fully customize their plugin set. The full image (`apps/crowi-runner`,
all twelve first-party drivers, switchable via config with no rebuild) gains
`@crowi/plugin-search-mongo` too. Both images build from the same
parameterized `packages/api/Dockerfile` (`--build-arg RUNNER_APP=...`).
