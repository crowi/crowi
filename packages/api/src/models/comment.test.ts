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

    /**
     * QA-5-01 race — `recalculateCommentCount` counts, then writes, with no
     * ordering between concurrent chains for the same page. Two comments
     * posted back to back start two chains: the first reads 1 (its count is
     * dispatched before the second insert), the second reads 2 and writes 2.
     * If the first chain's count response lands after the second has already
     * written, it writes its stale 1 over the 2 and the page is left wrong
     * until the next create/delete. `drainSideEffects()` waits for both
     * chains to settle but cannot impose an order, so the flake reproduced
     * only under parallel-suite load.
     *
     * Delaying the FIRST count response makes that ordering deterministic.
     * `maxActive` is the load-bearing assertion: it fails on the old code
     * regardless of scheduling luck, because the two chains genuinely
     * overlap there.
     */
    test('concurrent recalcs cannot lose the newer count (QA-5-01 race)', async () => {
      const creator = await User.findUserByUsername('anonymous1');
      const [page] = await Fixture.generate('Page', [{ path: '/grant/comment-count-race', grant: Page.GRANT_PUBLIC, grantedUsers: [creator], creator }]);

      const realCount = Comment.countCommentByPageId.bind(Comment);
      let announceFirstCount;
      const firstCountObserved = new Promise((resolve) => {
        announceFirstCount = resolve;
      });
      let sawFirst = false;
      let active = 0;
      let maxActive = 0;
      const spy = jest.spyOn(Comment, 'countCommentByPageId').mockImplementation(async (pageId) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          const count = await realCount(pageId);
          if (!sawFirst) {
            sawFirst = true;
            // Tell the test the first count has READ (so it can create the
            // second comment knowing this chain already saw the old value),
            // then hold this chain's response long enough for the second
            // chain to overtake it on the unfixed code.
            announceFirstCount(count);
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
          return count;
        } finally {
          active -= 1;
        }
      });

      try {
        await Comment.create({ page, creator, revision: undefined, comment: 'first', commentPosition: undefined });

        // Gate on the first count having actually read 1. Without this the
        // second insert could land before that count takes its snapshot, the
        // first chain would read 2 as well, and writing 2 over 2 would hide
        // the lost update — making the final-count assertion pass on the
        // unfixed code by luck.
        expect(await firstCountObserved).toBe(1);

        await Comment.create({ page, creator, revision: undefined, comment: 'second', commentPosition: undefined });
        await crowi.drainSideEffects();

        const updated = await Page.findById(page._id);
        // Unfixed: the held first chain wakes last and writes its stale 1.
        expect(updated.commentCount).toBe(2);
        // Unfixed: both chains are in flight at once, so this reaches 2.
        expect(maxActive).toBe(1);
      } finally {
        spy.mockRestore();
      }
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

  // feature-page-history-phase1-model (RFC-0021 §7.1, Phase 1) — post-insert
  // lifecycle re-validation: `addComment` authorizes the Page and THEN
  // inserts the Comment as two separate operations, so a Page trashed in
  // that window must not leave an orphaned comment behind.
  describe('post-insert lifecycle re-validation (RFC-0021 §7.1, AC-10)', () => {
    let commentEvent;

    beforeAll(() => {
      commentEvent = crowi.event('Comment');
    });

    test('a comment created against an already-trashed page is inserted then compensated (deleted), and the write fails', async () => {
      const creator = await User.findUserByUsername('anonymous1');
      const [page] = await Fixture.generate('Page', [{ path: '/grant/history-phase1-trash-race', grant: Page.GRANT_PUBLIC, grantedUsers: [creator], creator }]);
      await Page.deletePage(page, creator);

      const adds = [];
      const onAdd = (c) => adds.push(c);
      commentEvent.on('add', onAdd);
      try {
        await expect(Comment.create({ page: page._id, creator, revision: undefined, comment: 'race comment', commentPosition: undefined })).rejects.toThrow(
          'Page not found',
        );

        // Inserted, then removed by the compensation — not left behind.
        const remaining = await Comment.countDocuments({ comment: 'race comment' });
        expect(remaining).toBe(0);

        // Registered BEFORE the commentCount/Activity/live-sync hook — its
        // throw must suppress that later hook entirely.
        expect(adds).toHaveLength(0);
      } finally {
        commentEvent.off('add', onAdd);
      }
    });

    test('a comment created against a page that no longer exists (deleted _id) is inserted then compensated', async () => {
      const creator = await User.findUserByUsername('anonymous1');
      const [page] = await Fixture.generate('Page', [{ path: '/grant/history-phase1-gone-race', grant: Page.GRANT_PUBLIC, grantedUsers: [creator], creator }]);
      const missingPageId = page._id;
      await Page.deleteOne({ _id: missingPageId });

      await expect(
        Comment.create({ page: missingPageId, creator, revision: undefined, comment: 'orphan comment', commentPosition: undefined }),
      ).rejects.toThrow('Page not found');

      const remaining = await Comment.countDocuments({ comment: 'orphan comment' });
      expect(remaining).toBe(0);
    });

    test('no $locals.authSnapshot (direct model caller, e.g. Comment.create): a page that was merely renamed is unaffected — the narrower gone-or-trashed fallback applies', async () => {
      const creator = await User.findUserByUsername('anonymous1');
      const [page] = await Fixture.generate('Page', [
        { path: '/grant/history-phase1-rename-only', grant: Page.GRANT_PUBLIC, grantedUsers: [creator], creator },
      ]);
      await Page.rename(page, '/grant/history-phase1-rename-only-moved', creator, {});

      const created = await Comment.create({ page: page._id, creator, revision: undefined, comment: 'after rename', commentPosition: undefined });
      expect(created.comment).toBe('after rename');
      const stillThere = await Comment.countDocuments({ _id: created._id });
      expect(stillThere).toBe(1);
    });

    test('with $locals.authSnapshot (what addComment sets): a page renamed (not trashed) since authorization IS compensated — AC-10\'s literal "trash / rename"', async () => {
      const creator = await User.findUserByUsername('anonymous1');
      const [page] = await Fixture.generate('Page', [
        { path: '/grant/history-phase1-rename-snapshot', grant: Page.GRANT_PUBLIC, grantedUsers: [creator], creator },
      ]);
      const authSnapshot = { status: page.status, path: page.path };

      await Page.rename(await Page.findById(page._id), '/grant/history-phase1-rename-snapshot-moved', creator, {});

      const draft = new Comment({ page: page._id, creator, revision: undefined, comment: 'renamed under me', commentPosition: undefined });
      draft.$locals.authSnapshot = authSnapshot;
      await expect(draft.save()).rejects.toThrow('Page not found');

      const remaining = await Comment.countDocuments({ comment: 'renamed under me' });
      expect(remaining).toBe(0);
    });

    test('a trash-then-restore round trip that lands back on the IDENTICAL {status, path} authorized is NOT compensated — no lifecycle churn was actually lost', async () => {
      const creator = await User.findUserByUsername('anonymous1');
      const [page] = await Fixture.generate('Page', [{ path: '/grant/history-phase1-roundtrip', grant: Page.GRANT_PUBLIC, grantedUsers: [creator], creator }]);
      const authSnapshot = { status: page.status, path: page.path };

      await Page.deletePage(await Page.findById(page._id), creator);
      const trashed = await Page.findById(page._id);
      await Page.revertDeletedPage(trashed, creator);
      const restored = await Page.findById(page._id);
      // The round trip really did land back on the authorized values —
      // otherwise this test would not exercise what it claims to.
      expect(restored.status).toBe(authSnapshot.status);
      expect(restored.path).toBe(authSnapshot.path);

      const draft = new Comment({ page: page._id, creator, revision: undefined, comment: 'survived the round trip', commentPosition: undefined });
      draft.$locals.authSnapshot = authSnapshot;
      const created = await draft.save();
      expect(created.comment).toBe('survived the round trip');
      const stillThere = await Comment.countDocuments({ _id: created._id });
      expect(stillThere).toBe(1);
    });

    test('editing an existing comment is never compensated by this check, even if its page is trashed afterward', async () => {
      const creator = await User.findUserByUsername('anonymous1');
      const [page] = await Fixture.generate('Page', [
        { path: '/grant/history-phase1-edit-after-trash', grant: Page.GRANT_PUBLIC, grantedUsers: [creator], creator },
      ]);
      const created = await Comment.create({ page: page._id, creator, revision: undefined, comment: 'before trash', commentPosition: undefined });

      await Page.deletePage(page, creator);

      created.comment = 'edited after page trashed';
      await expect(created.save()).resolves.toBeTruthy();
      const stillThere = await Comment.countDocuments({ _id: created._id });
      expect(stillThere).toBe(1);
    });
  });
});
