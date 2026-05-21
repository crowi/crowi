import Crowi from 'src/crowi';
import { Express, Router } from 'express';
// RFC-0006 Phase 3 — `app` resource moved to Hono (handler:
// `packages/api/src/hono/handlers/app.ts`).
// RFC-0006 Phase 4 Batch 1 — `installer` + `tokenAuth` resources moved
// to Hono (`hono/handlers/installer.ts`, `hono/handlers/tokenAuth.ts`);
// the legacy `auth` SSR resource (`/api/v2/login` / `/api/v2/register`
// etc.) was deleted outright because no frontend consumer existed.
// The `publicRouter` Express stage was therefore retired — every
// remaining ts-rest resource needs auth.
// RFC-0006 Phase 4 Batch 2 — `me` + `user` resources moved to Hono
// (`hono/handlers/me.ts`, `hono/handlers/user.ts`). The ts-rest
// router files were deleted.
// RFC-0006 Phase 4 Batch 3 — `bookmark`, `backlink`, `comment`,
// `revision`, `notification` resources moved to Hono
// (`hono/handlers/{bookmark,backlink,comment,revision,notification}.ts`).
// The matching ts-rest router files were deleted.
// RFC-0006 Phase 4 Batch 4 — `page` (14 endpoints) and `pagePreview`
// resources moved to Hono (`hono/handlers/page.ts`,
// `hono/handlers/page-preview.ts`). The page handler does NOT install
// its own jwtAuth — the revision handler's broad apply on `/pages/*`
// is shared. See `hono/index.ts:buildHonoApp` for the register order.
// RFC-0006 Phase 4 Batch 5 — `pageCollab` (RFC-0003 wsToken) and
// `presence` (RFC-0005 presence token + Phase 3 likers) resources
// moved to Hono (`hono/handlers/page-collab.ts`,
// `hono/handlers/presence.ts`). Both reuse the revision handler's
// `/pages/*` jwtAuth apply (same dedupe-avoidance rationale as
// page / page-preview).
// RFC-0006 Phase 4 Batch 6 — `draft`, `autocomplete`, `attachment`
// resources (RFC-0004) moved to Hono (`hono/handlers/draft.ts`,
// `hono/handlers/autocomplete.ts`, `hono/handlers/attachment.ts`).
// attachment's multipart endpoints (`addAttachment` /
// `uploadAttachment`) are now Hono-native via `c.req.parseBody()`;
// multer is gone from those handlers. The streaming raw `GET
// /attachments/:id` / `GET /attachments/by-key/:key` routes stay on
// the Express bridge (still mounted via the legacy `/_api` /
// controllers path) until Phase 6 cleanup converts them to native
// Hono Response streams.
import searchRoutes from './search';
import attachmentStreamRoutes from './attachment-stream';
import adminCryptoRoutes from './adminCrypto';
import adminRoutes from './admin';
import jwtAuth from '../../middlewares/jwtAuth';
import jwtAdminRequired from '../../middlewares/jwtAdminRequired';
import Debug from 'debug';

const debug = Debug('crowi:routes:ts-rest');

export default (crowi: Crowi, app: Express) => {
  debug('Mounting ts-rest routes...');

  // ========================================
  // Authentication Layer Structure
  // ========================================
  // 1. Authenticated routes (JWT authentication required)
  // 2. Admin routes (JWT authentication + admin permission required)
  // ========================================
  // Public routes are now exclusively served by Hono (see
  // `packages/api/src/hono/handlers/`); no ts-rest public router is
  // mounted on `/api/v2` any more.

  // Authenticated Router - JWT authentication required
  const authenticatedRouter = Router();
  authenticatedRouter.use(jwtAuth(crowi)); // Apply JWT auth to all routes

  const searchRouter = searchRoutes(crowi, app);
  // The raw streaming attachment routes (`GET /attachments/by-key/*`
  // and `GET /attachments/:id`) stay on Express until Phase 6 — see
  // `routes/ts-rest/attachment-stream.ts` for the streaming-vs-Hono
  // rationale.
  const attachmentStreamRouter = attachmentStreamRoutes(crowi, app);

  debug('Mounting authenticated routes (JWT required)');
  authenticatedRouter.use(searchRouter);
  authenticatedRouter.use(attachmentStreamRouter);

  // Admin Router - JWT authentication + admin permission required
  const adminRouter = Router();
  adminRouter.use(jwtAdminRequired(crowi)); // Apply JWT auth + admin check

  const adminCryptoRouter = adminCryptoRoutes(crowi, app);
  const adminSubRouter = adminRoutes(crowi, app);

  debug('Mounting admin routes (JWT + admin required)');
  adminRouter.use(adminCryptoRouter);
  adminRouter.use(adminSubRouter);

  // Mount all routers under /api/v2
  app.use('/api/v2', authenticatedRouter);
  app.use('/api/v2', adminRouter);

  debug('All ts-rest routes mounted successfully');
};
