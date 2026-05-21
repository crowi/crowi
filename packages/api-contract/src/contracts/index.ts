// Hono-style route exports (RFC-0006 Phase 3+). Resources migrated off
// ts-rest expose `createRoute(...)` objects rather than a `c.router`
// branch. Re-exported here so the package barrel surfaces them to both
// the `@crowi/api` handler chain and the OpenAPI generator.
export * from './app';
export * from './installer';
export * from './tokenAuth';
export * from './me';
export * from './user';
export * from './bookmark';
export * from './backlink';
export * from './comment';
export * from './revision';
export * from './notification';
export * from './page';
export * from './page-preview';
export * from './page-collab';
export * from './presence';
export * from './draft';
export * from './autocomplete';
export * from './attachment';
export * from './search';
export * from './adminCrypto';
export * from './admin';

// `auth` (legacy SSR) sub-contract was deleted in RFC-0006 Phase 4 Batch 1:
// frontend never called `apiClient.auth.*`, the actual login / register
// flow goes through the `tokenAuth` resource (`POST /api/v2/auth/login`
// etc.), and the SSR pages at `/login` / `/register` are served by the
// Express root routes — not under `/api/v2/`. The five legacy paths
// (`GET /api/v2/login`, `POST /api/v2/login`, `GET /api/v2/register`,
// `POST /api/v2/register`, `GET /api/v2/login/error/:reason`) carried no
// production traffic, so we drop them in this phase rather than porting
// them.
//
// Batch 2 migrated `me` and `user` to Hono — both now expose
// `createRoute(...)` definitions via `./me` and `./user`. The legacy
// ts-rest `meContract` / `userContract` branches were dropped from the
// aggregator below.
//
// Batch 3 migrated `bookmark` / `backlink` / `comment` / `revision` /
// `notification` to Hono — their `createRoute(...)` objects live under
// `./bookmark` / `./backlink` / `./comment` / `./revision` /
// `./notification` and are re-exported above.
//
// Batch 4 migrated `page` (14 endpoints — the largest resource) and
// `pagePreview` (1 endpoint) to Hono. Their `createRoute(...)` objects
// live under `./page` / `./page-preview` and are re-exported above.
// The page handler does NOT install its own `createJwtAuth(crowi)` —
// the revision handler's broad apply on `/pages/*` is shared.
//
// Batch 5 migrated `pageCollab` (1 endpoint — RFC-0003 wsToken) and
// `presence` (2 endpoints — RFC-0005 presence token + likers) to Hono.
// Both reuse the revision handler's `/pages/*` jwtAuth apply (same
// dedupe-avoidance rationale as page / page-preview). The `createRoute(
// ...)` objects live under `./page-collab` / `./presence` and are
// re-exported above; the matching `apiContract` entries were dropped.
//
// Batch 6 migrated `draft` (3 endpoints), `autocomplete` (2 endpoints),
// and `attachment` (6 endpoints — multipart `addAttachment` /
// `uploadAttachment` are Hono-native via `c.req.parseBody()`) to Hono.
// `attachment` installs `createJwtAuth(crowi)` on `/attachments/*` itself
// (a path family OUTSIDE the revision-owned `/pages/*` apply);
// `autocomplete` installs jwtAuth on the bare `/users/autocomplete`
// path (its `/pages/autocomplete` sibling rides on the revision apply).
// `draft` rides on the revision apply entirely (`/pages/drafts*`). The
// rate-limit middleware (`hono/middleware/rate-limit.ts`) wraps both
// autocomplete routes (60/min) and `uploadAttachment` (20/min).
//
// Batch 7 migrated `search` (1 endpoint, `GET /search`) to Hono. The
// handler installs `createJwtAuth(crowi)` on the singleton literal path
// itself — same install pattern as `/users/autocomplete`. No rate
// limit (driver latency naturally throttles bursts). The 503
// `SERVICE_UNAVAILABLE` fallback when no `@crowi/plugin-search-*` is
// registered is preserved byte-identical with the ts-rest era.
//
// Batch 8 migrated `adminCrypto` (2 endpoints, `/admin/crypto/status` +
// `/admin/crypto/reencrypt`) to Hono. The handler installs
// `createJwtAdminRequired(crowi)` per-path (same single-route install
// pattern as `search`'s `/search` apply, but with the admin-required
// factory — first time `jwtAdminRequired` lands on Hono).
//
// Batch 9 migrated the remaining 9 admin sub-contracts (`app`, `auth`,
// `security`, `mail`, `share`, `storage`, `search`, `users`, `plugins`)
// to Hono — `createRoute(...)` definitions live under
// `./admin/<sub>.ts` and are re-exported via `./admin/index.ts`. With
// this, the ts-rest `apiContract` aggregator no longer holds any
// entries; `@ts-rest/core` is still a dependency of `@crowi/api-contract`
// (it remains in lockfile for the `@ts-rest/express` Express bridge
// until Phase 6) but no longer used here.
