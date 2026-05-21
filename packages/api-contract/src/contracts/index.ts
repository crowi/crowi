import { initContract } from '@ts-rest/core';
import { pageContract } from './page';
import { pagePreviewContract } from './page-preview';
import { pageCollabContract } from './page-collab';
import { presenceContract } from './presence';
import { notificationContract } from './notification';
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
export const apiContract = c.router({
  page: pageContract,
  pagePreview: pagePreviewContract,
  pageCollab: pageCollabContract,
  presence: presenceContract,
  notification: notificationContract,
  draft: draftContract,
  autocomplete: autocompleteContract,
  attachment: attachmentContract,
  adminCrypto: adminCryptoContract,
  admin: adminContract,
  search: searchContract,
});
