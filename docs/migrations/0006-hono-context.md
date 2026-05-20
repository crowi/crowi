# RFC-0006 — Pre-implementation discovery (Hono integration)

- **Status**: Phase 1 / Discovery (no code changes)
- **Owner**: RFC-0006 implementer
- **Last updated**: 2026-05-20
- **Companion docs**:
  [`docs/rfcs/0006-hono-integration.md`](../rfcs/0006-hono-integration.md),
  [`.feature-state/specs/feature-hono-integration.md`](../../.feature-state/specs/feature-hono-integration.md)

This document is the factual baseline that Phase 2–6 of RFC-0006 rely on.
Every claim is anchored to a file path on `main` at the time of writing.
Design intent and "what we will do" already live in the RFC; this doc is
deliberately limited to **current state**. Items still unconfirmed are
collected in §14 so the implementer for the right phase re-checks at the
moment that matters.

RFC narrative occasionally uses `apps/api/...` paths. The repo layout is
actually `packages/api/`, `packages/web/`, and `packages/api-contract/`;
this doc uses the real paths and the spec's `commitPlan` already follows
suit.

## Table of contents

1. Monorepo layout
2. Zod version
3. `/api/v2` mount mechanics
4. `jwtAuth` / `jwtAdminRequired`
5. Multipart endpoints
6. Rate-limit middleware
7. Error mapping
8. `apiContract` / `initClient` non-route consumers
9. Frontend ts-rest client usage map
10. OpenAPI pipeline (current state)
11. AppType placement — tsconfig observations
12. Collab / Presence WebSocket attaches
13. Misc. facts worth recording
14. Open items for re-confirmation in later phases

## 1. Monorepo layout

`pnpm-workspace.yaml` declares `apps/*` (only `apps/crowi-site` today)
and `packages/*` (everything else: api, api-contract, web, runner,
collab, plugin-*, admin-cli, tsconfig). Anywhere the RFC says
`apps/api/src/...` substitute `packages/api/src/...`; same for the planned
`apps/api/src/hono/...` → `packages/api/src/hono/...`.

## 2. Zod version

- Workspace catalog (`pnpm-workspace.yaml`) pins `zod: ^3.23.8`.
- `packages/api-contract/package.json`, `packages/api/package.json`, and
  `packages/web/package.json` all declare `"zod": "catalog:"`.
- `grep '@hono' packages/` returns 0 hits — no Hono dep is installed yet.

**Decision (2026-05-20, user, revisited after impl audit)**: Phase 2
bumps the catalog to **zod v4** while simultaneously **dropping
`@ts-rest/open-api`** — the latter was the only dependency that pinned
zod to v3 (its transitive `@anatine/zod-openapi` reads zod-v3 internal
`_def` fields at runtime). The replacement OpenAPI generator is Hono's
`honoApp.getOpenAPIDocument()`, so the Phase 5 "spec generator swap"
work is merged into Phase 2 commit 1.

Confirmed peer ranges (npm view, 2026-05-20):

- `@ts-rest/open-api` (any version) → peer `zod ^3.22.3` + transitive
  zod-v3-internal reader → **drop entirely in Phase 2**.
- `@ts-rest/core@3.53.0-rc.1` → no zod peer constraint → bump to this
  RC, keep it through Phase 4.
- `@ts-rest/express` → tracks `@ts-rest/core` → bump in sync.
- `@hono/zod-openapi@^1.4.0` → peer `zod ^4.0.0` → adopt.

The implementer for Phase 2 audits zod v3 → v4 breaking changes against
the schemas (`.nonempty()` on strings, `.passthrough()` semantics, error
issue shape, coerce behavior, custom error map shape, etc.) and updates
accordingly. The regenerated `openapi.json` / `openapi.yaml` will have a
near-empty `paths{}` (Hono has no routes yet — Phase 3/4 populates them)
but full `components.schemas`. Diff is expected to be dominated by
"ts-rest-derived metadata disappearing" + "zod v4 syntactic shifts" +
"openapi 3.0.2 → 3.1.0"; anything outside those three explanations is
investigated before the bootstrap commit lands.

## 3. `/api/v2` mount mechanics

HTTP entry layering (Phase-2 / Phase-3 needs every layer below):

1. `packages/api/src/crowi/index.ts:562` — `start()` calls
   `http.createServer(this.app)` then awaits the two WebSocket attaches
   before `server.listen()`. `buildServer()` at line 601 calls
   `expressInit(this, app)` followed by `routes(this, app)`.
2. `packages/api/src/crowi/express-init.ts` — global middleware order:
   `cors`, custom request-context middleware, `express.static`,
   `methodOverride()`, `express.urlencoded({ extended: true, limit:
   '50mb' })`, `express.json({ limit: '50mb' })`,
   `session(crowi.sessionConfig)`, `BasicAuth`, `passport.initialize()`,
   `passport.session()`, `connect-flash`, `LoginChecker`. **Body parsers
   run globally with `limit: '50mb'`**; per-route Multer caps are
   tighter.
3. `packages/api/src/routes/index.ts` — first call is
   `TsRestRoutes(crowi, app)`, then legacy mounts (`/_api`, `/admin`,
   `/login`, `/me`, plus `app.get('/...')` SSR routes).
4. `packages/api/src/routes/ts-rest/index.ts:106-108` — three
   `express.Router()` instances mounted in order
   (`publicRouter` → `authenticatedRouter` → `adminRouter`) all on
   `/api/v2`:
   - `publicRouter`: `appRoutes`, `authRoutes` (legacy), `installerRoutes`,
     `tokenAuthRoutes`.
   - `authenticatedRouter`: `.use(jwtAuth(crowi))` first, then per-resource
     sub-routers. Draft + autocomplete go ahead of `pages` so the literal
     `/pages/drafts` / `/pages/autocomplete` segments win the match
     before `/pages/:id`.
   - `adminRouter`: `.use(jwtAdminRequired(crowi))` then `adminCryptoRouter`
     + `adminSubRouter`.
5. Each sub-router calls `createExpressEndpoints(apiContract.<resource>,
   s.router(..., handlers), router)` (`@ts-rest/express`). Canonical
   minimal example: `packages/api/src/routes/ts-rest/app.ts`.

Mount order matters: public → authenticated → admin. The RFC
"Architecture overview" and "Mounting Hono" sections cover where the
new Hono mount slots in.

## 4. `jwtAuth` / `jwtAdminRequired`

- `packages/api/src/middlewares/jwtAuth.ts` — factory
  `export default (crowi) => async (req, res, next) => ...`.
  - Token extraction: `Authorization: Bearer <jwt>` first, then
    `crowi.accessToken` cookie (used by `<img src=>` style requests
    that cannot carry a header).
  - `jwtUtil.verifyToken(token, 'access')` → `User.findById(payload.userId)`.
  - **401 `AUTHENTICATION_REQUIRED`** on missing token / verify fail /
    user not found / unexpected exception. Body shape matches
    `AuthenticationRequiredErrorSchema` (no `redirectTo` on the error
    path).
  - **403 `USER_NOT_ACTIVE` / `USER_REGISTERED` / `USER_SUSPENDED` /
    `USER_INVITED`** on inactive user. Body matches
    `UserStatusErrorSchema` (`{ error: { code, message, redirectTo } }`).
  - On success: `req.user = user` (Mongoose `UserDocument`).
- `packages/api/src/middlewares/jwtAdminRequired.ts` — composes
  `jwtAuth(crowi)`; if `user.admin !== true` returns **403
  `ADMIN_REQUIRED`** matching `AdminRequiredErrorSchema`.
- `req.user` augmentation: `packages/api/src/types/express.ts` declares
  `Express.Request.user: UserDocument`. Stays valid for legacy routes
  even after Hono adoption.

RFC §"Middleware → jwtAuth / jwtAdminRequired" covers the Hono-side
wrap.

## 5. Multipart endpoints

`multer` (`^1.4.2`, `packages/api/package.json`) is the body parser.
Three v2 endpoints use it; one legacy `/_api/*` endpoint also uses it
and is removed in Phase 6.

| Endpoint | Source | Multer config |
| --- | --- | --- |
| `POST /api/v2/pages/:pageId/attachments` | `packages/api/src/routes/ts-rest/attachment.ts:217` | `multer({ dest: crowi.tmpDir })` — no multer-layer size cap; per-content-type cap enforced in-handler. |
| `POST /api/v2/attachments/upload` (editor) | `packages/api/src/routes/ts-rest/attachment.ts:260` | `multer({ dest: crowi.tmpDir, limits: { fileSize: UPLOAD_MULTER_MAX_BYTES } })` — 50 MB ceiling; per-intent cap (10 MB paste / 50 MB dnd) enforced in-handler. |
| `POST /api/v2/me/picture` | `packages/api/src/routes/ts-rest/me.ts:21` | `multer({ dest: crowi.tmpDir })`. |
| (legacy) `POST /_api/me/picture/upload` | `packages/api/src/routes/index.ts:25,98` | `multer({ dest: crowi.tmpDir + 'uploads' })`. Removed in Phase 6. |

All three v2 handlers invoke multer **inside** the ts-rest handler:
`upload.single('file')(req as Request, res as Response, async (err) => ...)`.
Parsed file at `req.file`, form fields at `req.body.<name>`.

Hono ships `c.req.parseBody()` / `c.req.formData()` natively.

**Decision (2026-05-20, user)**: Phase 4 attachment migration uses
**Hono-native `c.req.parseBody()`**; `multer` is dropped from the dep
tree. The editor-upload endpoint's `LIMIT_FILE_SIZE` early-rejection is
reproduced by reading `c.req.header('content-length')` and returning
413 before invoking `parseBody()`. Per-intent caps (paste 10 MB / dnd
50 MB) stay in the handler as today. `multer` itself can be removed in
the Phase 4 attachment commit if no legacy `_api` route still depends
on it, otherwise the removal slides to Phase 6 dep cleanup.

## 6. Rate-limit middleware

Single shared implementation at
`packages/api/src/util/rate-limit.ts`:
`createRateLimiter(options): RateLimiter`. **Not an Express middleware** —
exposes only `limiter.hit(userId)` returning
`{ allowed, count, limit, retryAfterSeconds }`. The handler invokes
`limiter.hit()` directly and writes `Retry-After` via
`res.setHeader('Retry-After', String(result.retryAfterSeconds))`.

Storage:

- Redis-backed when `crowi.redis` is set: one `INCR` + one `pExpire`
  per request, key
  `crowi:ratelimit:<name>:<userId>:<windowIndex>`.
- In-memory `Map` fallback when `crowi.redis === null` (single-instance
  dev). Lazy sweep on window roll-over.
- Fail-open: a Redis throw allows the request and emits a debug log
  (same posture as `editor-cap-counter.ts`).

Two call sites today:

| Endpoint group | File | Limit |
| --- | --- | --- |
| autocomplete (`/users/autocomplete`, `/pages/autocomplete`) | `packages/api/src/routes/ts-rest/autocomplete.ts:62-65` (constants at L18-19: `RATE_LIMIT = 60` / `RATE_WINDOW_MS = 60_000`) | name `'autocomplete'`, 60 req / 60_000 ms |
| attachment upload (`/attachments/upload`) | `packages/api/src/routes/ts-rest/attachment.ts:264` | name `'attachment-upload'`, 20 req / 60_000 ms |

429 body shape differs by endpoint and survives the migration unchanged:

- Autocomplete: inline body
  `{ error: 'rate_limited', message, retryAfterSeconds }` (no dedicated
  schema; defined per-handler).
- Attachment upload: shares
  `UploadAttachmentErrorCodeSchema = z.enum(['too_large',
  'disallowed_type', 'rate_limited', 'no_permission'])`
  (`packages/api-contract/src/schemas/attachment.ts:170`); the 429 body
  is constructed inline at
  `packages/api/src/routes/ts-rest/attachment.ts:754` with the
  `'rate_limited'` variant.

`createRateLimiter` is framework-agnostic and re-used as-is on the
Hono side.

## 7. Error mapping

ts-rest handlers in this repo **return** literal objects rather than
throwing: `{ status: <code> as const, body: { error: { code, message }
} }`. Distribution of explicit status codes in
`packages/api/src/routes/ts-rest/` (grep `'status:'` /
`{ status: <n>`, production files only):

| Status | Approx. return sites |
| --- | --- |
| 400 | 51 |
| 404 | 24 |
| 500 | 17 |
| 409 | 5 |
| 422 | 3 |
| 403 | 3 |
| 401 | 3 (handler-internal; `jwtAuth` covers most 401) |
| 429 | 2 (rate-limit) |
| 503 | 2 |

The only `throw new Error(...)` in production ts-rest code (i.e.
excluding `*.test.ts`) is `packages/api/src/routes/ts-rest/page.ts:343`
(`throw new Error('Failed to create page.')`), caught by ts-rest's
internal wrapper and surfaced as a generic 500.

Helper response literals in
`packages/api/src/util/ts-rest-helpers.ts`:
`pageNotFoundResponse` (404 `PAGE_NOT_FOUND`),
`invalidPageIdResponse` (400 `INVALID_PAGE_ID`),
`internalServerErrorResponse` (500 `INTERNAL_ERROR`),
`loadGrantedPage(...)` returns
`{ page } | { error: <one of the above> }`.

The legacy `errorBody(code, message)` helper inside `attachment.ts`
(raw Express routes mounted before the ts-rest endpoints) returns
`{ error: { code, message } }`.

RFC §"Exception handling" defines the Hono `onError` shape.

## 8. `apiContract` / `initClient` non-route consumers

`grep -rln "from '@crowi/api-contract'" packages/` outside the
contract package itself returns only **type / schema** consumers and
exactly one runtime consumer:

- `packages/web/src/lib/api-client.ts` — the **only** runtime consumer
  of `apiContract` + `initClient` (from `@ts-rest/core`); see §9.
- `packages/api/src/routes/ts-rest/**/*.ts` — every ts-rest route
  file uses the `initServer().router(apiContract.<resource>, {...})`
  pattern. Removed per resource in Phase 4.
- `packages/api/src/middlewares/jwtAuth.ts` and
  `.../jwtAdminRequired.ts` — import only schemas
  (`AuthenticationRequiredErrorSchema`, `AdminRequiredErrorSchema`,
  `UserStatusErrorSchema`) as `z.infer<>` sources.
- `packages/api/src/util/ts-rest-helpers.ts` — type-only imports
  (`PageUser`, `UserPublic`, `UserPublicStatus`).
- `packages/api/src/test/setup.ts` — no contract import; only filters
  `[ts-rest] Initialized ...` log lines from boot. Becomes dead string-
  match at end of Phase 4.
- `packages/plugin-api/src/routes.ts` — declares
  `PluginRouterScope.register<T extends AppRouter>(contract, impl)`
  using `AppRouter` from `@ts-rest/core`.
  `packages/api/src/plugin/plugin-manager.ts:314` flags
  `registerRoutes` as "wired in a later step" — **never invoked at
  runtime**, so removing the import does not break any live plugin.
- `packages/plugin-api/src/__fixtures__/example-plugin.ts` — build
  fixture using `registerRoutes`. Excluded from publication via
  `package.json:files`.

**Add to Phase 6 commitPlan**: clean up
`packages/plugin-api/src/routes.ts` +
`packages/plugin-api/src/__fixtures__/example-plugin.ts` together with
the dep removal. The implementer should run
`grep -r 'from .@ts-rest/core.' .` after dep removal as the final
gate.

## 9. Frontend ts-rest client usage map (`packages/web`)

The frontend's single runtime ts-rest dependency is
`packages/web/src/lib/api-client.ts`, which exports
`apiClient = initClient(apiContract, { baseUrl, baseHeaders, api })`.
The `api` callback implements the JWT refresh-token loop: on 401 it
posts `/api/v2/auth/refresh`, stores new tokens, and retries with the
refreshed Authorization header. This wrapper is **framework-agnostic**
(it wraps `fetch`) and the Phase 3 port preserves it byte-for-byte.

Verified counts (`packages/web/src/`, May 2026):

- `grep -rln 'apiClient\.' …` → **40 files** invoke
  `apiClient.<resource>.<endpoint>(...)`. No file invokes
  `initClient` directly.
- Of those 40, **34 are `use-*.ts` files** under
  `packages/web/src/lib/` (TanStack Query hooks; the directory has
  49 `use-*.ts` files in total, so 15 hooks do not touch
  `apiClient`).
- Remaining 6 direct call sites:
  - `packages/web/src/app/(public)/login/login-form.tsx`
  - `packages/web/src/app/(public)/register/register-form.tsx`
  - `packages/web/src/app/(public)/installer/installer-form.tsx`
  - `packages/web/src/components/editor/upload-placeholder.ts`
  - `packages/web/src/components/editor/autocomplete-extension.ts`
  - (one other; full enumeration in the Phase-3 PR)
- `grep -rln "import type.*from '@crowi/api-contract'"
  packages/web/src/` → **90 files**. Pure-type consumers (search-* /
  page-* / notification-* / admin-* etc.). They do **not** require
  rewrites at migration time — re-exports continue to be available
  because the schema files are unchanged.

The hook layout follows the CLAUDE.md `xxxKeys = { all, detail(id) }`
factory pattern. Representative example: `use-page.ts` (use as the
golden template when porting other hooks to `hc<AppType>` factories).

The Phase 3 / 4 frontend port is covered by RFC §"Frontend
integration".

## 10. OpenAPI pipeline (current state)

- Generator: `packages/api-contract/src/openapi.ts` calls
  `generateOpenApi(apiContract, { info, servers, components: {
  securitySchemes }, ... }, { setOperationId: true, jsonQuery: true })`
  from `@ts-rest/open-api`.
- Driver script: `packages/api-contract/scripts/generate-openapi.js`
  (CommonJS) `require()`s `../dist/index` (= the **built**
  `openApiDocument`), writes `openapi.json`, and additionally tries
  `js-yaml.dump(...)` to `openapi.yaml`.
- Committed artefacts at the package root:
  - `openapi.json` — 1376 lines, ~39 KB
  - `openapi.yaml` — 889 lines, ~25 KB
- Pre-build dependency: the script reads `dist/index.js`, so
  `pnpm --filter @crowi/api-contract build` must run before
  `generate-openapi`. The package `scripts` block reflects this.
- `@ts-rest/open-api` emits OpenAPI 3.0.2 (visible in the existing
  yaml header).
- No `src/generated/openapi.ts` exists today.

**Decision (2026-05-20, user)**: the spec generator swap originally
planned for Phase 5 is **merged into Phase 2 commit 1**. Reason:
`@ts-rest/open-api` is the only dependency that pins zod to v3 (see §2),
so removing it is the precondition for the Phase 2 zod-v4 bump. Once
the ts-rest openapi generator is gone, the Hono-based
`scripts/generate-openapi.ts` is the only one in the tree from Phase 2
onward. Phase 5 becomes an empty marker phase. The OpenAPI 3.0.2 →
3.1.0 bump happens at the same Phase 2 commit (Hono default).

RFC §"OpenAPI generation pipeline" remains accurate for the Phase 6
artefacts (`openapi-typescript` types module, CI gate) but the Phase 5
chronology no longer applies.

## 11. AppType placement — tsconfig observations

- `packages/tsconfig/` provides `library.json`, `app-node.json`,
  `app-web.json` presets.
- `packages/api-contract/tsconfig.json` extends `library.json`,
  `rootDir: ./src`, **no `references` block**.
- `packages/api/tsconfig.json` extends `app-node.json`, has
  `composite: true`, `declaration: true`, paths `src/* → src/*`, **no
  `references` block** to `@crowi/api-contract`.
- `packages/web/tsconfig.json` extends `app-web.json`, **no
  `references` block**.

There is **no TS project-reference graph today**. Cross-package types
resolve via pnpm workspace symlinks + each package's emitted
`dist/*.d.ts`. `composite: true` on `packages/api/tsconfig.json` is
unused by any consumer; the declarations are still emitted at build
time.

**Implication** (open question 2): with option 1
(`@crowi/api` exports `AppType`, `@crowi/api-contract` does a
type-only import), `@crowi/api-contract`'s `tsup` build needs
`@crowi/api/hono`'s `.d.ts` available — which means `@crowi/api`
must already be built (or `@crowi/api-contract`'s build must resolve
the type against `@crowi/api`'s source via the symlink). Whether
this works under a fresh `pnpm install + pnpm build` is the
build-order question the Phase 3 pilot resolves.

**Recommended Phase 3 smoke test** (mirrors RFC's lean toward
option 1; switch to option 2 only if step 3 below fails):

```bash
pnpm -w clean             # remove every dist/
pnpm install
pnpm --filter @crowi/api-contract build
# ↑ must succeed without @crowi/api being built first.
pnpm --filter @crowi/api build
pnpm --filter @crowi/web type-check
# ↑ hc<AppType> calls are type-safe end-to-end.
```

If step 3 fails complaining about a missing `@crowi/api/hono` type,
fall back to option 2 (only `packages/api-contract/src/client.ts`
changes).

## 12. Collab / Presence WebSocket attaches

- `packages/api/src/crowi/index.ts:562-576` calls
  `http.createServer(this.app)` then `await attachCollabServer(server,
  this)` and `await attachPresenceServer(server, this)` **before**
  `server.listen()`.
- `packages/api/src/collab/attach.ts:200` and
  `packages/api/src/presence/attach.ts:115` each call
  `new WebSocketServer({ noServer: true })` and listen for the http
  server's `'upgrade'` event with a path filter
  (`/collab/...` vs `/presence/...`).
- The collab attach owns Hocuspocus and (optionally) the
  `@hocuspocus/extension-redis` extension when `crowi.redis !== null`.

Both attaches install at the same `http.Server` so HTTP and WS share
one listener.

**Decision (2026-05-20, user)**: the final shape (after Phase 6) is
**Hono owns `http.Server`** — Express is removed entirely from
`packages/api/src/`. During Phase 2-4 the Hono mount lives as Express
middleware purely for implementation-order reasons (ts-rest depends on
`@ts-rest/express` and we don't migrate every route in one step). At
Phase 6 cleanup the `http.createServer(this.app)` call in
`crowi/index.ts:562` is replaced with
`serve({ fetch: honoApp.fetch, createServer: http.createServer, port })`;
the returned `http.Server` is then passed to `attachCollabServer` /
`attachPresenceServer`. The two `noServer` WebSocket attaches do not
change shape, only the source of the `http.Server` argument changes.

## 13. Misc. facts worth recording

- **`packages/web/src/lib/api-client.ts` refresh-token loop**: 401 →
  `/api/v2/auth/refresh` → retry-with-new-token. Lines 10–49. The
  rest of the app depends on this exact behaviour; Phase 3 ports it
  into the `hc<AppType>` factory's `fetch` option.
- **Schemas with embedded RFC notes** (`schemas/attachment.ts`,
  `schemas/draft.ts`, `schemas/autocomplete.ts`,
  `schemas/presence.ts`, `schemas/collab.ts`): RFC body comments are
  documentation, not behaviour. They survive Phase 2's mechanical
  `import { z } from 'zod'` → `'@hono/zod-openapi'` swap unchanged.
- **Custom validation-error shape**:
  `packages/api-contract/src/schemas/admin/app.ts:71` defines
  `AppSettingsValidationErrorSchema` with the `bodyResult.issues[]`
  shape; `packages/api-contract/src/schemas/admin/mail.ts:98` defines
  the analogous `MailSettingsValidationErrorSchema`. Hono's
  `defaultHook` writes `ValidationErrorSchema`'s flat shape — these
  two routes need a per-route `defaultHook` override at port time to
  preserve the existing wire shape (matches RFC open question 5's
  decision).
- **Admin sub-contract paths are already flat**: every admin
  sub-contract route declares the full `path: '/admin/<sub>...'`
  literal today (verified by grep — e.g.
  `packages/api-contract/src/contracts/admin/storage.ts:24,25` for
  `/admin/storage` / `/admin/search`). The nested
  `c.router({ admin: c.router({ ... }) })` aggregator is a TS
  namespacing convenience; the actual HTTP paths do not benefit from
  it. Translation to Hono is `createRoute({ path: '/admin/...' })`
  with the same string. The Phase 4 unit test
  (`packages/api-contract/src/contracts/admin/index.test.ts`) iterates
  every admin route and asserts `path.startsWith('/admin/')`.
- **`/admin/storage` and `/admin/search` are GET-only**: PUT does not
  exist (settings are environment-derived, not user-mutable). The
  migration preserves this; no schema change.

## 14. Open items for re-confirmation in later phases

Items still genuinely open after the 2026-05-20 user decisions (zod v4
bump, Hono-native multipart, Hono-owns-server final shape, OpenAPI 3.1).

- (Phase 2) Pin the exact published `@hono/zod-openapi` version whose
  `peerDependencies.zod` range accepts the chosen zod v4 line. Audit
  zod v3 → v4 breaking changes against the schemas — `.nonempty()`
  on strings, `.passthrough()` semantics, error issue shape, coerce
  behavior, custom error map shape, etc. — and update the schemas
  before the bootstrap commit.
- (Phase 2) Confirm whether `@hono/node-server`'s Express adapter
  preserves the body already parsed by upstream `express.json()`, or
  whether the global `express.json()` must be bypassed for `/api/v2`
  during Phase 2-4. The conflict goes away entirely at Phase 6 when
  Express is removed; the question is only about the same-process
  coexistence window. Suggested test during Phase 2: a tiny POST
  handler echoes `await c.req.json()`, curl sends a body, the result
  should equal what was sent.
- (Phase 3 pilot) Run the §11 build-order smoke test and lock in the
  final `AppType` placement (option 1 default, option 2 fallback).
- (Phase 4 attachment) Verify that `Content-Length` early-rejection
  on the editor-upload endpoint reproduces the multer
  `LIMIT_FILE_SIZE` behavior closely enough (no large body buffered
  before the 413 response). If not, slot a small streaming check in
  before `c.req.parseBody()`.
- (Phase 6) Re-grep `from '@ts-rest/core'` and `from 'express'` after
  dep removal. Audit `packages/plugin-api/src/routes.ts` +
  `packages/plugin-api/src/__fixtures__/example-plugin.ts` for
  dangling `AppRouter` imports — the Phase-6 `chore(deps)` commit
  must include `packages/plugin-api/` files.
- (Phase 6) Plan the Express → Hono migration of every middleware
  currently applied globally in `crowi/express-init.ts`: cors,
  session (with `connect-redis`), passport (passport-local +
  passport-google + …), `connect-flash`, `BasicAuth`, `LoginChecker`,
  request-context middleware. Pick replacements (`hono/cors`,
  `hono-sessions`, hand-rolled passport-equivalents, etc.) and
  validate auth flows survive (`/api/v2/auth/*` and any SSR auth
  paths) before deleting the Express middleware stack.
- (Phase 6) After the `http.Server` ownership swap to `serve({ fetch,
  createServer })`, smoke-test `/collab/*` and `/presence/*` WS
  upgrades against the new server. The two `attach*Server` helpers
  do not change but their argument source does.
- (Phase 6) Wire the
  `git diff --exit-code packages/api-contract/openapi.json
  packages/api-contract/openapi.yaml
  packages/api-contract/src/generated/` gate into the existing turbo
  lint / type-check pipeline. Preferred home: a
  `pnpm verify-openapi` script on `@crowi/api-contract` invoked by
  CI; the implementer confirms the exact CI shape when reaching
  Phase 6.
