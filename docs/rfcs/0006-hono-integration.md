# RFC-0006: HTTP API Framework Migration — ts-rest to Hono

- **Status**: Draft (round 1 — initial proposal)
- **Target**: Crowi 2.2 release (rolled into the v2.2 work alongside RFC-0004 / RFC-0005)
- **Owner**: TBD
- **Last updated**: 2026-05-20
- **Depends on**: nothing (foundational API layer)
- **Related**: RFC-0004 (Editor UX Enhancement) and RFC-0005 (Page Presence) — both define `/api/v2/*` endpoints currently authored against ts-rest in `packages/api-contract` that will be reauthored against the new framework

## Summary

Replace ts-rest with Hono + `@hono/zod-openapi` as the framework
backing the `/api/v2/*` HTTP layer. The Zod schemas already curated
under `packages/api-contract/src/schemas/` move over essentially
unchanged. The ts-rest contracts under `packages/api-contract/src/
contracts/` are rewritten as `createRoute` definitions. Handlers in
the api app are rewritten as Hono handlers. The package itself stays
in place — name (`@crowi/api-contract`), location, and role as the
single source of truth for schemas, routes, and the published OpenAPI
spec are unchanged.

The legacy `/api/*` Express layer is being retired separately: the
business logic the new layer needs has already been moved across, so
the legacy mount goes away as part of the cutover here rather than
being preserved.

ts-rest has stalled as an upstream project. Its last stable release
(v3.52.1) shipped in March 2025; v3.53.0 has been in RC since mid-2025
without promotion to stable. Issue #797 "Future of ts-rest" confirms
reduced maintainer involvement, and ~30 PRs are sitting unmerged.
Several v2.2 RFCs (RFC-0004, RFC-0005) have already authored new
`/api/v2/*` endpoints against ts-rest; the migration cost increases
each release, so switching before v2.2 ships is the cheapest moment.

oRPC was evaluated as a direct successor with similar contract-first
ergonomics. It was rejected because it is maintained by a single
independent developer, which is structurally the same risk as ts-rest.
Hono is operated by the honojs org with multiple maintainers, has a
clear corporate backer (Cloudflare), and the OpenAPI spec it generates
remains a vendor-neutral asset even if Hono itself were to stall.

## Goals

- **`/api/v2/*` runs on Hono + `@hono/zod-openapi`**. ts-rest is fully
  removed from the codebase by the end of v2.2.
- **`@crowi/api-contract` stays the single source of truth**. The
  package name, location, and exports are preserved; only the
  `contracts/*.ts` files (route definitions) are rewritten. Consumers
  (`@crowi/api`, `@crowi/web`, runner apps) continue to import from
  `@crowi/api-contract` exactly as before.
- **Zod schemas migrate in place**. `packages/api-contract/src/
  schemas/**/*.ts` keeps its current shape; the only diff is the
  `import { z } from 'zod'` → `import { z } from '@hono/zod-openapi'`
  swap and the addition of `.openapi(...)` metadata on response
  schemas that warrant it.
- **Routes and handlers stay separated**. `createRoute` lives in
  `@crowi/api-contract`; handlers live in the api app's Hono module.
- **The generated OpenAPI 3.1 spec stays a first-class artefact**.
  The current `openapi.json` and `openapi.yaml` files at the root of
  `@crowi/api-contract` continue to be committed. Generation flips
  from `@ts-rest/open-api`'s `generateOpenApi` to `OpenAPIHono.
  getOpenAPIDocument()`. The CI diff-check that these files match the
  contract definitions is preserved.
- **A TypeScript types module is generated from the OpenAPI spec**.
  `openapi-typescript` runs as part of the package's build to emit
  `src/generated/openapi.ts`, which downstream consumers can use
  when `hc<AppType>` is not appropriate (other-language wrappers,
  external integrators).
- **The frontend uses Hono's `hc<AppType>` typed client**. End-to-end
  type safety is preserved; ts-rest's `initClient` / `ServerInferRequest`
  / `ServerInferResponse` patterns are replaced by Hono's equivalents.
- **The legacy `/api/*` Express layer is retired**. The business
  logic the v2 endpoints rely on has already been moved into the
  ts-rest handlers; the v2 → Hono cutover takes the legacy mount
  off the bus at the same time.

## Non-goals (this RFC)

- **Switching runtime away from Node.js**. `@hono/node-server` keeps
  the deployment story identical to today. Cloudflare Workers / Bun /
  Deno are theoretically possible but explicitly out of scope.
- **Replacing the auth, session, or logging stack**. The migration
  reuses the existing implementations via Hono-side adapters; this
  RFC does not redesign them.
- **Renaming or restructuring `@crowi/api-contract`**. The package
  name and `src/schemas/` + `src/contracts/` layout stay. (`src/
  contracts/` may be renamed to `src/routes/` as a low-risk follow-up;
  flagged in Open questions.)
- **Splitting Crowi's API into versioned packages or microservices**.
  `/api/v2` remains a single Hono app inside the existing api process.
- **Breaking changes to the public-facing `/api/v2/*` HTTP shape**.
  Paths, methods, request/response payloads, and error formats stay
  identical to what ts-rest produced. This is a framework swap, not
  a redesign.
- **Plugin contributions to the HTTP layer**. The plugin architecture
  is unaffected; if and when plugins want to contribute HTTP routes,
  that's a separate design.
- **GraphQL or other alternative API styles**. Out of scope.
- **External SDK generation in non-TypeScript languages**. The
  OpenAPI spec makes this possible in principle, but v2.2 only
  commits to the spec + TypeScript-generated types.
- **A staged / parallel-run migration**. ts-rest endpoints have not
  shipped to production, so there is no parallel-run phase to
  design. Every ts-rest contract is rewritten and removed in the
  same PR as its Hono replacement.
- **Wikilink crypto / activity / etc. semantics changes**. Schemas
  that contain RFC notes (`AttachmentUsageResponseSchema`,
  `WsTokenResponseSchema`, etc.) keep their semantics — only the
  wire-emission framework changes.

## Background

### Current state of `@crowi/api-contract`

The package already exists and is the canonical schema home. Concrete
shape today:

- **24 ts-rest contracts** assembled in `src/contracts/index.ts`:
  `app`, `auth` (legacy / to be removed), `installer`, `tokenAuth`,
  `me`, `page`, `pagePreview`, `pageCollab`, `presence`, `user`,
  `comment`, `bookmark`, `revision`, `notification`, `backlink`,
  `draft`, `autocomplete`, `attachment`, `adminCrypto`, `admin`
  (which itself aggregates 9 sub-contracts: app / auth / security /
  mail / share / storage / search / users / plugins), `search`.
- **Schemas under `src/schemas/`** are well-factored: shared bits
  (`common.ts`, `userPublic.ts`), feature-keyed files
  (`page.ts`, `attachment.ts`, `draft.ts`, `presence.ts`, etc.),
  and admin sub-schemas under `src/schemas/admin/`. Phase-specific
  RFC notes (RFC-0003, RFC-0004, RFC-0005) are embedded in the
  schema doc-comments.
- **`openapi.json` and `openapi.yaml` are committed** at the package
  root and regenerated by `pnpm generate-openapi`, which dispatches
  to `scripts/generate-openapi.js` and depends on the package being
  built first.
- **OpenAPI generation is via `@ts-rest/open-api`'s `generateOpenApi`**
  in `src/openapi.ts`.
- **Zod version**: per `package.json` the package depends on the
  workspace catalog version of `zod`. Pre-implementation discovery
  confirms which major (v3 / v4) before the migration starts.

The RFC-0003 / RFC-0004 / RFC-0005 endpoints (`yjs-token`,
`presence-token`, `likers`, drafts CRUD, autocomplete, attachment
upload) are already authored as ts-rest contracts. They are reauthored
against Hono rather than written fresh; the schemas backing them stay.

### Why ts-rest is being replaced

- v3.52.1 (Mar 2025) is the last stable release.
- v3.53.0 has been in RC since mid-2025; it carries Express 5, Zod 4,
  React Query 5, and Standard Schema support but has not been
  promoted to stable in roughly a year.
- Issue #797 "Future of ts-rest" documents the maintainers'
  reduced involvement and several users' migrations away.
- ~30 PRs sit unmerged at the time of writing.
- ~100 issues are open, with the typical age increasing.

The project is not dead, but it is not on a trajectory that supports
a long-lived OSS wiki's API foundation.

### Why oRPC was rejected

oRPC explicitly positions itself as a successor to ts-rest's
contract-first ergonomics and is technically the closest swap. It
was rejected on sustainability grounds: it is maintained by one
independent developer (unnoq), structurally identical to the risk
that brought down ts-rest's maintenance velocity. Picking oRPC would
re-run the same gamble.

### Why Hono + @hono/zod-openapi was chosen

- honojs is an organisation with multiple maintainers, not a
  one-person project.
- Cloudflare promotes Hono as the first-class Workers framework,
  giving the project sustained external interest.
- Web Standards (`Request` / `Response`) based, so the same code
  runs on Node.js, Bun, Deno, Workers, etc. Today we use Node.js;
  this just keeps the future open.
- `@hono/zod-openapi` produces OpenAPI 3.1 from Zod schemas with
  good fidelity, which is itself a vendor-neutral artefact.
- Hono's typed client (`hc<AppType>`) preserves the end-to-end
  type-safety story ts-rest provided.
- The escape hatch — generated OpenAPI spec + `openapi-typescript`
  — means even if Hono itself stalled later, the schema work would
  survive intact in a vendor-neutral format.

## Architecture overview

```
┌──────────────────────── api process ──────────────────────────────┐
│                                                                   │
│   Hono app (mounted at /api/v2)                                   │
│     ├─ OpenAPIHono instance + global middleware                   │
│     │     ├─ logger / cors                                        │
│     │     ├─ jwtAuth (auth)                                       │
│     │     ├─ jwtAdminRequired (admin subtree)                     │
│     │     ├─ defaultHook → validation error → ErrorSchema         │
│     │     └─ onError    → exception → ErrorSchema                 │
│     │                                                             │
│     ├─ /openapi.json    ◀─ OpenAPI 3.1 spec (Scalar / Swagger UI) │
│     ├─ /docs            ◀─ API reference UI                       │
│     │                                                             │
│     └─ openapi(route, handler) chain — one per resource           │
│            ├─ /pages/*              (page, pagePreview, collab)   │
│            ├─ /pages/:id/likers     (RFC-0005)                    │
│            ├─ /pages/:id/yjs-token  (RFC-0003)                    │
│            ├─ /pages/:id/presence-token (RFC-0005)                │
│            ├─ /pages/drafts/*       (RFC-0004)                    │
│            ├─ /pages/preview                                      │
│            ├─ /users/autocomplete   (RFC-0004)                    │
│            ├─ /pages/autocomplete   (RFC-0004)                    │
│            ├─ /attachments/*        (incl. /attachments/upload)   │
│            ├─ /comments/*  /bookmarks/*  /backlinks               │
│            ├─ /me/*                                               │
│            ├─ /user/:username/*                                   │
│            ├─ /notifications/*                                    │
│            ├─ /admin/*  (app/auth/security/mail/share/storage/    │
│            │             search/users/plugins/crypto)             │
│            └─ /search                                             │
│                                                                   │
│   Legacy /api/* Express mount  ◀─── REMOVED in this migration     │
│   ws noServer attachments: /collab, /presence  (untouched)        │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
                       ▲                  │
                       │                  │ HonoApp.getOpenAPIDocument()
                       │                  ▼
                       │       ┌─ scripts/generate-openapi.ts ─┐
                       │       │   writes:                      │
                       │       │   openapi.json                 │
                       │       │   openapi.yaml                 │
                       │       │   src/generated/openapi.ts     │
                       │       └────────────────────────────────┘
                       │                  ▲
                       │                  │ external consumers
                       │
        ┌──────────────┴──────────────┐
        │   Crowi web frontend         │
        │   ─ hc<AppType> typed client │
        │   ─ TanStack Query bindings  │
        │   ─ @crowi/api-contract      │
        └──────────────────────────────┘
```

The Hono app lives inside the existing api process. WebSocket
attachments (`/collab` for RFC-0003, `/presence` for RFC-0005) use
`noServer` mode on the underlying `http.Server` and are not affected
by the Express → Hono swap.

## Repo layout

`@crowi/api-contract` keeps its current structure with two additions:

```
packages/api-contract/
  src/
    schemas/                         (unchanged — same files, same exports)
      common.ts
      userPublic.ts
      page.ts
      attachment.ts
      draft.ts
      presence.ts
      collab.ts
      autocomplete.ts
      admin/
        app.ts
        auth.ts
        ...
      ...
    contracts/                       (existing folder, contents rewritten)
      index.ts                       (still aggregates everything)
      app.ts                         (was ts-rest c.router; now createRoute)
      auth.ts                        (legacy — slated for removal during cleanup)
      installer.ts
      tokenAuth.ts
      me.ts
      page.ts
      ...
      admin/
        index.ts
        app.ts
        ...
    client.ts                        (NEW — hc<AppType> factory)
    queries/                         (NEW — TanStack Query bindings)
      page.ts
      user.ts
      ...
    generated/                       (NEW — openapi-typescript output)
      openapi.ts
    openapi.ts                       (unchanged location, internals rewritten)
    index.ts                         (unchanged export surface)
  scripts/
    generate-openapi.ts              (rewritten — Hono → spec)
  openapi.json                       (regenerated by the new pipeline)
  openapi.yaml                       (regenerated by the new pipeline)
  package.json
  tsconfig.json
  tsup.config.ts
```

Re-exports from `src/index.ts` are preserved so downstream consumers
do not have to change imports.

## Schema migration

The schema files are already curated for Crowi semantics — none of
them need restructuring. The only changes per file:

- `import { z } from 'zod'` → `import { z } from '@hono/zod-openapi'`.
- Add `.openapi('<Name>')` to the outer object of response-shaped
  schemas (Page, Revision, UserPublic, Attachment, etc.) so the
  emitted OpenAPI uses named components.
- Optionally add `.openapi({ example: ... })` to fields where an
  example aids the published docs. Not required for the migration to
  succeed; can be done opportunistically.

Example diff for `schemas/common.ts`:

```diff
-import { z } from 'zod';
+import { z } from '@hono/zod-openapi';

-export const ApiErrorSchema = z.object({
+export const ApiErrorSchema = z.object({
   error: z.object({
     code: z.string(),
     message: z.string(),
     details: z.any().optional(),
   }),
-});
+}).openapi('ApiError');
```

The set of error schemas already in `common.ts` (`ApiErrorSchema`,
`AuthenticationRequiredErrorSchema`, `AdminRequiredErrorSchema`,
`ValidationErrorSchema`, `NotFoundErrorSchema`, `ConflictErrorSchema`,
`ServiceUnavailableErrorSchema`, etc.) carries over unchanged.
Resource-specific error schemas in attachment / draft / autocomplete
also carry over unchanged.

## Route definitions

`src/contracts/*.ts` is rewritten from `initContract().router({...})`
form to lists of `createRoute(...)` values. Aggregate exports in
`src/contracts/index.ts` change shape but remain a single import
surface.

Example diff sketch for `src/contracts/draft.ts`:

```diff
-import { initContract } from '@ts-rest/core';
-import { z } from 'zod';
+import { createRoute } from '@hono/zod-openapi';
+import { z } from '@hono/zod-openapi';
 import {
   CreateDraftRequestSchema,
   CreateDraftResponseSchema,
   DraftBadRequestErrorSchema,
   DraftNotFoundErrorSchema,
   DraftPathConflictErrorSchema,
   ListDraftsResponseSchema,
 } from '../schemas/draft';
 import { AuthenticationRequiredErrorSchema } from '../schemas/common';

-const c = initContract();
-
-export const draftContract = c.router({
-  createDraft: {
-    method: 'POST',
-    path: '/pages/drafts',
-    body: CreateDraftRequestSchema,
-    responses: {
-      201: CreateDraftResponseSchema,
-      400: DraftBadRequestErrorSchema,
-      401: AuthenticationRequiredErrorSchema,
-      409: DraftPathConflictErrorSchema,
-    },
-    summary: 'Create a new draft page at a path',
-  },
-  // ... listDrafts, cancelDraft
-});
+export const createDraftRoute = createRoute({
+  method: 'post',
+  path: '/pages/drafts',
+  request: {
+    body: { content: { 'application/json': { schema: CreateDraftRequestSchema } } },
+  },
+  responses: {
+    201: { content: { 'application/json': { schema: CreateDraftResponseSchema } }, description: '...' },
+    400: { content: { 'application/json': { schema: DraftBadRequestErrorSchema } }, description: '...' },
+    401: { content: { 'application/json': { schema: AuthenticationRequiredErrorSchema } }, description: '...' },
+    409: { content: { 'application/json': { schema: DraftPathConflictErrorSchema } }, description: '...' },
+  },
+  tags: ['drafts'],
+  summary: 'Create a new draft page at a path',
+});
+
+// listDraftsRoute, cancelDraftRoute ...
+
+export const draftRoutes = { createDraftRoute, listDraftsRoute, cancelDraftRoute };
```

The aggregate object (`apiContract` today) becomes an array / nested
object of route values that the api app's `OpenAPIHono` chain
references via `app.openapi(route, handler)`.

### `pathParams: z.object({...})` → `request.params`

ts-rest puts path params on the contract operation; `@hono/zod-openapi`
puts them under `request.params`. Mechanical translation per route.

### `query: ...` → `request.query`

Same pattern; ts-rest top-level `query` becomes `request.query`.

### `body: ...` → `request.body.content['application/json'].schema`

Slightly more verbose but identical semantics. For `multipart/form-data`
endpoints (attachment add, attachment upload, picture upload), the
content type is `multipart/form-data` and the schema declares the
`file` field as `z.any()` (as today).

### `c.router({ admin: c.router({ ... }) })` (nested)

Nested ts-rest routers (`adminContract` aggregates 9 sub-contracts)
unfold into a flat list of routes with path prefixes (`/admin/app`,
`/admin/auth`, etc.) — Hono's `OpenAPIHono` works in a flat namespace
inside the app, and path prefixing is done by the route's `path`.

## Handlers

Handlers live in the api app's Hono module (location decided during
discovery — likely `apps/api/src/hono/handlers/`). Each handler
imports the route from `@crowi/api-contract` and the services it needs:

```ts
// apps/api/src/hono/handlers/draft.ts (sketch)
import { honoApp } from '../app';
import { createDraftRoute, listDraftsRoute, cancelDraftRoute } from '@crowi/api-contract';
import { jwtAuth } from '../middleware/auth';

honoApp.use('/pages/drafts/*', jwtAuth);

const routes = honoApp
  .openapi(createDraftRoute, async (c) => {
    const user = c.get('user');
    const { path, initialBody } = c.req.valid('json');
    // ... existing draft-create logic from the ts-rest handler
  })
  .openapi(listDraftsRoute, async (c) => {
    // ... existing logic
  })
  .openapi(cancelDraftRoute, async (c) => {
    // ... existing logic
  });

export type DraftRoutes = typeof routes;
```

Business logic (services, models, error mapping) carries over from
the ts-rest handlers unchanged. The Hono handler is a thin layer
around it.

### Type chain for `AppType`

For `hc<AppType>` to work end-to-end, the `.openapi(...)` chain must
flow through to a single exported type. The api app's Hono entry
file collates the per-resource chains:

```ts
// apps/api/src/hono/index.ts
import { honoApp } from './app';

// each ./handlers/*.ts file extends `honoApp` via .openapi() chains
import './handlers/page';
import './handlers/draft';
import './handlers/autocomplete';
// ...

export type AppType = typeof honoApp;
```

The chain must remain unbroken; the Implementer is responsible for
ensuring the per-handler files re-chain instead of replacing.

## Middleware

### `jwtAuth` (authenticated routes)

Existing JWT auth wraps as a Hono middleware:

```ts
// apps/api/src/hono/middleware/auth.ts
import { createMiddleware } from 'hono/factory';

type AuthVars = { user: User };

export const jwtAuth = createMiddleware<{ Variables: AuthVars }>(async (c, next) => {
  const user = await verifyJwt(c.req.header('authorization'));
  if (!user) {
    return c.json(
      { error: { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication is required' } },
      401,
    );
  }
  c.set('user', user);
  await next();
});
```

The error shape matches `AuthenticationRequiredErrorSchema` exactly.

### `jwtAdminRequired` (admin subtree)

Same pattern, additionally checks `user.admin === true` and returns
`AdminRequiredErrorSchema` on 403. Applied as a subtree middleware on
`/admin/*`.

### Validation error formatting

`OpenAPIHono`'s `defaultHook` converts Zod failures into the standard
error shape:

```ts
const defaultHook = (result, c) => {
  if (!result.success) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: result.error.flatten(),
        },
      },
      400,
    );
  }
};
```

Note: some admin contracts currently use a richer `bodyResult.issues`
shape (see `AppSettingsValidationErrorSchema`). The migration preserves
that — those routes can override the default hook at the route level
to keep the existing wire shape.

### Exception handling

`onError` catches everything that escapes a handler. The mapping
follows the existing ts-rest error pipeline:

```ts
honoApp.onError((err, c) => {
  if (err instanceof PageNotFoundError) return c.json(...PAGE_NOT_FOUND..., 404);
  if (err instanceof PageNotGrantedError) return c.json(...PAGE_NOT_GRANTED..., 403);
  // ... matches the union of error schemas already declared
  log.error({ err }, 'unhandled api error');
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500);
});
```

### Existing route-level concerns

- **Multipart**: attachment add, attachment upload, profile picture
  upload. Hono's built-in body parser handles multipart; the
  bytes-handling layer (delegating to the storage driver) is unchanged.
- **Rate limiting**: autocomplete (60 req/min/user) and attachment
  upload (20 uploads/min/user, with `Retry-After`). The existing
  rate-limit middleware wraps as a Hono middleware applied to those
  route groups.
- **Token-bearer routes**: `/auth/*` (tokenLogin / refresh / logout /
  me). Header validation moves from the contract `headers` field into
  the JWT middleware itself.

## Mounting Hono in the api process

The Hono app replaces the existing ts-rest Express mount at `/api/v2`
and, in the same cutover, takes over from the legacy `/api/*` mount.

`@hono/node-server`'s `serve` exposes the Hono app on the api
process's `http.Server`. WebSocket attachments (`/collab`, `/presence`)
keep using `noServer` on the same `http.Server` exactly as today.

```ts
// apps/api/src/server.ts (sketch)
import { serve } from '@hono/node-server';
import { honoApp } from './hono';

const server = serve({ fetch: honoApp.fetch, port: PORT });
attachCollabWs(server); // unchanged from RFC-0003
attachPresenceWs(server); // unchanged from RFC-0005
```

If pre-implementation discovery surfaces concerns that require Express
to stay temporarily (static file serving, multipart edge cases), the
fallback is a thin `app.use('/api/v2', honoExpressAdapter)` mount.
Discovery decides.

## Frontend integration

### Typed client

```ts
// packages/api-contract/src/client.ts
import { hc } from 'hono/client';
import type { AppType } from '@crowi/api/hono';

export const createClient = (baseUrl: string) => hc<AppType>(baseUrl);
```

The `@crowi/api-contract` package depends on `@crowi/api` only for
the type import; this is type-only and does not introduce a runtime
dependency. (If circularity becomes an issue, the alternative is to
re-export the `AppType` from `@crowi/api-contract` itself by having
the api app augment it through a declared module — discovery picks the
cleaner option.)

### TanStack Query bindings

ts-rest's `@ts-rest/react-query` has no direct equivalent in the Hono
world. v2.2 adopts an explicit factory pattern under
`packages/api-contract/src/queries/`:

```ts
// packages/api-contract/src/queries/page.ts
import { client } from '../client-singleton';

export const pageQueries = {
  detail: (id: string) => ({
    queryKey: ['page', id] as const,
    queryFn: async () => {
      const res = await client.api.v2.pages[':id'].$get({ param: { id } });
      if (!res.ok) throw await res.json();
      return res.json();
    },
  }),
};
```

Components consume via `useQuery(pageQueries.detail(id))`. Pattern
is intentionally minimal — no library wrapper sits between
`hc<AppType>` and TanStack Query.

## OpenAPI generation pipeline

The existing pipeline (`scripts/generate-openapi.js` → `openapi.json`
+ `openapi.yaml`) is rewritten to source from the Hono app instead
of from `@ts-rest/open-api`'s `generateOpenApi`. The committed
artefact filenames stay the same.

### New generation script

```ts
// packages/api-contract/scripts/generate-openapi.ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { honoApp } from '@crowi/api/hono';

const doc = honoApp.getOpenAPIDocument({
  openapi: '3.1.0',
  info: { title: 'Crowi API', version: '2.0.0', description: 'API for Crowi - Markdown-based Wiki Application' },
  servers: [
    { url: 'http://localhost:3000/api/v2', description: 'Local development server' },
    { url: 'https://your-crowi-instance.com/api/v2', description: 'Production server' },
  ],
});

writeFileSync(join(__dirname, '../openapi.json'), JSON.stringify(doc, null, 2) + '\n');
writeFileSync(join(__dirname, '../openapi.yaml'), yaml.dump(doc));
```

OpenAPI version bumps from 3.0.2 → 3.1.0 (a Hono default). The change
is forward-compatible for the schemas in use.

### Generated TypeScript types

`openapi-typescript` runs as part of the package build:

```ts
// packages/api-contract/scripts/generate-openapi-types.ts
import { writeFileSync } from 'node:fs';
import openapiTS, { astToString } from 'openapi-typescript';

const ast = await openapiTS(new URL('../openapi.json', import.meta.url));
writeFileSync('./src/generated/openapi.ts', astToString(ast));
```

### npm scripts

Existing `generate-openapi` script is updated. Add `generate-openapi-types`
and a wrapper:

```json
{
  "scripts": {
    "generate-openapi": "tsx scripts/generate-openapi.ts",
    "generate-openapi-types": "tsx scripts/generate-openapi-types.ts",
    "generate": "pnpm generate-openapi && pnpm generate-openapi-types"
  }
}
```

### CI guard

```yaml
- run: pnpm --filter @crowi/api-contract generate
- run: git diff --exit-code packages/api-contract/openapi.json packages/api-contract/openapi.yaml packages/api-contract/src/generated/
```

If a PR changes any route or schema without regenerating, CI fails.

### Consumers, by use case

- **Crowi web frontend**: `hc<AppType>` direct from `@crowi/api-contract`.
- **Crowi-owned downstream tools** (admin tools, future mobile, etc.):
  `openapi-fetch` + `@crowi/api-contract`'s generated types module.
- **Third-party / non-TypeScript clients**: the committed `openapi.json`
  / `openapi.yaml` is the contract surface.

## Migration execution

ts-rest endpoints have not shipped to production. The migration is
executed without a parallel-run phase.

1. **Discovery PR (no functional change)**: Requirements Analyst
   produces `docs/migrations/0006-hono-context.md` (see "Pre-implementation
   discovery"). Confirms Zod version, the `/api/v2` mount mechanics,
   the `jwtAuth` / `jwtAdminRequired` middleware shapes, multipart
   handling, rate-limit implementations.

2. **Bootstrap PR**: in `@crowi/api-contract`, add the Hono peer-dep
   (`@hono/zod-openapi`), migrate `src/schemas/**` to import `z` from
   it (mechanical change, no functional diff), regenerate
   `openapi.json` / `openapi.yaml` (still emitted by `@ts-rest/open-api`
   in this PR — both generators must produce identical output on the
   migrated schemas before progressing). In `@crowi/api`, scaffold
   the Hono app (`apps/api/src/hono/app.ts`), wire `jwtAuth` /
   `jwtAdminRequired` / `defaultHook` / `onError`, and mount Hono at
   `/api/v2` alongside (not replacing) the existing ts-rest mount.
   ts-rest still owns every route.

3. **Pilot resource — `app` (smallest, single endpoint)**: rewrite the
   ts-rest contract as `createRoute`, port the handler to Hono, remove
   the ts-rest version from the contract index, regenerate the spec,
   delete the ts-rest mount entry for this resource, port the
   frontend call sites. Verifies the round-trip pattern on the
   simplest possible case. CI's `git diff --exit-code` proves
   nothing else changed.

4. **Bulk resource PRs**: one PR per resource, in this order to keep
   diffs reviewable:
   - `app`, `installer`, `auth` (legacy), `tokenAuth`
   - `me`, `user`
   - `bookmark`, `backlink`, `comment`, `revision`, `notification`
   - `page`, `pagePreview`
   - `pageCollab`, `presence` (RFC-0003 / RFC-0005)
   - `draft`, `autocomplete`, `attachment` (RFC-0004)
   - `search`
   - `adminCrypto`
   - `admin` (the big one — split into one PR per sub-contract:
     app / auth / security / mail / share / storage / search / users
     / plugins)

5. **Spec generator swap PR**: once every resource is on Hono, replace
   `scripts/generate-openapi.js` (the `@ts-rest/open-api` version)
   with `scripts/generate-openapi.ts` (the Hono version). Same input,
   same output filenames, slightly different OpenAPI version (3.0.2
   → 3.1.0). The `openapi.json` / `openapi.yaml` diff is reviewed
   here — anywhere the diff isn't purely the OpenAPI version bump
   is investigated before merge.

6. **Cleanup PR**:
   - Remove `@ts-rest/*` dependencies from `@crowi/api-contract` and
     `@crowi/api`.
   - Remove the legacy `/api/*` Express mount.
   - Remove `initContract()` aggregation in `src/contracts/index.ts`
     (replaced by per-resource route exports).
   - Add the OpenAPI docs UI route (`/api/v2/docs`, Scalar API
     Reference).
   - Add `openapi-typescript` types module to the build pipeline,
     commit `src/generated/openapi.ts`.
   - Update package `README.md`, write ADR at `docs/adr/0001-migrate-to-hono.md`.

7. **End-to-end soak**: full v2.2 test suite on a staging deploy for at
   least a week before the release branch is cut.

## Endpoint inventory

The full set of `/api/v2/*` endpoints to migrate (24 contracts,
flattening admin sub-contracts):

| Resource | Contract file | Endpoints |
|---|---|---|
| app | `app.ts` | `GET /app/info` |
| auth (legacy) | `auth.ts` | login / register pages + posts, login error |
| installer | `installer.ts` | `GET /installer`, `POST /installer/createAdmin` |
| tokenAuth | `tokenAuth.ts` | `/auth/login`, `/auth/register`, `/auth/refresh`, `/auth/logout`, `/auth/me` |
| me | `me.ts` | profile CRUD, picture, password, API token, recently-viewed |
| page | `page.ts` | full page CRUD + seen / like / watch / rename / delete |
| pagePreview | `page-preview.ts` | `POST /pages/preview` |
| pageCollab | `page-collab.ts` | `GET /pages/:id/yjs-token` (RFC-0003) |
| presence | `presence.ts` | `GET /pages/:id/presence-token`, `GET /pages/:id/likers` (RFC-0005) |
| user | `user.ts` | `GET /user/:username`, bookmarks, pages |
| comment | `comment.ts` | list / add / delete |
| bookmark | `bookmark.ts` | get / list / add / remove |
| revision | `revision.ts` | list / get one / get many |
| notification | `notification.ts` | list / mark-all-read / open / status |
| backlink | `backlink.ts` | `GET /backlinks` |
| draft | `draft.ts` | `/pages/drafts` create / list / cancel (RFC-0004) |
| autocomplete | `autocomplete.ts` | `/users/autocomplete`, `/pages/autocomplete` (RFC-0004) |
| attachment | `attachment.ts` | list / add / usage / meta / upload / remove (RFC-0004) |
| adminCrypto | `adminCrypto.ts` | `/admin/crypto/status`, `/admin/crypto/reencrypt` |
| admin.app | `admin/app.ts` | `/admin/app` GET/PUT |
| admin.auth | `admin/auth.ts` | `/admin/auth` GET/PUT |
| admin.security | `admin/security.ts` | `/admin/security` GET/PUT |
| admin.mail | `admin/mail.ts` | `/admin/mail` GET/PUT, `/admin/mail/test` POST |
| admin.share | `admin/share.ts` | `/admin/share` GET/PUT |
| admin.storage | `admin/storage.ts` | `/admin/storage` GET |
| admin.search | `admin/search.ts` | `/admin/search` GET |
| admin.users | `admin/users.ts` | list / search / invite / edit / makeAdmin / removeFromAdmin / activate / suspend / resetPassword / updateUserEmail |
| admin.plugins | `admin/plugins.ts` | list / config GET/PUT / clear-render-cache (all / per-plugin) |
| search | `search.ts` | `GET /search` |

The documentation UI (`/api/docs`, served by Scalar) is added in the
cleanup PR.

## Pre-implementation discovery

Before opening the bootstrap PR, an inventory is produced and
committed as `docs/migrations/0006-hono-context.md` covering:

- **Zod version in use** and `@hono/zod-openapi` compatibility
  confirmation. The package.json's `catalog:` resolves at install
  time — discovery records the resolved version.
- **Exact `/api/v2` mount mechanics** in `apps/api/src/server.ts` (or
  wherever the ts-rest mount currently lives), and whether anything
  else in the api process expects an Express request pipeline at that
  prefix.
- **Multipart handling**: `attachment.add`, `attachment.upload`,
  `me.uploadPicture`. Confirm which body parser is in use and that
  Hono's native multipart support is adequate; if not, document the
  workaround.
- **Rate-limit middleware** internals: how the autocomplete (60/min)
  and attachment upload (20/min) limits are currently enforced; map
  to a Hono middleware.
- **Error mapping**: enumerate the existing `onError`-equivalent
  pipeline (today inside ts-rest), so the Hono `onError` reproduces
  every existing 4xx / 5xx mapping byte-for-byte.
- **`jwtAuth` / `jwtAdminRequired` implementation files**: location,
  user-attach mechanism (today probably `req.user`; on Hono it
  becomes `c.set('user', ...)`).
- **Any non-route consumer of `apiContract` or `initClient`**: e.g.
  test fixtures, type-only imports, runner-level wrappers. Each is
  a touch point during the bulk PRs.
- **Frontend ts-rest client usage map**: where `ServerInferRequest` /
  `ServerInferResponse` / `initQueryClient` are imported, so the
  bulk PRs can plan call-site updates per resource.

The artefact is the input every subsequent PR references.

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Zod version incompatible with `@hono/zod-openapi` | Low | High | Resolved in discovery; bump or pin before bootstrap PR |
| Bootstrap-PR spec-generator parity slips | Medium | Medium | The `@ts-rest/open-api` and `@hono/zod-openapi` outputs for migrated schemas must diff to zero before progressing past bootstrap |
| Auth middleware behaves subtly differently after port | Medium | High | Port existing integration tests per resource PR; CI runs them against Hono |
| `multer`-shaped upload handling doesn't map to Hono cleanly | Medium | Medium | Discovery confirms current multipart pipeline; attachment.upload is among the last bulk PRs so the pattern is well-trodden by then |
| `hc<AppType>` type inference degrades vs ts-rest's `initClient` | Low | Medium | Verified on the pilot resource (`app`) before bulk work; require the `.openapi(...)` chain stays unbroken across handler files |
| OpenAPI spec and `hc<AppType>` drift apart | Low | Medium | Both are produced from the same `honoApp` instance; CI diff-check on the committed `openapi.json` / `openapi.yaml` and `src/generated/openapi.ts` catches drift |
| Removing the legacy `/api/*` mount breaks something we missed | Low | High | The cleanup PR is the last step; removal is preceded by a grep audit and the soak window. If anything still references it, it surfaces during soak rather than at release. |
| `OpenAPI 3.0.2 → 3.1.0` bump breaks an external consumer | Low | Low | The spec is committed; the bump diff is reviewed in PR 5 (spec generator swap). External consumers see the change on next pull |
| Web frontend's TanStack Query call sites are tangled with the ts-rest client wrapper | Medium | Medium | Resource PRs include the call-site update; do not split frontend / backend across PRs |
| Admin sub-contract PRs balloon in size | Medium | Low | Admin migration splits per sub-contract (app / auth / security / etc.), not all at once |

## Resolved decisions

1. **Framework**: Hono + `@hono/zod-openapi`. oRPC rejected on
   sustainability grounds (single maintainer), tRPC rejected because
   its OpenAPI story is plugin-bound and weakening.
2. **Package**: `@crowi/api-contract` keeps its name, location, and
   role as the single source of truth.
3. **Schemas migrate in place**. Files are unchanged in shape; only
   the `import` line and optional `.openapi(...)` decorations change.
4. **Routes**: `src/contracts/*.ts` is rewritten from ts-rest
   `c.router({...})` to `createRoute(...)`. (Renaming the folder to
   `src/routes/` is a follow-up — see Open questions.)
5. **Runtime**: Node.js via `@hono/node-server`. Workers / Bun / Deno
   are non-goals.
6. **Legacy `/api/*` Express mount is removed** as part of the cleanup
   PR. No business logic remains there that the v2 endpoints depend on.
7. **No parallel run**: each resource PR removes ts-rest in the same
   commit as it adds the Hono replacement. The bootstrap PR is the
   only one with both frameworks present, and only because no resource
   has yet been migrated.
8. **`AppType` chain**: must be kept unbroken via the
   `.openapi(...)` chain. `apps/api/src/hono/index.ts` exports the
   final `AppType`.
9. **TanStack Query bindings**: hand-rolled factory pattern in
   `packages/api-contract/src/queries/`. No third-party wrapper.
10. **OpenAPI is a committed artefact**: `openapi.json` and
    `openapi.yaml` continue to live at the package root; the
    `openapi-typescript`-generated types module lives at
    `src/generated/openapi.ts`. CI fails if any of the three drifts
    from the live Hono app.
11. **OpenAPI version**: bumps 3.0.2 → 3.1.0 (Hono default). Reviewed
    in PR 5.
12. **Docs UI**: Scalar API Reference at `/api/v2/docs`. Hono's
    built-in swaggerUI was considered but Scalar is more pleasant
    out of the box.
13. **Error shape**: the existing `@crowi/api-contract` error schemas
    (`ApiErrorSchema`, `AuthenticationRequiredErrorSchema`, etc.)
    are preserved exactly. Clients see no observable difference.
14. **Cleanup**: `@ts-rest/*` dependencies are removed in the final
    PR; `grep -r 'ts-rest' .` is the gate.

## Open questions

1. **Rename `src/contracts/` to `src/routes/`?** The folder name was
   accurate when its contents were ts-rest contracts; once they are
   Hono `createRoute` values, "routes" reads more naturally. Lean:
   yes — but rename in a separate post-migration PR to keep the
   per-resource diffs focused. The migration itself uses the existing
   `contracts/` folder.

2. **`AppType` placement — `@crowi/api` or `@crowi/api-contract`?**
   Hono's typed client needs the final chained type. Two patterns
   work:
   - `@crowi/api` exports `AppType`; `@crowi/api-contract` does a
     type-only import. Simpler, but introduces a (type-only) cycle.
   - `@crowi/api-contract` declares an `AppType` shape that the api
     side augments via module augmentation. More indirect but
     dependency-clean.
   Discovery picks one based on the actual tsconfig / project
   reference graph. Lean: option 1 (type-only cycles are normal in
   monorepos with workspace references).

3. **OpenAPI 3.1 vs sticking with 3.0.2.** Hono's `getOpenAPIDocument`
   produces 3.1 by default. The schemas in use are compatible with
   either. Sticking with 3.0.2 would minimise external-consumer churn;
   moving to 3.1 unlocks `examples` arrays and `null` as a type. Lean:
   bump to 3.1.

4. **Admin sub-contract paths.** Today admin sub-contracts are nested
   under `c.router({ admin: c.router({ app: ... }) })`, which produces
   `/admin/app`. Hono is flat — routes specify `/admin/app` directly.
   No behaviour change, but the Implementer needs to consciously
   write the full path on each `createRoute`. Risk: missed prefix
   typo. Mitigation: a small unit test that checks every admin route
   path starts with `/admin/`.

5. **Validation error shape unification.** Today some admin contracts
   declare a custom `bodyResult.issues` shape (e.g.
   `AppSettingsValidationErrorSchema`) while most others use the
   shared `ValidationErrorSchema`. Should we unify in this migration
   or preserve? Lean: preserve. Unification is a separate concern.

6. **`@crowi/api-contract` dependency on `@crowi/api` for `AppType`**.
   If we go with Open question 2 option 1, the contract package
   imports a type from the api app. Some monorepo setups dislike this
   direction. Discovery confirms whether the project reference graph
   tolerates it; if not, option 2 is the fallback.

## Implementation plan (informational)

1. **Discovery artefact**: `docs/migrations/0006-hono-context.md`
   produced and committed (no code changes).
2. **Bootstrap PR**: dependencies added, schemas migrated to import
   from `@hono/zod-openapi`, scaffolded Hono app mounted at
   `/api/v2` alongside (not replacing) ts-rest, validation hook +
   error handler + auth middleware ready. ts-rest still owns every
   route. CI's `git diff --exit-code` on `openapi.json` /
   `openapi.yaml` proves the schema change is wire-format-neutral.
3. **Pilot PR — `app` resource**: rewrite `app.ts` contract,
   implement handler, remove ts-rest from this resource only,
   regenerate spec. Validates the pattern end-to-end.
4. **Bulk resource PRs**: in the order listed under
   "Migration execution".
5. **Spec generator swap PR**: replace `scripts/generate-openapi.js`
   (ts-rest) with `scripts/generate-openapi.ts` (Hono). Reviews the
   `openapi.json` / `openapi.yaml` diff.
6. **Cleanup PR**: remove `@ts-rest/*` deps, remove legacy `/api/*`
   Express mount, add `/api/v2/docs` (Scalar), add
   `openapi-typescript` types generation, update README + ADR.
7. **End-to-end soak**: full v2.2 suite on staging for at least a
   week.
