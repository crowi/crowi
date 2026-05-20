import { initContract } from '@ts-rest/core';
import { authContract } from './auth';
import { installerContract } from './installer';
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

const c = initContract();

export const apiContract = c.router({
  auth: authContract, // Legacy - to be removed
  installer: installerContract,
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
