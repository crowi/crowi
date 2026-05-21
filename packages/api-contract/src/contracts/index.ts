import { initContract } from '@ts-rest/core';
import { tokenAuthContract } from './tokenAuth';
import { meContract } from './me';
import { pageContract } from './page';
import { pagePreviewContract } from './page-preview';
import { pageCollabContract } from './page-collab';
import { presenceContract } from './presence';
import { userContract } from './user';
import { commentContract } from './comment';
import { bookmarkContract } from './bookmark';
import { revisionContract } from './revision';
import { notificationContract } from './notification';
import { backlinkContract } from './backlink';
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
export const apiContract = c.router({
  tokenAuth: tokenAuthContract,
  me: meContract,
  page: pageContract,
  pagePreview: pagePreviewContract,
  pageCollab: pageCollabContract,
  presence: presenceContract,
  user: userContract,
  comment: commentContract,
  bookmark: bookmarkContract,
  revision: revisionContract,
  notification: notificationContract,
  backlink: backlinkContract,
  draft: draftContract,
  autocomplete: autocompleteContract,
  attachment: attachmentContract,
  adminCrypto: adminCryptoContract,
  admin: adminContract,
  search: searchContract,
});
