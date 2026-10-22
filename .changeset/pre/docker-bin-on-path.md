---
'@crowi/api': patch
---

Put the runtime image's `node_modules/.bin` on `PATH` so the bundled CLIs are
directly invocable. `docker compose run --rm api crowi-admin <cmd>` (and
`crowi-api`) now resolve by name; previously the base image's
`docker-entrypoint.sh` mis-read `crowi-admin` as `node crowi-admin` (because
`.bin` was not on `PATH`) and failed, forcing operators to spell out the full
`/app/node_modules/.bin/crowi-admin` path.
