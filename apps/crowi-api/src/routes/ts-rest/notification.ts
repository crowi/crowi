import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract, type Notification, type PageRef, type UserPublic } from '@crowi/api-contract';
import Crowi from 'src/crowi';
import { Express, Router } from 'express';
import { Types } from 'mongoose';
import { UserDocument } from 'src/models/user';
import { NotificationDocument } from 'src/models/notification';
import { isValidObjectId, toISOStringOrNull, toStringId, toUserPublic } from 'src/util/ts-rest-helpers';
import Debug from 'debug';

const debug = Debug('crowi:routes:ts-rest:notification');

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

const isPopulatedUser = (value: unknown): value is PopulatedUserLike => {
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
  status: (page.status as 'wip' | 'published' | 'deleted' | 'deprecated' | null | undefined) ?? null,
});

/**
 * Build the actionUsers array from a (possibly populated) notification.
 * Prefer the `actionUsers` virtual when populated activities are present,
 * otherwise derive it manually from `activities[].user`. Duplicates are
 * removed by user id.
 */
const buildActionUsers = (notification: NotificationLike): UserPublic[] => {
  const candidates: PopulatedUserLike[] = [];

  // Prefer the virtual when it produced populated user objects.
  if (Array.isArray(notification.actionUsers)) {
    for (const u of notification.actionUsers) {
      if (isPopulatedUser(u)) candidates.push(u);
    }
  }

  // Fallback / supplement with activities[].user (also populated by findLatestNotificationsByUser).
  if (candidates.length === 0 && Array.isArray(notification.activities)) {
    for (const a of notification.activities) {
      if (isPopulatedActivity(a) && isPopulatedUser(a.user)) {
        candidates.push(a.user);
      }
    }
  }

  // Dedup by string id, preserving first-seen order.
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

/**
 * Convert a NotificationDocument (with user / target / activities.user populated)
 * into the API response shape. The response uses a lightweight PageRef for target
 * and resolves the actionUsers virtual into UserPublic[].
 *
 * `user` and `activities[].user` are normalized to ObjectId strings whenever they
 * are populated, since the contract declares `user` as a string id.
 */
const notificationToResponse = (doc: NotificationDocument): Notification => {
  // toObject({ virtuals: true }) is what the schema is configured with by default,
  // so this exposes `actionUsers` and resolves populated nested docs to plain objects.
  const obj = doc.toObject({ virtuals: true }) as unknown as NotificationLike;

  const userId = isPopulatedUser(obj.user) ? toStringId(obj.user._id) : toStringId(obj.user as Types.ObjectId | string);

  // target is required by the schema. If for any reason it is not populated
  // (legacy data), fall back to a minimal placeholder using the raw id.
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
    action: obj.action as 'COMMENT' | 'LIKE',
    status: obj.status as 'UNREAD' | 'UNOPENED' | 'OPENED',
    actionUsers: buildActionUsers(obj),
    createdAt: toISOStringOrNull(obj.createdAt) ?? new Date(0).toISOString(),
  };
};

const invalidIdResponse = () =>
  ({
    status: 400 as const,
    body: {
      error: {
        code: 'INVALID_REQUEST' as const,
        message: 'Invalid notification id',
      },
    },
  }) as const;

const notificationNotFoundResponse = () =>
  ({
    status: 404 as const,
    body: {
      error: {
        code: 'NOTIFICATION_NOT_FOUND' as const,
        message: 'Notification not found' as const,
      },
    },
  }) as const;

export default (crowi: Crowi, _app: Express) => {
  const s = initServer();
  const router = Router();
  const Notification = crowi.model('Notification');

  const notificationRouter = s.router(apiContract.notification, {
    /**
     * GET /api/v2/notifications?limit&offset
     * List notifications for the current user (paginated, newest first).
     * Equivalent to legacy GET /_api/notification.list.
     */
    listNotifications: async ({ query, req }) => {
      const user = req.user as UserDocument;
      const { limit = 10, offset = 0 } = query;

      debug('listNotifications called with:', { limit, offset, userId: user._id });

      try {
        // Fetch one extra row to compute hasNext, mirroring legacy controller.
        const requestLimit = limit + 1;
        const fetched = (await Notification.findLatestNotificationsByUser(user._id, requestLimit, offset)) as NotificationDocument[];

        const sliced = fetched.slice(0, limit);
        const hasNext = fetched.length > limit;
        const next = hasNext ? offset + limit : null;
        const prev = offset > 0 ? Math.max(0, offset - limit) : null;

        return {
          status: 200 as const,
          body: {
            notifications: sliced.map(notificationToResponse),
            pager: { prev, next, offset },
          },
        };
      } catch (err) {
        const error = err as Error;
        debug('Error listing notifications:', error.message);
        return {
          status: 500 as const,
          body: { error: { code: 'INTERNAL_ERROR' as const, message: 'Internal server error' as const } },
        };
      }
    },

    /**
     * POST /api/v2/notifications/read
     * Mark all UNREAD notifications of the current user as UNOPENED ("read").
     * The legacy controller returned the raw updateMany result; we simplify
     * to { ok: true } since the UI only cares about success / failure.
     */
    markAllAsRead: async ({ req }) => {
      const user = req.user as UserDocument;

      debug('markAllAsRead called by:', { userId: user._id });

      try {
        await Notification.read(user);
        return { status: 200 as const, body: { ok: true as const } };
      } catch (err) {
        const error = err as Error;
        debug('Error marking notifications as read:', error.message);
        return {
          status: 500 as const,
          body: { error: { code: 'INTERNAL_ERROR' as const, message: 'Internal server error' as const } },
        };
      }
    },

    /**
     * POST /api/v2/notifications/:id/open
     * Open (set OPENED status) a single notification.
     * Notification.open filters on `{ _id, user: user._id }` so a foreign
     * notification id naturally resolves to null and we surface 404 for it.
     */
    openNotification: async ({ params, req }) => {
      const user = req.user as UserDocument;
      const { id } = params;

      debug('openNotification called with:', { id, userId: user._id });

      if (!isValidObjectId(id)) {
        return invalidIdResponse();
      }

      try {
        const updated = await Notification.open(user, new Types.ObjectId(id));
        if (!updated) {
          return notificationNotFoundResponse();
        }

        // Re-fetch with population so the response shape matches the list endpoint.
        const populated = await Notification.findById(updated._id)
          .populate(['user', 'target'])
          .populate({ path: 'activities', populate: { path: 'user' } })
          .exec();

        if (!populated) {
          return notificationNotFoundResponse();
        }

        return {
          status: 200 as const,
          body: { notification: notificationToResponse(populated) },
        };
      } catch (err) {
        const error = err as Error;
        debug('Error opening notification:', error.message);
        return {
          status: 500 as const,
          body: { error: { code: 'INTERNAL_ERROR' as const, message: 'Internal server error' as const } },
        };
      }
    },

    /**
     * GET /api/v2/notifications/status
     * Return the unread notification count for the current user.
     */
    getUnreadCount: async ({ req }) => {
      const user = req.user as UserDocument;

      debug('getUnreadCount called by:', { userId: user._id });

      try {
        const count = (await Notification.getUnreadCountByUser(user._id)) ?? 0;
        return { status: 200 as const, body: { count } };
      } catch (err) {
        const error = err as Error;
        debug('Error counting unread notifications:', error.message);
        return {
          status: 500 as const,
          body: { error: { code: 'INTERNAL_ERROR' as const, message: 'Internal server error' as const } },
        };
      }
    },
  });

  createExpressEndpoints(apiContract.notification, notificationRouter, router);

  return router;
};
