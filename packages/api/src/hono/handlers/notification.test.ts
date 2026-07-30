import { Types } from 'mongoose';
import request from 'supertest';

import type { ActivityDocument } from 'src/models/activity';
import type { NotificationDocument } from 'src/models/notification';
import { app, crowi } from 'src/test/setup';
import { authHeaders, createTestUser, createPageViaApi } from 'src/test/test-helpers';

/**
 * RFC-0006 Phase 4 Batch 3 — integration tests for the migrated
 * `notification` resource. The literal-path `/notifications/status`
 * route MUST resolve before `/notifications/:id/open`; the unread-
 * count and open-by-id paths each have their own block to cover that
 * ordering. Foreign-user notifications surface 404 (not 403) so we do
 * not leak the existence of another user's data.
 */

const cleanupPathPrefix = async (prefix: string) => {
  const Page = crowi.model('Page');
  const Revision = crowi.model('Revision');
  const Notification = crowi.model('Notification');
  const Activity = crowi.model('Activity');
  const filter = { path: { $regex: `^${prefix}` } };
  const pages = await Page.find(filter).select('_id').lean();
  const pageIds = pages.map((p: { _id: Types.ObjectId }) => p._id);
  await Promise.all([
    Page.deleteMany(filter),
    Revision.deleteMany(filter),
    Notification.deleteMany({ target: { $in: pageIds } }),
    Activity.deleteMany({ target: { $in: pageIds } }),
  ]);
};

/**
 * Seed a notification directly via the model so tests can deterministically
 * control state — see the ts-rest era test for the post-save hook rationale.
 */
const seedNotification = async (params: {
  recipient: Types.ObjectId;
  actor: Types.ObjectId;
  pageId: string | Types.ObjectId;
  action?: 'COMMENT' | 'LIKE';
  status?: 'UNREAD' | 'UNOPENED' | 'OPENED';
}): Promise<NotificationDocument> => {
  const Notification = crowi.model('Notification');
  const Activity = crowi.model('Activity');

  const action = params.action ?? 'COMMENT';
  const target = typeof params.pageId === 'string' ? new Types.ObjectId(params.pageId) : params.pageId;
  const status = params.status ?? 'UNREAD';

  const activityDoc = new Activity({
    user: params.actor,
    targetModel: 'Page',
    target,
    action,
  }) as ActivityDocument;
  await Activity.collection.insertOne(activityDoc.toObject());

  const notification = (await Notification.create({
    user: params.recipient,
    targetModel: 'Page',
    target,
    action,
    activities: [activityDoc._id],
    status,
  })) as NotificationDocument;

  return notification;
};

describe('Routes /api/notifications (Hono)', () => {
  const PATH_PREFIX = '/hono-notification-test/';
  let recipient: { _id: Types.ObjectId };
  let actor: { _id: Types.ObjectId };
  let recipientToken: string;
  let actorToken: string;

  beforeAll(async () => {
    const r = await createTestUser({
      name: 'Notif Recipient',
      username: 'honoNotifRecipient',
      email: 'hono-notif-recipient@example.com',
    });
    recipient = r.user;
    recipientToken = r.accessToken;

    const a = await createTestUser({
      name: 'Notif Actor',
      username: 'honoNotifActor',
      email: 'hono-notif-actor@example.com',
    });
    actor = a.user;
    actorToken = a.accessToken;
  });

  afterEach(async () => {
    await cleanupPathPrefix(PATH_PREFIX);
    const Notification = crowi.model('Notification');
    const Activity = crowi.model('Activity');
    await Promise.all([
      Notification.deleteMany({ user: { $in: [recipient._id, actor._id] } }),
      Activity.deleteMany({ user: { $in: [recipient._id, actor._id] } }),
    ]);
  });

  describe('GET /api/notifications', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/notifications');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns an empty list with default pager when there are no notifications', async () => {
      const res = await request(app).get('/api/notifications').set(authHeaders(recipientToken));

      expect(res.status).toBe(200);
      expect(res.body.notifications).toEqual([]);
      expect(res.body.pager).toEqual({ prev: null, next: null, offset: 0 });
    });

    it('returns serialized notifications newest-first with target as PageRef and actionUsers populated', async () => {
      const page = await createPageViaApi(recipientToken, `${PATH_PREFIX}list-1`, '# n1');

      const seeded = await seedNotification({
        recipient: recipient._id,
        actor: actor._id,
        pageId: page._id,
        action: 'COMMENT',
      });

      const res = await request(app).get('/api/notifications').set(authHeaders(recipientToken));

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.notifications)).toBe(true);
      expect(res.body.notifications).toHaveLength(1);

      const n = res.body.notifications[0];
      expect(n._id).toBe(seeded._id.toString());
      expect(n.user).toBe(recipient._id.toString());
      expect(n.targetModel).toBe('Page');
      expect(n.target).toEqual({ _id: page._id, path: page.path, status: expect.any(String) });
      expect(n.action).toBe('COMMENT');
      expect(n.status).toBe('UNREAD');
      expect(Array.isArray(n.actionUsers)).toBe(true);
      expect(n.actionUsers).toHaveLength(1);
      expect(n.actionUsers[0]._id).toBe(actor._id.toString());
      expect(n.actionUsers[0].username).toBe('honoNotifActor');
    });

    it('honors limit / offset and computes pager.next correctly', async () => {
      const pages = await Promise.all([
        createPageViaApi(recipientToken, `${PATH_PREFIX}p-a`, '# a'),
        createPageViaApi(recipientToken, `${PATH_PREFIX}p-b`, '# b'),
        createPageViaApi(recipientToken, `${PATH_PREFIX}p-c`, '# c'),
      ]);
      for (const p of pages) {
        await seedNotification({ recipient: recipient._id, actor: actor._id, pageId: p._id });
      }

      const first = await request(app).get('/api/notifications').set(authHeaders(recipientToken)).query({ limit: 2, offset: 0 });
      expect(first.status).toBe(200);
      expect(first.body.notifications).toHaveLength(2);
      expect(first.body.pager).toEqual({ prev: null, next: 2, offset: 0 });

      const second = await request(app).get('/api/notifications').set(authHeaders(recipientToken)).query({ limit: 2, offset: 2 });
      expect(second.status).toBe(200);
      expect(second.body.notifications).toHaveLength(1);
      expect(second.body.pager).toEqual({ prev: 0, next: null, offset: 2 });
    });

    it('does not return notifications addressed to other users', async () => {
      const page = await createPageViaApi(recipientToken, `${PATH_PREFIX}private`, '# secret');
      await seedNotification({ recipient: actor._id, actor: recipient._id, pageId: page._id });

      const res = await request(app).get('/api/notifications').set(authHeaders(recipientToken));
      expect(res.status).toBe(200);
      expect(res.body.notifications).toEqual([]);
    });
  });

  describe('POST /api/notifications/read', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).post('/api/notifications/read');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('transitions all UNREAD notifications of the current user to UNOPENED and returns { ok: true }', async () => {
      const page1 = await createPageViaApi(recipientToken, `${PATH_PREFIX}r1`, '# r1');
      const page2 = await createPageViaApi(recipientToken, `${PATH_PREFIX}r2`, '# r2');
      await seedNotification({ recipient: recipient._id, actor: actor._id, pageId: page1._id, status: 'UNREAD' });
      await seedNotification({ recipient: recipient._id, actor: actor._id, pageId: page2._id, status: 'UNREAD' });
      await seedNotification({ recipient: actor._id, actor: recipient._id, pageId: page1._id, status: 'UNREAD' });

      const res = await request(app).post('/api/notifications/read').set(authHeaders(recipientToken));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      const Notification = crowi.model('Notification');
      const stillUnread = await Notification.countDocuments({ user: recipient._id, status: 'UNREAD' });
      expect(stillUnread).toBe(0);
      const unopened = await Notification.countDocuments({ user: recipient._id, status: 'UNOPENED' });
      expect(unopened).toBe(2);

      const otherUnread = await Notification.countDocuments({ user: actor._id, status: 'UNREAD' });
      expect(otherUnread).toBe(1);
    });
  });

  describe('POST /api/notifications/:id/open', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).post(`/api/notifications/${new Types.ObjectId().toString()}/open`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 400 for a malformed id', async () => {
      const res = await request(app).post('/api/notifications/not-an-objectid/open').set(authHeaders(recipientToken));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REQUEST');
    });

    it('returns 404 for a non-existent id', async () => {
      const res = await request(app).post(`/api/notifications/${new Types.ObjectId().toString()}/open`).set(authHeaders(recipientToken));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOTIFICATION_NOT_FOUND');
    });

    it('returns 404 when opening another user notification (no leakage)', async () => {
      const page = await createPageViaApi(recipientToken, `${PATH_PREFIX}foreign`, '# foreign');
      const foreign = await seedNotification({ recipient: actor._id, actor: recipient._id, pageId: page._id });

      const res = await request(app).post(`/api/notifications/${foreign._id.toString()}/open`).set(authHeaders(recipientToken));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOTIFICATION_NOT_FOUND');

      const Notification = crowi.model('Notification');
      const reloaded = await Notification.findById(foreign._id);
      expect(reloaded?.status).toBe('UNREAD');
    });

    it('transitions the notification to OPENED and returns the populated notification', async () => {
      const page = await createPageViaApi(recipientToken, `${PATH_PREFIX}open`, '# open');
      const seeded = await seedNotification({ recipient: recipient._id, actor: actor._id, pageId: page._id, status: 'UNOPENED' });

      const res = await request(app).post(`/api/notifications/${seeded._id.toString()}/open`).set(authHeaders(recipientToken));
      expect(res.status).toBe(200);
      expect(res.body.notification._id).toBe(seeded._id.toString());
      expect(res.body.notification.status).toBe('OPENED');
      expect(res.body.notification.target._id).toBe(page._id);
      expect(res.body.notification.actionUsers[0]._id).toBe(actor._id.toString());
    });
  });

  describe('GET /api/notifications/status', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/notifications/status');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 0 when there are no unread notifications', async () => {
      const res = await request(app).get('/api/notifications/status').set(authHeaders(recipientToken));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ count: 0 });
    });

    it('counts only UNREAD notifications for the current user', async () => {
      const page1 = await createPageViaApi(recipientToken, `${PATH_PREFIX}c1`, '# c1');
      const page2 = await createPageViaApi(recipientToken, `${PATH_PREFIX}c2`, '# c2');
      const page3 = await createPageViaApi(recipientToken, `${PATH_PREFIX}c3`, '# c3');
      await seedNotification({ recipient: recipient._id, actor: actor._id, pageId: page1._id, status: 'UNREAD' });
      await seedNotification({ recipient: recipient._id, actor: actor._id, pageId: page2._id, status: 'UNOPENED' });
      await seedNotification({ recipient: recipient._id, actor: actor._id, pageId: page3._id, status: 'OPENED' });
      await seedNotification({ recipient: actor._id, actor: recipient._id, pageId: page1._id, status: 'UNREAD' });

      const res = await request(app).get('/api/notifications/status').set(authHeaders(recipientToken));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ count: 1 });

      const otherRes = await request(app).get('/api/notifications/status').set(authHeaders(actorToken));
      expect(otherRes.status).toBe(200);
      expect(otherRes.body).toEqual({ count: 1 });
    });
  });
});
