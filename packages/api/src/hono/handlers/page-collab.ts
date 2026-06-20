/**
 * RFC-0006 Phase 4 Batch 5 — `pageCollab` resource Hono port.
 *
 * Replaces `packages/api/src/routes/ts-rest/page-collab.ts`. Single
 * endpoint:
 *
 *   GET /pages/:id/yjs-token — Hocuspocus connection wsToken (RFC-0003)
 *
 * Auth is shared with the `page` / `page-preview` / `presence` resources:
 * the `revision` handler already applies `createJwtAuth(crowi)` broadly
 * to `/pages/*` (see `packages/api/src/hono/handlers/revision.ts`), so
 * this handler relies on the established register order (`revision ->
 * page -> page-preview -> pageCollab -> presence -> notification` in
 * `buildHonoApp`) and does NOT install jwtAuth itself. Hono does not
 * dedupe middleware by reference; re-installing it would cost a second
 * JWT verify + `User.findById` per request. See the page handler file
 * header for the longer rationale.
 *
 * Behaviour parity (wire-format / authorisation):
 *
 *  - 401 if no Authorization header (handled by `createJwtAuth`).
 *  - 400 INVALID_PAGE_ID if `:id` is not a 24-char hex ObjectId
 *    (`isValidObjectId` short-circuit before `loadGrantedPage`).
 *  - 404 PAGE_NOT_FOUND for missing pages or grant-denied callers
 *    (`loadGrantedPage` collapses both — page existence is never leaked).
 *  - 404 PAGE_NOT_FOUND for non-author callers on draft pages (RFC-0004
 *    first gate; the second is Hocuspocus `onAuthenticate`).
 *  - 500 INTERNAL_ERROR on signing exception.
 *
 * The cap stub is shared with the ts-rest era: `checkEditorCap` returns
 * `{ readonly: false }` until Phase 6 wires the Redis-backed counter.
 * Tests inject a fake counter via `_setEditorCapCounterForTesting` to
 * exercise the readonly=true branch.
 */
import { getYjsTokenRoute } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';

import type Crowi from 'src/crowi';
import { STATUS_DRAFT } from 'src/models/page';
import { checkEditorCap } from 'src/util/collab-cap';
import { isValidObjectId, loadGrantedPage } from 'src/util/ts-rest-helpers';
import { createWsTokenUtil } from 'src/util/ws-token';

import type { CrowiHonoBindings } from '../app';

import { INTERNAL_ERROR_BODY, INVALID_PAGE_ID_BODY, PAGE_NOT_FOUND_BODY } from './_helpers/errors';

const debug = Debug('crowi:hono:handlers:page-collab');

export const registerPageCollabRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  const Page = crowi.model('Page');

  // Resolve / sign helper once per server (closure-captures the secret).
  // The handler captures this at construction time, so any test that
  // mutates `WS_TOKEN_SECRET` after server boot must set the env var
  // BEFORE `src/test/setup` imports the app (see the test file header).
  const wsTokenUtil = createWsTokenUtil();

  return app.openapi(getYjsTokenRoute, async (c) => {
    const user = c.get('user');
    const { id: pageId } = c.req.valid('param');

    debug('getYjsToken called', { pageId, userId: user._id.toString() });

    if (!isValidObjectId(pageId)) {
      return c.json(INVALID_PAGE_ID_BODY, 400);
    }

    const loaded = await loadGrantedPage(Page, pageId, user);
    if ('error' in loaded) {
      return c.json(PAGE_NOT_FOUND_BODY, 404);
    }

    // RFC-0004: a draft page is editable only by its author. The collab
    // WebSocket carries the wsToken minted here, so refusing to sign a
    // token for a non-author is the first of the two draft gates (the
    // second is the Hocuspocus `onAuthenticate` hook). Collapse "draft
    // owned by someone else" into the same 404 the grant check uses so
    // draft existence is never leaked.
    if (loaded.page.status === STATUS_DRAFT && !loaded.page.isCreator(user)) {
      debug('getYjsToken rejected: draft page %s not owned by %s', pageId, user._id.toString());
      return c.json(PAGE_NOT_FOUND_BODY, 404);
    }

    try {
      const { readonly } = await checkEditorCap(crowi, pageId);
      const { token, expiresAt } = wsTokenUtil.signWsToken({
        userId: user._id.toString(),
        pageId,
        readonly,
      });

      // editor-preview-reliability §1A: hand the client the page's
      // latest revision id so it can pin an edit base and echo it back
      // in `crowi:save` (`baseRevisionId`). The collab save flow then
      // optimistic-locks against `page.currentRevision`. Fall back to
      // the legacy `revision` pointer (v1.x pages lack `currentRevision`)
      // and serialize `null` when the page has no revision yet. Note
      // `loadGrantedPage` POPULATES `revision` into a full document, so
      // resolve `._id` when the value is a populated subdocument while
      // `currentRevision` stays a bare ObjectId.
      const resolveRevisionId = (ref: unknown): string | null => {
        if (ref == null) return null;
        if (typeof ref === 'object' && '_id' in ref) {
          const id = (ref as { _id: unknown })._id;
          return id == null ? null : String(id);
        }
        return String(ref);
      };
      const currentRevision = resolveRevisionId(loaded.page.currentRevision) ?? resolveRevisionId(loaded.page.revision);

      return c.json(
        {
          wsToken: token,
          pageId,
          expiresAt: expiresAt.toISOString(),
          readonly,
          currentRevision,
        },
        200,
      );
    } catch (err) {
      debug('wsToken signing failed:', (err as Error).message);
      return c.json(INTERNAL_ERROR_BODY, 500);
    }
  });
};
