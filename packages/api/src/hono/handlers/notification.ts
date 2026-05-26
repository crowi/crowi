/**
 * RFC-0006 Phase 4 Batch 3 — `notification` resource Hono port.
 *
 * Replaces `packages/api/src/routes/ts-rest/notification.ts`. Four
 * endpoints, all behind `createJwtAuth(crowi)` applied broadly to
 * `/notifications/*`:
 *
 *   GET  /notifications            — paginated list (newest first)
 *   POST /notifications/read       — mark all UNREAD as UNOPENED
 *   GET  /notifications/status     — unread count
 *   POST /notifications/:id/open   — set status=OPENED
 *
 * Wire-format parity with the ts-rest era is preserved. Notable:
 *
 *  - `/notifications/status` is registered BEFORE `/notifications/:id/open`
 *    so the literal path matches first.
 *  - Foreign-user notification ids surface 404 (not 403) so the API
 *    does not leak the existence of another user's notifications.
 *  - The list endpoint over-fetches by +1 to derive `pager.next`
 *    without a second count query.
 */
import {
  getNotificationsTokenRoute,
  getUnreadCountRoute,
  listNotificationsRoute,
  markAllAsReadRoute,
  type Notification,
  openNotificationRoute,
  type PageRef,
  type UserPublic,
} from '@crowi/api-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import Debug from 'debug';
import { Types } from 'mongoose';

import type Crowi from 'src/crowi';
import type { NotificationDocument } from 'src/models/notification';
import { createNotificationsTokenUtil } from 'src/util/notifications-token';
import { isValidObjectId, toISOStringOrNull, toStringId, toUserPublic } from 'src/util/ts-rest-helpers';

import type { CrowiHonoBindings } from '../app';
import { createJwtAuth } from '../middleware/auth';

import { INTERNAL_ERROR_BODY } from './_helpers/errors';

const debug = Debug('crowi:hono:handlers:notification');

const NOTIFICATION_NOT_FOUND_BODY = {
  error: { code: 'NOTIFICATION_NOT_FOUND' as const, message: 'Notification not found' as const },
};

const invalidIdBody = () => ({
  error: { code: 'INVALID_REQUEST' as const, message: 'Invalid notification id' },
});

interface PopulatedUserLike {
  _id: Types.ObjectId | string;
  username?: string;
  name?: string;
  email?: string;
  image?: string | null;
  introduction?: string;
  createdAt?: Date;
  admin?: boolean;
  status?: number;
}

interface PopulatedPageLike {
  _id: Types.ObjectId | string;
  path: string;
  status?: string | null;
}

interface PopulatedActivityLike {
  _id: Types.ObjectId | string;
  user?: PopulatedUserLike | Types.ObjectId | string | null;
}

interface NotificationLike {
  _id: Types.ObjectId | string;
  user: PopulatedUserLike | Types.ObjectId | string;
  targetModel: string;
  target: PopulatedPageLike | Types.ObjectId | string | null;
  action: string;
  status: string;
  activities?: (PopulatedActivityLike | Types.ObjectId | string)[];
  actionUsers?: (PopulatedUserLike | Types.ObjectId | string)[];
  createdAt?: Date;
}

const isPopulatedUserLike = (value: unknown): value is PopulatedUserLike => {
  return !!value && typeof value === 'object' && '_id' in value && 'username' in value && 'email' in value;
};

const isPopulatedPage = (value: unknown): value is PopulatedPageLike => {
  return !!value && typeof value === 'object' && '_id' in value && 'path' in value;
};

const isPopulatedActivity = (value: unknown): value is PopulatedActivityLike => {
  return !!value && typeof value === 'object' && '_id' in value && 'user' in value;
};

const toPageRef = (page: PopulatedPageLike): PageRef => ({
  _id: toStringId(page._id),
  path: page.path,
  status: (page.status as 'wip' | 'published' | 'deleted' | 'deprecated' | 'draft' | null | undefined) ?? null,
});

/**
 * Build the actionUsers array from a (possibly populated) notification.
 * Prefer the virtual `actionUsers` when populated, otherwise derive from
 * `activities[].user`. Duplicates are removed by user id.
 */
const buildActionUsers = (notification: NotificationLike): UserPublic[] => {
  const candidates: PopulatedUserLike[] = [];

  if (Array.isArray(notification.actionUsers)) {
    for (const u of notification.actionUsers) {
      if (isPopulatedUserLike(u)) candidates.push(u);
    }
  }

  if (candidates.length === 0 && Array.isArray(notification.activities)) {
    for (const a of notification.activities) {
      if (isPopulatedActivity(a) && isPopulatedUserLike(a.user)) {
        candidates.push(a.user);
      }
    }
  }

  const seen = new Set<string>();
  const result: UserPublic[] = [];
  for (const u of candidates) {
    const id = toStringId(u._id);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(toUserPublic(u));
  }
  return result;
};

const notificationToResponse = (doc: NotificationDocument): Notification => {
  const obj = doc.toObject({ virtuals: true }) as unknown as NotificationLike;

  const userId = isPopulatedUserLike(obj.user) ? toStringId(obj.user._id) : toStringId(obj.user as Types.ObjectId | string);

  let target: PageRef;
  if (isPopulatedPage(obj.target)) {
    target = toPageRef(obj.target);
  } else if (obj.target) {
    target = { _id: toStringId(obj.target as Types.ObjectId | string), path: '', status: null };
  } else {
    target = { _id: '', path: '', status: null };
  }

  return {
    _id: toStringId(obj._id),
    user: userId,
    targetModel: obj.targetModel as 'Page',
    target,
    action: obj.action as 'COMMENT' | 'LIKE' | 'MENTION',
    status: obj.status as 'UNREAD' | 'UNOPENED' | 'OPENED',
    actionUsers: buildActionUsers(obj),
    createdAt: toISOStringOrNull(obj.createdAt) ?? new Date(0).toISOString(),
  };
};

export const registerNotificationRoutes = <E extends OpenAPIHono<CrowiHonoBindings>>(app: E, crowi: Crowi) => {
  const Notification = crowi.model('Notification');

  // Resolve / sign helper once per server (closure-captures the secret).
  // Same construction-time-capture caveat as `presence.ts`: tests pin
  // `WS_TOKEN_SECRET` before importing `src/test/setup`.
  const notificationsTokenUtil = createNotificationsTokenUtil();

  app.use('/notifications/*', createJwtAuth(crowi));
  app.use('/notifications', createJwtAuth(crowi));

  return (
    app
      .openapi(listNotificationsRoute, async (c) => {
        const user = c.get('user');
        const { limit, offset } = c.req.valid('query');

        debug('listNotifications called with:', { limit, offset, userId: user._id });

        try {
          const requestLimit = limit + 1;
          const fetched = (await Notification.findLatestNotificationsByUser(user._id, requestLimit, offset)) as NotificationDocument[];

          const sliced = fetched.slice(0, limit);
          const hasNext = fetched.length > limit;
          const next = hasNext ? offset + limit : null;
          const prev = offset > 0 ? Math.max(0, offset - limit) : null;

          return c.json(
            {
              notifications: sliced.map(notificationToResponse),
              pager: { prev, next, offset },
            },
            200,
          );
        } catch (err) {
          debug('Error listing notifications:', (err as Error).message);
          return c.json(INTERNAL_ERROR_BODY, 500);
        }
      })
      .openapi(markAllAsReadRoute, async (c) => {
        const user = c.get('user');

        debug('markAllAsRead called by:', { userId: user._id });

        try {
          await Notification.read(user);
          return c.json({ ok: true as const }, 200);
        } catch (err) {
          debug('Error marking notifications as read:', (err as Error).message);
          return c.json(INTERNAL_ERROR_BODY, 500);
        }
      })
      // `/notifications/token` is another literal path that MUST
      // register before `/notifications/:id/open` so the template
      // never shadows it. Same first-match-wins ordering as
      // `/notifications/status`.
      .openapi(getNotificationsTokenRoute, async (c) => {
        const user = c.get('user');
        const userId = user._id.toString();

        debug('getNotificationsToken called by:', { userId });

        try {
          const { token, expiresAt } = notificationsTokenUtil.signNotificationsToken({ selfUserId: userId });
          return c.json(
            {
              token,
              selfUserId: userId,
              expiresAt: expiresAt.toISOString(),
            },
            200,
          );
        } catch (err) {
          debug('notifications token signing failed:', (err as Error).message);
          return c.json(INTERNAL_ERROR_BODY, 500);
        }
      })
      // `/notifications/status` MUST be registered before
      // `/notifications/:id/open` so the literal-path route wins.
      .openapi(getUnreadCountRoute, async (c) => {
        const user = c.get('user');

        debug('getUnreadCount called by:', { userId: user._id });

        try {
          const count = (await Notification.getUnreadCountByUser(user._id)) ?? 0;
          return c.json({ count }, 200);
        } catch (err) {
          debug('Error counting unread notifications:', (err as Error).message);
          return c.json(INTERNAL_ERROR_BODY, 500);
        }
      })
      .openapi(openNotificationRoute, async (c) => {
        const user = c.get('user');
        const { id } = c.req.valid('param');

        debug('openNotification called with:', { id, userId: user._id });

        if (!isValidObjectId(id)) {
          return c.json(invalidIdBody(), 400);
        }

        try {
          const updated = await Notification.open(user, new Types.ObjectId(id));
          if (!updated) {
            return c.json(NOTIFICATION_NOT_FOUND_BODY, 404);
          }

          const populated = await Notification.findById(updated._id)
            .populate(['user', 'target'])
            .populate({ path: 'activities', populate: { path: 'user' } })
            .exec();

          if (!populated) {
            return c.json(NOTIFICATION_NOT_FOUND_BODY, 404);
          }

          return c.json({ notification: notificationToResponse(populated) }, 200);
        } catch (err) {
          debug('Error opening notification:', (err as Error).message);
          return c.json(INTERNAL_ERROR_BODY, 500);
        }
      })
  );
};
