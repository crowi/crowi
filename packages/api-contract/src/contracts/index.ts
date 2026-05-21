import { initContract } from '@ts-rest/core';
import { draftContract } from './draft';
import { autocompleteContract } from './autocomplete';
import { attachmentContract } from './attachment';
import { adminCryptoContract } from './adminCrypto';
import { adminContract } from './admin';
import { searchContract } from './search';

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

const c = initContract();

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
export const apiContract = c.router({
  draft: draftContract,
  autocomplete: autocompleteContract,
  attachment: attachmentContract,
  adminCrypto: adminCryptoContract,
  admin: adminContract,
  search: searchContract,
});
