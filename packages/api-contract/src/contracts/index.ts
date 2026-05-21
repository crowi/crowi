import { initContract } from '@ts-rest/core';
import { pagePreviewContract } from './page-preview';
import { pageCollabContract } from './page-collab';
import { presenceContract } from './presence';
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
// Batch 4 (1/2) migrated `page` (14 endpoints — the largest single
// resource) to Hono. Its `createRoute(...)` objects live under
// `./page` and are re-exported above. The page handler does NOT
// install its own `createJwtAuth(crowi)` — the revision handler's
// broad apply on `/pages/*` is shared.
export const apiContract = c.router({
  pagePreview: pagePreviewContract,
  pageCollab: pageCollabContract,
  presence: presenceContract,
  draft: draftContract,
  autocomplete: autocompleteContract,
  attachment: attachmentContract,
  adminCrypto: adminCryptoContract,
  admin: adminContract,
  search: searchContract,
});
