import mongoose from 'mongoose';
import { crowi } from 'src/test/setup';

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
