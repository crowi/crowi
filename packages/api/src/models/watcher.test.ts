import mongoose from 'mongoose';
import { crowi } from 'src/test/setup';

describe('Watcher', function () {
  let Watcher;
  const ObjectId = mongoose.Types.ObjectId;

  beforeAll(() => {
    Watcher = crowi.model('Watcher');
  });

  describe('.upsertWatcher', () => {
    describe('valid parameters', () => {
      it('should create', async () => {
        const userId = new ObjectId();
        const targetId = new ObjectId();

        const watcher = await Watcher.upsertWatcher(userId, 'Page', targetId, Watcher.STATUS_WATCH);
        expect(watcher.user.toString()).toBe(userId.toString());
        expect(watcher.targetModel).toBe('Page');
        expect(watcher.target.toString()).toBe(targetId.toString());
        expect(watcher.status).toBe(Watcher.STATUS_WATCH);
      });
    });
  });

  describe('.removeByPageId', () => {
    it('removeByPageId deletes WATCH and IGNORE for Page only, preserves same-id non-Page and unrelated rows, and is idempotent', async () => {
      const pageId = new ObjectId();
      const unrelatedPageId = new ObjectId();
      const userA = new ObjectId();
      const userB = new ObjectId();

      await Watcher.upsertWatcher(userA, 'Page', pageId, Watcher.STATUS_WATCH);
      await Watcher.upsertWatcher(userB, 'Page', pageId, Watcher.STATUS_IGNORE);
      await Watcher.upsertWatcher(userA, 'Page', unrelatedPageId, Watcher.STATUS_WATCH);

      // Same ObjectId VALUE as `pageId`, but a different targetModel — the
      // schema enum only allows 'Page' via upsertWatcher, so this row is
      // inserted through the native collection to bypass schema validation.
      await Watcher.collection.insertOne({
        user: userA,
        targetModel: 'Comment',
        target: pageId,
        status: Watcher.STATUS_WATCH,
        createdAt: new Date(),
      });

      const result = await Watcher.removeByPageId(pageId);
      expect(result).toEqual({ deletedCount: 2 });

      expect(await Watcher.countDocuments({ targetModel: 'Page', target: pageId })).toBe(0);
      expect(await Watcher.countDocuments({ targetModel: 'Page', target: unrelatedPageId })).toBe(1);
      expect(await Watcher.countDocuments({ targetModel: 'Comment', target: pageId })).toBe(1);

      // Re-running against the now-empty set is a no-op success, not a throw.
      const rerun = await Watcher.removeByPageId(pageId);
      expect(rerun).toEqual({ deletedCount: 0 });
    });

    it('removeByPageId throws without calling deleteMany when pageId is nullish', async () => {
      const deleteManySpy = jest.spyOn(Watcher, 'deleteMany');

      try {
        await expect(Watcher.removeByPageId(null)).rejects.toThrow(TypeError);
        await expect(Watcher.removeByPageId(undefined)).rejects.toThrow(TypeError);
        expect(deleteManySpy).not.toHaveBeenCalled();
      } finally {
        deleteManySpy.mockRestore();
      }
    });
  });
});
