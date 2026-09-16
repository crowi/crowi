# @crowi/collab

Hocuspocus engine for Crowi 2.0's realtime collaborative editing feature
(RFC-0003). Attached as a library inside the `@crowi/api` process itself
(`src/collab/attach.ts`) — there is no separate collab process, port, or
Mongoose connection to run or configure; `pnpm dev` boots it as part of the
api.

## Quick start (dev)

```bash
docker compose up -d        # mongo / redis
pnpm install
pnpm dev                    # boots api (with collab attached), web, plugins
```

## Environment variables

Collab has no environment variables of its own — it reads everything through
the `@crowi/api` process that attaches it:

| Variable        | Meaning                                                                 |
| --------------- | ------------------------------------------------------------------------ |
| `MONGO_URI`     | MongoDB connection — shared with the api's own Mongoose connection.      |
| `SECRET_TOKEN`  | The api's mandatory unified signing secret (`WS_TOKEN_SECRET` is a legacy alias) — collab's wsTokens are signed/verified with the same value as every other Crowi JWT/HMAC channel. **Must** be identical across every api replica in a multi-instance deployment, otherwise a wsToken minted on one replica cannot be verified by another. Boot aborts if it is unset, empty, whitespace-only, or a known placeholder — see the root `.env.example` and `docs/operations/realtime-collab` for the full contract. |
| `REDIS_URL`     | When set, `@hocuspocus/extension-redis` is attached automatically so multi-instance deployments fan out Y.Doc updates/awareness via Redis pub/sub. |

## Architecture

- Shares the api process's Mongoose connection and model factories — no
  separate connection, no plugin registry, no config service of its own.
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
