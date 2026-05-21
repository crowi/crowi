/**
 * RFC-0006 Phase 4 Batch 5 — `presence` resource Hono port.
 *
 * Replaces `packages/api/src/routes/ts-rest/presence.ts`. Two endpoints:
 *
 *   GET /pages/:id/presence-token — RFC-0005 viewer presence wsToken
 *   GET /pages/:id/likers         — RFC-0005 Phase 3 liker list
 *
 * Auth shared with `page` / `page-preview` / `pageCollab`: the
 * `revision` handler installs `createJwtAuth(crowi)` broadly on
 * `/pages/*` (see `packages/api/src/hono/handlers/revision.ts`); this
 * handler relies on register order (`revision -> page -> page-preview ->
 * pageCollab -> presence -> notification` in `buildHonoApp`) and does
 * NOT re-install jwtAuth — Hono does not dedupe middleware references.
 *
 * Behaviour parity (wire-format / authorisation), both endpoints:
 *
 *  - 401 if no Authorization header (`createJwtAuth`).
 *  - 400 INVALID_PAGE_ID for non-hex `:id`.
 *  - 404 PAGE_NOT_FOUND for missing-or-not-granted (existence leak
 *    guard collapses both — same as collab / page resources).
 *  - 500 INTERNAL_ERROR on signing / DB exception.
 *
 * Unlike `pageCollab`, there is no draft-author gate: presence is
 * read-only viewer tracking, so any user with read grant can appear in
 * the viewer list. A non-author already gets the 404 from
 * `loadGrantedPage` when the page is private.
 */
import { type Liker, getLikersRoute, getPresenceTokenRoute } from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';

import type Crowi from 'src/crowi';
import type { UserDocument } from 'src/models/user';
import ActivityDefine from 'src/util/activityDefine';
import { createPresenceTokenUtil } from 'src/util/presence-token';
import { isValidObjectId, loadGrantedPage } from 'src/util/ts-rest-helpers';

import type { CrowiHonoBindings } from '../app';

import { INTERNAL_ERROR_BODY, INVALID_PAGE_ID_BODY, PAGE_NOT_FOUND_BODY } from './_helpers/errors';

const debug = Debug('crowi:hono:handlers:presence');

export const registerPresenceRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  const Page = crowi.model('Page');
  const User = crowi.model('User');
  const Activity = crowi.model('Activity');

  // Resolve / sign helper once per server (closure-captures the secret).
  // Same construction-time-capture caveat as `pageCollab`: tests pin
  // `WS_TOKEN_SECRET` before importing `src/test/setup`.
  const presenceTokenUtil = createPresenceTokenUtil();

  return (
    app
      // --------------------------------------------------------------
      // GET /pages/:id/presence-token
      // --------------------------------------------------------------
      .openapi(getPresenceTokenRoute, async (c) => {
        const user = c.get('user');
        const { id: pageId } = c.req.valid('param');

        debug('getPresenceToken called', { pageId, userId: user._id.toString() });

        if (!isValidObjectId(pageId)) {
          return c.json(INVALID_PAGE_ID_BODY, 400);
        }

        const loaded = await loadGrantedPage(Page, pageId, user);
        if ('error' in loaded) {
          return c.json(PAGE_NOT_FOUND_BODY, 404);
        }

        try {
          const userId = user._id.toString();
          const { token, expiresAt } = presenceTokenUtil.signPresenceToken({ userId, pageId });

          return c.json(
            {
              token,
              pageId,
              selfUserId: userId,
              expiresAt: expiresAt.toISOString(),
            },
            200,
          );
        } catch (err) {
          debug('presence token signing failed:', (err as Error).message);
          return c.json(INTERNAL_ERROR_BODY, 500);
        }
      })
      // --------------------------------------------------------------
      // GET /pages/:id/likers — liked-by list (RFC-0005 Phase 3)
      // --------------------------------------------------------------
      //
      // The liker list is sourced from `page.liker` (the authoritative
      // ObjectId set). `likedAt` is a best-effort enrichment: we look
      // up the `ACTION_LIKE` Activity rows for the page in one query
      // and join them in. Entries without an Activity row keep
      // `likedAt: null` (likes recorded before activity logging
      // existed, or rows pruned by retention).
      //
      // Sorted newest-liked first; entries with an unknown `likedAt`
      // sort last so the list order stays stable.
      .openapi(getLikersRoute, async (c) => {
        const user = c.get('user');
        const { id: pageId } = c.req.valid('param');
        const { limit } = c.req.valid('query');

        debug('getLikers called', { pageId, limit, userId: user._id.toString() });

        if (!isValidObjectId(pageId)) {
          return c.json(INVALID_PAGE_ID_BODY, 400);
        }

        const loaded = await loadGrantedPage(Page, pageId, user);
        if ('error' in loaded) {
          return c.json(PAGE_NOT_FOUND_BODY, 404);
        }

        try {
          const likerIds = (loaded.page.liker ?? []).filter((id) => id != null);
          const totalCount = likerIds.length;

          if (totalCount === 0) {
            return c.json({ users: [] as Liker[], totalCount }, 200);
          }

          // Best-effort `likedAt` join: map userId -> most recent LIKE
          // activity. The two reads are independent, so run them together.
          const [activities, populated] = await Promise.all([
            Activity.find({
              target: loaded.page._id,
              targetModel: ActivityDefine.MODEL_PAGE,
              action: ActivityDefine.ACTION_LIKE,
            })
              .select('user createdAt')
              .lean(),
            User.findUsersByIds(likerIds) as Promise<UserDocument[]>,
          ]);
          const likedAtByUser = new Map<string, Date>();
          for (const activity of activities) {
            const uid = String(activity.user);
            const at = activity.createdAt as Date | undefined;
            if (!at) continue;
            const existing = likedAtByUser.get(uid);
            if (!existing || at.getTime() > existing.getTime()) likedAtByUser.set(uid, at);
          }

          const likers: Liker[] = populated.map((u) => {
            const likedAt = likedAtByUser.get(u._id.toString());
            return {
              id: u._id.toString(),
              username: u.username ?? '',
              displayName: u.name ?? u.username ?? '',
              avatarUrl: u.image ?? null,
              likedAt: likedAt ? likedAt.toISOString() : null,
            };
          });

          // Newest-liked first; unknown `likedAt` sorts last.
          likers.sort((a, b) => {
            if (a.likedAt && b.likedAt) return b.likedAt.localeCompare(a.likedAt);
            if (a.likedAt) return -1;
            if (b.likedAt) return 1;
            return 0;
          });

          const users = limit !== undefined ? likers.slice(0, limit) : likers;
          return c.json({ users, totalCount }, 200);
        } catch (err) {
          debug('getLikers failed:', (err as Error).message);
          return c.json(INTERNAL_ERROR_BODY, 500);
        }
      })
  );
};
