# @crowi/collab

Standalone Hocuspocus host process for Crowi 2.0's realtime collaborative
editing feature (RFC-0003). Runs out-of-band from `@crowi/api` on a
dedicated WebSocket port and reuses the api package's Mongoose model
factories so schemas never drift between the two processes.

## Quick start (dev)

```bash
docker compose up -d        # mongo / redis
pnpm install
pnpm --filter @crowi/api build
pnpm --filter @crowi/collab dev
```

The root `pnpm dev` script also starts `@crowi/collab` alongside `api` /
`web` / contracts / plugins.

## Environment variables

| Variable           | Default                       | Meaning                                                                 |
| ------------------ | ----------------------------- | ----------------------------------------------------------------------- |
| `COLLAB_PORT`      | `3302`                        | TCP port for the Hocuspocus HTTP/WebSocket server.                      |
| `COLLAB_HOST`      | `0.0.0.0`                     | Bind address.                                                           |
| `MONGO_URI`        | `mongodb://localhost/crowi`   | MongoDB connection string. Must match the api process.                  |
| `WS_TOKEN_SECRET`  | _(random per process)_        | JWT signing secret for the short-lived wsToken. **Must** match the api / every collab instance in a multi-server deployment — otherwise tokens minted by one node cannot be verified by another. |
| `NODE_ENV`         | _(unset)_                     | `production` silences the Hocuspocus start screen.                      |

## Architecture (Phase 3 scope)

- Boots its own Mongoose connection — no `Crowi` class, no plugin
  registry, no config service. Heavy startup paths live in `@crowi/api`.
- Loads model factories from `@crowi/api/dist/models/*` dynamically
  (same `require.resolve` pattern as `@crowi/admin-cli`) so a workspace
  symlink in dev and an npm install in prod resolve identically.
- Hooks:
  - `onAuthenticate` — verifies the wsToken (Phase 2 util), enforces
    `pageId === documentName`, confirms the page exists, and rolls in
    the Phase 6 cap stub.
  - `onLoadDocument` — restores `Page.yjsState` into the Y.Doc; falls
    back to seeding `Y.getText('content')` from the latest revision's
    body when no checkpoint exists yet (or the buffer is corrupt).
  - `onStoreDocument` — encodes the full Y.Doc state with
    `Y.encodeStateAsUpdate` and writes it to `Page.yjsState` plus
    `Page.yjsCheckpointAt`. Phase 4 will layer `PageYjsUpdate` append +
    compaction on top of this hook.

Scope is bounded to Phase 3 of RFC-0003 — subsequent phases (high-frequency
`PageYjsUpdate` log, `crowi:save` → `Revision`, cap counter, force-reload,
browser editor, multi-server pub/sub) layer on top of these hooks. See the
RFC for the staging plan.
