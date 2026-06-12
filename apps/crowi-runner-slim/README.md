# @crowi/runner-app-slim

The **minimal** reference runner project for the Crowi 2.0 api — it runs on
**MongoDB alone**, with no external infrastructure (no Elasticsearch, no S3).

A "runner project" is the unit Crowi's plugin architecture boots against:
a `package.json` that depends on `@crowi/api` plus whichever
`@crowi/plugin-*` drivers you want, and a `crowi.config.json` that selects
the active drivers. The api resolves plugins with
`createRequire(<projectDir>/package.json)`, so **the cwd at boot must be
this directory** (`PluginManager.bootstrap()` → `process.cwd()`).

This is the lean counterpart to `apps/crowi-runner` (the full,
batteries-included project). It exists for two roles:

1. **build source for the official slim Docker image** — built from this
   project's deploy tree, the slim image carries only `@crowi/api` plus the
   three implicit-default drivers. It is a small base/starter that boots
   out of the box but is meant to be **forked and extended**: add the
   `@crowi/plugin-*` packages you actually need to your own runner project's
   `package.json`, list them in `crowi.config.json`, and rebuild.
2. **reference for fully-custom operators** — operators who do not want the
   full image's twelve bundled drivers copy this minimal project and grow it
   to fit their environment.

## What's bundled (slim = minimal start-up set)

Only the three **implicit-default** drivers — the ones `@crowi/runner` loads
on every boot regardless of `crowi.config.json` (`IMPLICIT_DEFAULT_PLUGINS`):

- storage: `storage-local` — uploads on the local filesystem
- search: `search-mongo` — MongoDB `$regex` full-text search (no ES/OpenSearch)
- mail: `mail-smtp` — SMTP delivery

Because all three are implicit defaults, `crowi.config.json` lists no
`plugins` and overrides no driver — the schema defaults
(`storage=local`, `search=mongo`, `mail=smtp`) already match this set.
`@crowi/api` itself is plugin-free; it depends only on the SDK
(`@crowi/plugin-api`) and the runner resolution library (`@crowi/runner`).

> Need S3 / Elasticsearch / a different mail provider? Either start from the
> **full** image (`apps/crowi-runner`, all twelve drivers, switch via config
> with no rebuild) or add the specific `@crowi/plugin-*` package to a fork of
> this project and rebuild.

## Running

```sh
# production (inside the slim Docker image, cwd = the deployed runner project)
npm start         # = crowi-api  (the @crowi/api bin)
```

`pnpm dev` boots the **full** runner project (`apps/crowi-runner`); this slim
project is a deploy/build target, not the dev launch point.

Per-driver credentials (SMTP host, …) live in the Mongo Config collection and
are edited from the admin UI, not in `crowi.config.json`.
