import mongoose from 'mongoose';
import { crowi, Fixture } from 'src/test/setup';

describe('Comment', () => {
  let Page;
  let User;
  let Comment;
  let createdPages;
  let createdUsers;
  let createdComment;

  beforeAll((done) => {
    Page = crowi.model('Page');
    User = crowi.model('User');
    Comment = crowi.model('Comment');

    Promise.resolve()
      .then(() => {
        const userFixture = [
          { name: 'Anon 0', username: 'anonymous0', email: 'anonymous0@example.com' },
          { name: 'Anon 1', username: 'anonymous1', email: 'anonymous1@example.com' },
        ];

        return Fixture.generate('User', userFixture);
      })
      .then((testUsers) => {
        createdUsers = testUsers;
        const testUser0 = testUsers[0];

        const fixture = [
          {
            path: '/grant/public',
            grant: Page.GRANT_PUBLIC,
            grantedUsers: [testUser0],
            creator: testUser0,
          },
        ];

        return Fixture.generate('Page', fixture).then((pages) => {
          createdPages = pages;
          done();
        });
      });
  });

  describe('Comment.create', () => {
    test('should be created', async () => {
      const page = await Page.findOne({ path: '/grant/public' });
      const creator = await User.findUserByUsername('anonymous1');
      const revision = undefined;
      const comment = 'これがテスト用のコメント';
      const commentPosition = undefined;

      createdComment = await Comment.create({ page, creator, revision, comment, commentPosition });
      expect(createdComment.comment).toBe('これがテスト用のコメント');
    });
  });

  describe('Comment.removeCommentById', () => {
    test('should be deleted', async () => {
      let comments = await Comment.countCommentByPageId(createdComment.page.id);
      expect(comments).toStrictEqual(1);
      await Comment.removeCommentById(createdComment._id);
      comments = await Comment.countCommentByPageId(createdComment.page.id);
      expect(comments).toStrictEqual(0);
    });

    // QA-5-01 — Page.commentCount only recalculated on comment creation
    // (post('save') hook), not on deletion, so it drifted upward and stuck
    // until the next comment was posted.
    test('recalculates Page.commentCount (QA-5-01)', async () => {
      const creator = await User.findUserByUsername('anonymous1');
      const [page] = await Fixture.generate('Page', [{ path: '/grant/comment-count-recalc', grant: Page.GRANT_PUBLIC, grantedUsers: [creator], creator }]);

      const first = await Comment.create({ page, creator, revision: undefined, comment: 'first', commentPosition: undefined });
      await Comment.create({ page, creator, revision: undefined, comment: 'second', commentPosition: undefined });
      await crowi.drainSideEffects();

      let updated = await Page.findById(page._id);
      expect(updated.commentCount).toBe(2);

      await Comment.removeCommentById(first._id);
      await crowi.drainSideEffects();

      updated = await Page.findById(page._id);
      expect(updated.commentCount).toBe(1);
    });
  });

  // feature-live-page-comment-sync — the presence-broadcast listener keys
  // off these Comment events, so their firing semantics matter (crowi-review
  // CLS-001 / CLS-006).
  describe('live-sync Comment events', () => {
    let commentEvent;

    beforeAll(() => {
      commentEvent = crowi.event('Comment');
    });

    test("'add' fires once on creation and not on a later re-save (CLS-006)", async () => {
      const page = await Page.findOne({ path: '/grant/public' });
      const creator = await User.findUserByUsername('anonymous1');
      const adds = [];
      const onAdd = (c) => adds.push(c);
      commentEvent.on('add', onAdd);
      try {
        const created = await Comment.create({ page, creator, revision: undefined, comment: 'live add', commentPosition: undefined });
        expect(adds).toHaveLength(1);
        expect(adds[0]._id.toString()).toBe(created._id.toString());

        // Re-saving an existing comment is not a creation → no 'add'.
        created.comment = 'edited body';
        await created.save();
        expect(adds).toHaveLength(1);

        await Comment.removeCommentById(created._id);
      } finally {
        commentEvent.off('add', onAdd);
      }
    });

    test("'remove' fires only after the row is deleted (CLS-001)", async () => {
      const page = await Page.findOne({ path: '/grant/public' });
      const creator = await User.findUserByUsername('anonymous1');
      const created = await Comment.create({ page, creator, revision: undefined, comment: 'to remove', commentPosition: undefined });

      // The listener runs synchronously at emit time; issuing the count
      // query then observes whether the delete already committed.
      let countAtEmit;
      const onRemove = () => {
        countAtEmit = Comment.countDocuments({ _id: created._id });
      };
      commentEvent.on('remove', onRemove);
      try {
        await Comment.removeCommentById(created._id);
        expect(countAtEmit).toBeDefined();
        await expect(countAtEmit).resolves.toBe(0);
      } finally {
        commentEvent.off('remove', onRemove);
      }
    });
  });
});
