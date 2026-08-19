# @crowi/runner-app

The monorepo's own **reference runner project** for the Crowi 2.0 api.

A "runner project" is the unit Crowi's plugin architecture boots against:
a `package.json` that depends on `@crowi/api` plus whichever
`@crowi/plugin-*` drivers you want, and a `crowi.config.json` that selects
the active drivers. The api resolves plugins with
`createRequire(<projectDir>/package.json)`, so **the cwd at boot must be
this directory** (`PluginManager.bootstrap()` → `process.cwd()`).

This package fills three roles:

1. **dev launch point** — `pnpm dev` / `pnpm dev:api` start the api with
   `apps/crowi-runner` as the projectDir (the api package's `dev` script
   `cd`s here before `tsx watch`), so dev resolves plugins exactly the way
   prod does. This keeps dev and prod from drifting.
2. **build source for the official full Docker image** — `packages/api/Dockerfile`
   runs `pnpm deploy --filter=@crowi/runner-app --prod`, so the deployed
   tree contains `@crowi/api` **plus the full first-party plugin set**. The
   image is "batteries-included": switch drivers by editing
   `crowi.config.json` and restarting — no rebuild.
3. **reference for external operators** — an operator's own runner project
   (e.g. `mywiki/`) looks just like this one, minus the plugins they don't
   need. They name it themselves; this app is `@crowi/runner-app` (private,
   never published).

## What's bundled (full)

All thirteen first-party drivers are declared as `dependencies` so any of
them can be activated from `crowi.config.json` without a rebuild:

- storage: `storage-local`, `storage-aws-s3`, `storage-gcs`
- search: `search-mongo`, `search-elasticsearch`, `search-opensearch`
- mail: `mail-smtp`, `mail-resend`, `mail-aws-ses`
- renderer: `renderer-plantuml`, `renderer-katex`, `renderer-crowi-legacy`, `renderer-mermaid`

`@crowi/api` itself is plugin-free: it depends only on the SDK
(`@crowi/plugin-api`) and the runner resolution library (`@crowi/runner`).
Drivers live here, in the runner project.

> A **slim** sibling — `apps/crowi-runner-slim` (`@crowi/runner-app-slim`) —
> bundles only the minimal start-up set (the three implicit-default drivers:
> `storage-local` + `search-mongo` + `mail-smtp`) and is the build source for
> the slim Docker image, a base for full customization. See its README.

## Running

```sh
# from the repo root
pnpm dev          # api + web + plugins, projectDir = apps/crowi-runner
pnpm dev:api      # api side only

# production (inside the Docker image, cwd = the deployed runner project)
npm start         # = crowi-api  (the @crowi/api bin)
```

`crowi.config.json` selects the active drivers; per-driver credentials
(S3 bucket, GCS bucket + optional ADC/service-account key, SMTP host, …)
live in the Mongo Config collection and are edited from the admin UI, not
in this file.
