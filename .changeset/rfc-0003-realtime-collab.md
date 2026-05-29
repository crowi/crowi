---
'@crowi/api': minor
'@crowi/web': minor
'@crowi/api-contract': minor
---

Realtime collaborative editing (RFC-0003) v2.1 alpha is now available. The page editor (`/_edit?page_id=<pageId>`) runs in a Google Docs-style realtime co-editing mode where multiple users can edit the same page simultaneously. It ships with Hocuspocus attached in-process as the `@crowi/collab` library, so `/collab/*` WebSockets are handled on the same host as the api (no separate process to start).

The `@crowi/api-contract` minor bump is for `GET /api/v2/pages/:id/yjs-token` (wsToken issuance) and the new `savedBy` / `contributors` fields on the `Revision` schema.

Main features:

- Live cursors / awareness display visualise other members' cursor positions and selection ranges in realtime. An `Alice (with Bob, Carol)` style contributors display is also added to the revision history.
- Save = checkpoint model: an explicit Save button creates a `Revision`; autosave is intentionally absent. `renderedAst` is updated at the same time via `Revision.prepareRevision` (RFC-0002).
- Concurrent-editor cap of 20 (configurable with `COLLAB_MAX_EDITORS_PER_PAGE`). The 21st editor and beyond receive live updates in read-only mode.
- In multi-instance deployments `@hocuspocus/extension-redis` auto-attaches when `REDIS_URL` is set, doing pub/sub across all api replicas without sticky sessions.
- Persistence is a 3-layer structure: `Page.yjsState` (live snapshot) / `PageYjsUpdate` (high-frequency deltas, TTL 1h) / `Revision` (checkpoint on save).

See `apps/crowi-site/content/docs/{ja,en}/operations/realtime-collab.mdx` for operations (reverse-proxy config / required multi-instance env / 2-instance smoke test), `apps/crowi-site/content/docs/{ja,en}/realtime-editing.mdx` for the user-facing guide, and `docs/rfcs/0003-realtime-collaborative-editing.md` for the design rationale.
