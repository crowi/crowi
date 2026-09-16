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
import type { LikeDocument } from 'src/models/like';
import type { UserDocument } from 'src/models/user';
import ActivityDefine from 'src/util/activity-define';
import { createPresenceTokenUtil } from 'src/util/presence-token';
import { isValidObjectId, loadGrantedPage } from 'src/util/ts-rest-helpers';

import type { CrowiHonoBindings } from '../app';

import { INTERNAL_ERROR_BODY, INVALID_PAGE_ID_BODY, PAGE_NOT_FOUND_BODY } from './_helpers/errors';

const debug = Debug('crowi:hono:handlers:presence');

export const registerPresenceRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  const Page = crowi.model('Page');
  const User = crowi.model('User');
  const Activity = crowi.model('Activity');
  const Like = crowi.model('Like');

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
      // GET /pages/:id/likers — liked-by list (RFC-0005 Phase 3,
      // feature-page-relations-collections D-1/D-3/F-3)
      // --------------------------------------------------------------
      //
      // The liker list is sourced from the `likes` relation collection
      // (the authoritative `{page,user}` set — no page-embedded array
      // anymore). `likedAt` is the row's own `createdAt` for a live like;
      // only a migrated row with a null `createdAt` falls back to a
      // best-effort join against the `ACTION_LIKE` Activity rows for the
      // page. Rows without a resolvable timestamp keep `likedAt: null`.
      //
      // Sorted newest-liked first; ties (and unresolved `likedAt`, which
      // always ties) break by user id ascending for a stable order.
      // `limit` is applied AFTER excluding users who can no longer be
      // populated (deleted / non-active) — same order as the legacy
      // array-based implementation this replaces (see D-3/F-3), so a
      // `limit=N` call never silently shrinks below `min(N, active liker
      // count)` while `totalCount` still reports the full relation size.
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
          // D-1: unbounded fetch — no server-side cap, no dedicated
          // sort/covering index. totalCount is this array's length, not a
          // separate count query (D-1's fixed one-shot-fetch contract).
          const likeRows = await Like.findByPageId(loaded.page._id);
          const totalCount = likeRows.length;

          if (totalCount === 0) {
            return c.json({ users: [] as Liker[], totalCount }, 200);
          }

          const likedAtByUser = new Map<string, Date | null>();
          const nullRows: LikeDocument[] = [];
          for (const row of likeRows) {
            if (row.createdAt != null) {
              likedAtByUser.set(row.user.toString(), row.createdAt);
            } else {
              nullRows.push(row);
            }
          }

          // D-3: best-effort `likedAt` join, limited to the migrated rows
          // that have no relation timestamp of their own.
          if (nullRows.length > 0) {
            const activities = await Activity.find({
              target: loaded.page._id,
              targetModel: ActivityDefine.MODEL_PAGE,
              action: ActivityDefine.ACTION_LIKE,
              user: { $in: nullRows.map((row) => row.user) },
            })
              .select('user createdAt')
              .lean();
            for (const activity of activities) {
              const uid = String(activity.user);
              const at = activity.createdAt as Date | undefined;
              if (!at) continue;
              const existing = likedAtByUser.get(uid);
              if (!existing || at.getTime() > existing.getTime()) likedAtByUser.set(uid, at);
            }
            for (const row of nullRows) {
              const uid = row.user.toString();
              if (!likedAtByUser.has(uid)) likedAtByUser.set(uid, null);
            }
          }

          // F-3 step 4: populate first (excludes deleted/non-active users),
          // THEN sort by likedAt, THEN slice — never the reverse, or a
          // `limit` would silently drop active users behind an excluded one.
          const populated = (await User.findUsersByIds(likeRows.map((row) => row.user))) as UserDocument[];

          const likers: Liker[] = populated.map((u) => {
            const likedAt = likedAtByUser.get(u._id.toString()) ?? null;
            return {
              id: u._id.toString(),
              username: u.username ?? '',
              displayName: u.name ?? u.username ?? '',
              avatarUrl: u.image ?? null,
              likedAt: likedAt ? likedAt.toISOString() : null,
            };
          });

          // Newest-liked first; ties (incl. both unresolved) break by user
          // id ascending for a deterministic, stable order (D-3).
          likers.sort((a, b) => {
            if (a.likedAt && b.likedAt) {
              if (a.likedAt !== b.likedAt) return b.likedAt.localeCompare(a.likedAt);
              return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
            }
            if (a.likedAt) return -1;
            if (b.likedAt) return 1;
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
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
