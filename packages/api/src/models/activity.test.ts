import faker from 'faker';
import mongoose from 'mongoose';
import { crowi, Fixture } from 'src/test/setup';

describe('Activity', function () {
  let Activity;
  let User;
  let Page;
  let Comment;
  let Watcher;
  let conn;
  const ObjectId = mongoose.Types.ObjectId;

  beforeAll(() => {
    Activity = crowi.model('Activity');
    User = crowi.model('User');
    Page = crowi.model('Page');
    Comment = crowi.model('Comment');
    Watcher = crowi.model('Watcher');
  });

  describe('.createByParameters', function () {
    describe('correct parameters', function () {
      it('should create', function () {
        const userId = new ObjectId();
        const targetId = new ObjectId();

        const parameters = {
          user: userId,
          targetModel: 'Page',
          target: targetId,
          action: 'COMMENT',
        };

        return Activity.createByParameters(parameters).then(
          function (activity) {
            expect(activity.user).toBe(userId);
            expect(activity.target).toBe(targetId);
            expect(activity.targetModel).toBe('Page');
            expect(activity.action).toBe('COMMENT');
          },
          function (err) {
            throw new Error(err);
          },
        );
      });
    });

    describe('invalid parameters', function () {
      it('should not create', function () {
        const userId = new ObjectId();
        const targetId = new ObjectId();

        const parameters = {
          user: userId,
          targetModel: 'Page2', // validation error
          target: targetId,
          action: 'COMMENT',
        };

        return expect(Activity.createByParameters(parameters)).rejects.toThrow('Activity validation failed');
      });
    });
  });

  describe('.removeByParameters', () => {
    describe('correct parameters', () => {
      const user = new ObjectId();
      const target = new ObjectId();
      const parameters = { user, targetModel: 'Page', target, action: 'COMMENT' };

      beforeAll(async () => {
        await Activity.createByParameters(parameters);
      });

      it('should remove', async () => {
        const { deletedCount } = await Activity.removeByParameters(parameters);
        expect(deletedCount).toBe(1);
      });
    });
  });

  describe('Target users', () => {
    const userIds = [new ObjectId(), new ObjectId(), new ObjectId()];
    const pageId = new ObjectId();

    beforeAll(async () => {
      await Promise.all([User, Page, Comment, Watcher, Activity].map((model) => model.deleteMany({})));

      const users = [
        { _id: userIds[0], email: faker.internet.email(), status: User.STATUS_ACTIVE },
        { _id: userIds[1], email: faker.internet.email(), status: User.STATUS_ACTIVE },
        { _id: userIds[2], email: faker.internet.email(), status: User.STATUS_SUSPENDED },
      ];
      const pages = [{ _id: pageId, path: `/${faker.lorem.word()}`, grant: Page.GRANT_PUBLIC, creator: userIds[0] }];
      const comments = userIds.map((userId) => ({ page: pageId, creator: userId, comment: faker.lorem.word() }));

      await Promise.all([Fixture.generate('User', users), Fixture.generate('Page', pages), Fixture.generate('Comment', comments)]);
    });

    afterEach(async () => {
      await Promise.all([Watcher, Activity].map((model) => model.deleteMany({})));
    });

    describe('Action User and Suspended User', () => {
      let notificationUsers;
      beforeEach(async () => {
        await Activity.deleteMany({});
        const activity = await Activity.createByParameters({ user: userIds[0], target: pageId, targetModel: 'Page', action: 'COMMENT' });
        notificationUsers = (await activity.getNotificationTargetUsers()).map(String);
      });

      it('is not contain action user', () => {
        expect(notificationUsers).not.toContain(String(userIds[0]));
      });

      it('is not contain suspended user', () => {
        expect(notificationUsers).not.toContain(String(userIds[2]));
      });
    });

    describe('Watch', () => {
      beforeEach(async () => {
        await Watcher.deleteMany({});
        await Watcher.watchByPageId(userIds[1], pageId, Watcher.STATUS_WATCH);
      });

      it('is watched', async () => {
        const activity = await Activity.createByParameters({ user: userIds[0], target: pageId, targetModel: 'Page', action: 'COMMENT' });
        const notificationUsers = (await activity.getNotificationTargetUsers()).map(String);

        expect(notificationUsers).toContain(String(userIds[1]));
      });
    });

    describe('Ignore', () => {
      beforeEach(async () => {
        await Watcher.deleteMany({});
        await Watcher.watchByPageId(userIds[1], pageId, Watcher.STATUS_IGNORE);
      });

      it('is ignored', async () => {
        const activity = await Activity.createByParameters({ user: userIds[0], target: pageId, targetModel: 'Page', action: 'COMMENT' });
        const notificationUsers = (await activity.getNotificationTargetUsers()).map(String);

        expect(notificationUsers).not.toContain(String(userIds[1]));
      });
    });
  });

  // RFC-0002 Phase 8: createByPageMention + MENTION skip-fan-out guard.
  describe('.createByPageMention (RFC-0002 Phase 8)', () => {
    const authorId = new ObjectId();
    const mentionedId = new ObjectId();
    const pageId = new ObjectId();

    beforeEach(async () => {
      await Activity.deleteMany({});
    });

    it('creates a MENTION activity for (page, mentionedUser, author)', async () => {
      const activity = await Activity.createByPageMention({ _id: pageId }, { _id: mentionedId }, { _id: authorId });
      expect(activity.action).toBe('MENTION');
      expect(activity.targetModel).toBe('Page');
      expect(String(activity.target)).toBe(String(pageId));
      expect(String(activity.user)).toBe(String(authorId));
    });

    it('accepts MENTION via schema enum (i.e. ActivityDefine.getSupportActionNames includes MENTION)', async () => {
      const activity = await Activity.createByParameters({
        user: authorId,
        target: pageId,
        targetModel: 'Page',
        action: 'MENTION',
      });
      expect(activity.action).toBe('MENTION');
    });

    it('post-save hook skips watchers fan-out for MENTION', async () => {
      // If the post-save hook ran getNotificationTargetUsers + upsertByActivity
      // for MENTION, Notification would have rows after we save. The hook is
      // intentionally a no-op for MENTION (the dispatcher writes directly).
      const Notification = crowi.model('Notification');
      await Notification.deleteMany({});

      await Activity.createByPageMention({ _id: pageId }, { _id: mentionedId }, { _id: authorId });
      // Give the synchronous post-save microtask a chance to (not) run.
      await new Promise((r) => setImmediate(r));

      const created = await Notification.find({ action: 'MENTION' });
      expect(created).toHaveLength(0);
    });
  });
});
