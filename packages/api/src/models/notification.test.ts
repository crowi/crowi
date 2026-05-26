import mongoose from 'mongoose';
import { crowi } from 'src/test/setup';
import { NOTIFICATIONS_CHANNEL_PREFIX } from 'src/notifications/attach';

describe('Notification', function () {
  let Notification;

  const ObjectId = mongoose.Types.ObjectId;

  beforeAll(() => {
    Notification = crowi.model('Notification');
  });

  describe('.upsertByActivity', function () {
    describe('valid parameters', function () {
      it('should create', async function () {
        const userId1 = new ObjectId();
        const userId2 = new ObjectId();
        const targetId = new ObjectId();
        const activity = { _id: new ObjectId(), user: userId1, targetModel: 'Page', target: targetId, action: 'COMMENT' };
        return Notification.upsertByActivity(userId2, activity)
          .then(function (notification) {
            expect(notification.user.toString()).toBe(userId2.toString());
            expect(notification.targetModel).toBe('Page');
            expect(notification.target.toString()).toBe(targetId.toString());
            expect(notification.action).toBe('COMMENT');
            expect(notification.status).toBe(Notification.STATUS_UNREAD);
            expect(notification.activities).toHaveLength(1);
          })
          .catch(function (err) {
            throw new Error(err);
          });
      });
    });

    describe('invalid parameters', function () {
      it('should create', function () {
        const user = new ObjectId();
        const activity = {
          user: new ObjectId(),
          targetModel: 'Page2', // invalid
          target: new ObjectId(),
          action: 'COMMENT',
        };

        return expect(Notification.upsertByActivity(user, activity)).rejects.toThrow('Validation failed');
      });
    });

    describe('A week later', () => {
      const user = new ObjectId();
      const target = new ObjectId();

      beforeEach(async () => {
        await Notification.deleteMany({});
        const activity = { _id: new ObjectId(), user: new ObjectId(), targetModel: 'Page', target, action: 'COMMENT' };
        await Notification.upsertByActivity(user, activity, new Date(2018, 10, 10).getTime());
      });

      it('is 1', async () => {
        const activity = { _id: new ObjectId(), user: new ObjectId(), targetModel: 'Page', target, action: 'COMMENT' };
        await Notification.upsertByActivity(user, activity, new Date(2018, 10, 16).getTime());
        const count = await Notification.countDocuments({});
        expect(count).toBe(1);
      });

      it('is 2', async () => {
        const activity = { _id: new ObjectId(), user: new ObjectId(), targetModel: 'Page', target, action: 'COMMENT' };
        await Notification.upsertByActivity(user, activity, new Date(2018, 10, 17).getTime());
        const count = await Notification.countDocuments({});
        expect(count).toBe(2);
      });
    });
  });

  describe('.read', () => {
    describe('read', () => {
      const user = new ObjectId();
      let notificationId;

      beforeAll(async () => {
        await Notification.deleteMany({});
        const activity = { _id: new ObjectId(), user: new ObjectId(), targetModel: 'Page', target: new ObjectId(), action: 'COMMENT' };
        const notification = await Notification.upsertByActivity(user, activity);
        notificationId = notification._id;
      });

      it('status is changed correctly', async () => {
        const result = await Notification.read(user);
        expect(result).toEqual({ acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null });
      });
    });
  });

  describe('.open', () => {
    describe('open', () => {
      const user = new ObjectId();
      let notificationId;

      beforeAll(async () => {
        await Notification.deleteMany({});
        const activity = { _id: new ObjectId(), user: new ObjectId(), targetModel: 'Page', target: new ObjectId(), action: 'COMMENT' };
        const notification = await Notification.upsertByActivity(user, activity);
        notificationId = notification._id;
      });

      it('status is changed correctly', async () => {
        const notification = await Notification.open({ _id: user }, notificationId);
        expect(notification.status).toBe(Notification.STATUS_OPENED);
      });
    });
  });

  describe('realtime invalidation publish (Notification model -> Redis)', () => {
    /**
     * The Notification model registers a `notificationEvent.on('update', ...)`
     * listener that publishes a `{type:'changed'}` tick on the user's
     * per-user Redis channel. Hits all the mutation paths the spec lists
     * (`upsertByActivity`, `open`, `read`) and asserts the publish reaches
     * a mocked Redis client; degrade mode (`crowi.redis === null`) skips
     * the publish without throwing.
     */
    type PublishCall = [channel: string, message: string];

    const restoreRedis = (originalRedis: unknown) => {
      // `crowi.redis` is `any` on the Crowi class; cast through unknown
      // so the test can swap in a stub without leaking the `any`.
      (crowi as unknown as { redis: unknown }).redis = originalRedis;
    };

    let originalRedis: unknown;
    let publishSpy: jest.Mock<Promise<number>, PublishCall>;

    beforeEach(() => {
      originalRedis = (crowi as unknown as { redis: unknown }).redis;
      publishSpy = jest.fn().mockResolvedValue(1);
      (crowi as unknown as { redis: { publish: jest.Mock } }).redis = { publish: publishSpy };
    });

    afterEach(() => {
      restoreRedis(originalRedis);
    });

    /**
     * The model's notificationEvent listener publishes inside a
     * `Promise.resolve().then(...)` so the publish enqueues as a
     * microtask. Flush microtasks twice before asserting — once for the
     * model's `then` queue entry, once for any chained handlers (warn
     * path etc.).
     */
    const flushMicrotasks = async () => {
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    };

    it('publishes on the user channel after upsertByActivity', async () => {
      const recipient = new ObjectId();
      const target = new ObjectId();
      const activity = { _id: new ObjectId(), user: new ObjectId(), targetModel: 'Page', target, action: 'COMMENT' };
      await Notification.upsertByActivity(recipient, activity);
      await flushMicrotasks();

      const matching = publishSpy.mock.calls.filter(([channel]) => channel === `${NOTIFICATIONS_CHANNEL_PREFIX}${recipient.toString()}`);
      expect(matching.length).toBeGreaterThanOrEqual(1);
      expect(JSON.parse(matching[0][1])).toEqual({ type: 'changed' });
    });

    it('publishes on the user channel after mark-as-read (Notification.read)', async () => {
      const recipient = new ObjectId();
      const activity = { _id: new ObjectId(), user: new ObjectId(), targetModel: 'Page', target: new ObjectId(), action: 'COMMENT' };
      await Notification.upsertByActivity(recipient, activity);
      publishSpy.mockClear();

      // Simulate the HTTP handler call site, which passes a user-like
      // object with `_id` (not a bare ObjectId).
      await Notification.read({ _id: recipient });
      await flushMicrotasks();

      const matching = publishSpy.mock.calls.filter(([channel]) => channel === `${NOTIFICATIONS_CHANNEL_PREFIX}${recipient.toString()}`);
      expect(matching.length).toBeGreaterThanOrEqual(1);
      expect(JSON.parse(matching[0][1])).toEqual({ type: 'changed' });
    });

    it('publishes on the user channel after Notification.open', async () => {
      const recipient = new ObjectId();
      const activity = { _id: new ObjectId(), user: new ObjectId(), targetModel: 'Page', target: new ObjectId(), action: 'COMMENT' };
      const created = await Notification.upsertByActivity(recipient, activity);
      publishSpy.mockClear();

      await Notification.open({ _id: recipient }, created._id);
      await flushMicrotasks();

      const matching = publishSpy.mock.calls.filter(([channel]) => channel === `${NOTIFICATIONS_CHANNEL_PREFIX}${recipient.toString()}`);
      expect(matching.length).toBeGreaterThanOrEqual(1);
    });

    it('publishes nothing when crowi.redis is null (degrade mode)', async () => {
      // Swap in null AFTER the beforeEach mock so the mutation runs
      // against the degrade path.
      (crowi as unknown as { redis: unknown }).redis = null;

      const recipient = new ObjectId();
      const activity = { _id: new ObjectId(), user: new ObjectId(), targetModel: 'Page', target: new ObjectId(), action: 'COMMENT' };
      await Notification.upsertByActivity(recipient, activity);
      await flushMicrotasks();

      expect(publishSpy).not.toHaveBeenCalled();
    });
  });

  describe('.getUnreadCountByUser', () => {
    const user = new ObjectId();

    describe('initially', () => {
      beforeAll(async () => {
        await Notification.deleteMany({});
      });

      it('is zero', async () => {
        const count = await Notification.getUnreadCountByUser(user);
        expect(count).toBe(0);
      });
    });

    describe('after created', () => {
      beforeAll(async () => {
        const activity = { _id: new ObjectId(), user: new ObjectId(), targetModel: 'Page', target: new ObjectId(), action: 'COMMENT' };
        await Notification.upsertByActivity(user, activity);
      });

      it('is count correctly', async () => {
        const count = await Notification.getUnreadCountByUser(user);
        expect(count).toBe(1);
      });
    });
  });
});
