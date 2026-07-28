# @crowi/e2e

Playwright end-to-end tests for Crowi. Exercises the real `@crowi/api` +
`@crowi/web` stack against a dedicated `crowi_e2e` MongoDB database, spun up
and torn down per run — not a mock, not a subset of the unit-test suite.

## Running

```bash
docker compose up -d   # mongo / redis / mailpit (see repo root)
pnpm --filter @crowi/e2e e2e
```

This builds the runtime deps (`build:runtime`), resets the `crowi_e2e`
database and Mailpit inbox (`src/global-setup.ts`), then runs
`playwright test`, which starts a dedicated e2e api (port 4290) and web
(port 4291) via the `start:api` / `start:web` scripts below before driving
the browser. `pnpm e2e:headed` / `pnpm e2e:debug` run the same flow with a
visible browser / the Playwright inspector.

`src/preflight.ts` checks MongoDB / Redis / Mailpit are reachable before
touching the database, and fails fast with a `docker compose up -d` hint if
not.

## Running alongside a live `pnpm dev`

You do **not** need to stop a `pnpm dev` you're already running in the same
worktree before running `pnpm --filter @crowi/e2e e2e` — the two are
isolated from each other on the two axes that used to collide:

- **Next.js dev server distDir**: `next dev` takes an exclusive lockfile
  under its `distDir` (`<distDir>/dev/lock`), so a second `next dev` pointed
  at the same `packages/web` directory used to get killed with "Another next
  dev server is already running". `start:web` sets
  `NEXT_DIST_DIR=.next-e2e`, which `packages/web/next.config.ts` reads to
  give the e2e dev server its own `packages/web/.next-e2e/` distDir — a
  separate lock, build manifest, and server output from the main dev
  server's `packages/web/.next/`. `next build` / Docker never set this env,
  so production artifacts are unaffected.
- **Redis keyspace**: `start:api` sets `REDIS_KEY_PREFIX=crowi-e2e`, so the
  e2e api's presence / notifications / editor-cap / rate-limit keys live
  under the `crowi:crowi-e2e:*` namespace instead of falling back to a
  `CLIENT_URL`-hostname-derived slug that a concurrently-running dev
  instance could share.

Ports were already separate before this (e2e uses 4290/4291, below the
dev-portal's 4300-4999 band — see `src/config.ts`); distDir and Redis
keyspace were the two remaining points of contention.
