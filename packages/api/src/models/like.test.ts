import mongoose from 'mongoose';
import { crowi } from 'src/test/setup';
import type { LikeModel } from './like';

/**
 * feature-page-relations-collections AC-1/AC-4/AC-9 — `Like` relation
 * model unit/integration tests.
 *
 * `Like.ensureUniqueIndex()` is awaited in `beforeAll` (mirrors
 * `user-uniqueness.test.ts:24`) because the schema is `autoIndex: false`
 * (D-1) — model registration alone never builds the `{page,user}` unique
 * index this file's concurrency assertions depend on.
 */
describe('Like', () => {
  let Like: LikeModel;
  const ObjectId = mongoose.Types.ObjectId;

  beforeAll(async () => {
    Like = crowi.model('Like');
    await Like.ensureUniqueIndex();
  });

  afterEach(async () => {
    await Like.deleteMany({});
  });

  describe('ensureUniqueIndex', () => {
    it('builds page single-field, user single-field, and {page:1,user:1} unique indexes, verified from the catalog', async () => {
      const indexes = await Like.collection.indexes();

      const pageIndex = indexes.find((idx) => Object.keys(idx.key).length === 1 && idx.key.page === 1);
      const userIndex = indexes.find((idx) => Object.keys(idx.key).length === 1 && idx.key.user === 1);
      const compoundIndex = indexes.find((idx) => Object.keys(idx.key).length === 2 && idx.key.page === 1 && idx.key.user === 1);

      expect(pageIndex).toBeDefined();
      expect(userIndex).toBeDefined();
      expect(compoundIndex).toBeDefined();
      expect(compoundIndex?.unique).toBe(true);
      // Single-field indexes are not declared unique.
      expect(pageIndex?.unique).not.toBe(true);
      expect(userIndex?.unique).not.toBe(true);
    });

    it('is safe to call repeatedly (idempotent index build)', async () => {
      await expect(Like.ensureUniqueIndex()).resolves.toBeUndefined();
      await expect(Like.ensureUniqueIndex()).resolves.toBeUndefined();
    });
  });

  describe('.add / .remove', () => {
    it('a first add() inserts a row (inserted:true) with a live createdAt timestamp', async () => {
      const pageId = new ObjectId();
      const userId = new ObjectId();

      const result = await Like.add(pageId, userId);
      expect(result.inserted).toBe(true);
      expect(result.document).not.toBeNull();
      expect(result.document?.page.toString()).toBe(pageId.toString());
      expect(result.document?.user.toString()).toBe(userId.toString());
      expect(result.document?.createdAt).toBeInstanceOf(Date);

      expect(await Like.countDocuments({ page: pageId, user: userId })).toBe(1);
    });

    it('a retry add() for the same identity is idempotent: inserted:false, same row, still exactly one row', async () => {
      const pageId = new ObjectId();
      const userId = new ObjectId();

      const first = await Like.add(pageId, userId);
      const second = await Like.add(pageId, userId);

      expect(first.inserted).toBe(true);
      expect(second.inserted).toBe(false);
      expect(second.document?._id.toString()).toBe(first.document?._id.toString());
      expect(await Like.countDocuments({ page: pageId, user: userId })).toBe(1);
    });

    it('concurrent add() calls for the same identity converge on exactly one row (unique index + E11000 fallback, C-CONCURRENCY)', async () => {
      const pageId = new ObjectId();
      const userId = new ObjectId();

      const [a, b] = await Promise.all([Like.add(pageId, userId), Like.add(pageId, userId)]);

      // Both calls must succeed (neither throws) and resolve to the SAME row.
      expect(a.document).not.toBeNull();
      expect(b.document).not.toBeNull();
      expect(a.document?._id.toString()).toBe(b.document?._id.toString());
      // Exactly one of the two calls performed the actual insert.
      expect([a.inserted, b.inserted].filter(Boolean)).toHaveLength(1);
      expect(await Like.countDocuments({ page: pageId, user: userId })).toBe(1);
    });

    it('remove() reports removed:true exactly once, then removed:false on a retry, and the row is gone', async () => {
      const pageId = new ObjectId();
      const userId = new ObjectId();
      await Like.add(pageId, userId);

      const first = await Like.remove(pageId, userId);
      const second = await Like.remove(pageId, userId);

      expect(first.removed).toBe(true);
      expect(second.removed).toBe(false);
      expect(await Like.countDocuments({ page: pageId, user: userId })).toBe(0);
    });

    it('add() after a concurrent remove() that beat the E11000 re-read returns document:null, inserted:false (spec D-1)', async () => {
      const pageId = new ObjectId();
      const userId = new ObjectId();

      // Force the E11000 branch deterministically: pre-create the row via
      // the raw collection (bypassing the model's own upsert logic), then
      // make add()'s primary findOneAndUpdate throw E11000 by pointing it
      // at an already-conflicting document, and simulate the "removed
      // between E11000 and re-read" race by deleting the row inside the
      // mocked findOneAndUpdate before add()'s own re-read runs.
      await Like.collection.insertOne({ page: pageId, user: userId, createdAt: new Date() });
      const spy = jest.spyOn(Like, 'findOneAndUpdate').mockImplementationOnce(() => {
        return {
          exec: async () => {
            await Like.deleteOne({ page: pageId, user: userId });
            const err = new Error('E11000 duplicate key error') as Error & { code: number };
            err.code = 11000;
            throw err;
          },
        } as unknown as ReturnType<LikeModel['findOneAndUpdate']>;
      });

      try {
        const result = await Like.add(pageId, userId);
        expect(result).toEqual({ document: null, inserted: false });
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('.existsByPageAndUser', () => {
    it('returns true when a row exists and false otherwise', async () => {
      const pageId = new ObjectId();
      const userId = new ObjectId();

      expect(await Like.existsByPageAndUser(pageId, userId)).toBe(false);
      await Like.add(pageId, userId);
      expect(await Like.existsByPageAndUser(pageId, userId)).toBe(true);
    });

    it('accepts readPreference: "primary" and forwards it onto the query (D-1 re-confirmation pin)', async () => {
      const pageId = new ObjectId();
      const userId = new ObjectId();
      await Like.add(pageId, userId);

      const readSpy = jest.fn().mockReturnThis();
      const existsSpy = jest.spyOn(Like, 'exists').mockReturnValueOnce({
        read: readSpy,
        then: (resolve: (v: unknown) => void) => resolve({ _id: new ObjectId() }),
      } as unknown as ReturnType<LikeModel['exists']>);

      try {
        const result = await Like.existsByPageAndUser(pageId, userId, { readPreference: 'primary' });
        expect(result).toBe(true);
        expect(readSpy).toHaveBeenCalledWith('primary');
      } finally {
        existsSpy.mockRestore();
      }
    });
  });

  describe('.countByPageId / .getCountsByPageIds', () => {
    it('countByPageId counts only rows for that page', async () => {
      const pageId = new ObjectId();
      const otherPageId = new ObjectId();
      await Like.add(pageId, new ObjectId());
      await Like.add(pageId, new ObjectId());
      await Like.add(otherPageId, new ObjectId());

      expect(await Like.countByPageId(pageId)).toBe(2);
      expect(await Like.countByPageId(otherPageId)).toBe(1);
    });

    it('getCountsByPageIds returns an empty Map for an empty input without querying', async () => {
      expect(await Like.getCountsByPageIds([])).toEqual(new Map());
    });

    // AC-9 — the search plugin bulk fetch passes STRING page ids (driver
    // page id shape); the model must cast them to ObjectId internally
    // (aggregation `$in` does not auto-cast like a Mongoose query does).
    it('accepts string page ids and still matches ObjectId-stored rows with a non-zero count (D-2 cast boundary)', async () => {
      const pageId = new ObjectId();
      await Like.add(pageId, new ObjectId());
      await Like.add(pageId, new ObjectId());

      const counts = await Like.getCountsByPageIds([pageId.toString()]);
      expect(counts.get(pageId.toString())).toBe(2);
    });
  });

  describe('.getLikedPageIdsByUser', () => {
    it('accepts string page ids and still matches ObjectId-stored rows, returning them in the membership Set (D-2 cast boundary)', async () => {
      const userId = new ObjectId();
      const likedPageId = new ObjectId();
      const notLikedPageId = new ObjectId();
      await Like.add(likedPageId, userId);

      const liked = await Like.getLikedPageIdsByUser([likedPageId.toString(), notLikedPageId.toString()], userId);
      expect(liked.has(likedPageId.toString())).toBe(true);
      expect(liked.has(notLikedPageId.toString())).toBe(false);
    });

    it('returns an empty Set for another user who has not liked any of the given pages', async () => {
      const userId = new ObjectId();
      const otherUserId = new ObjectId();
      const pageId = new ObjectId();
      await Like.add(pageId, userId);

      const liked = await Like.getLikedPageIdsByUser([pageId.toString()], otherUserId);
      expect(liked.size).toBe(0);
    });
  });

  describe('.countByUserId (D-6 existence-filtered)', () => {
    it('counts only Like rows whose Page still exists, excluding orphans', async () => {
      const Page = crowi.model('Page');
      const userId = new ObjectId();
      const existingPage = await Page.create({ path: `/like-model-test-${new ObjectId().toString()}` });

      await Like.add(existingPage._id, userId);
      // Orphan: a Like row pointing at a page id that was never created
      // (simulates a post-delete cleanup failure, D-6).
      await Like.add(new ObjectId(), userId);

      expect(await Like.countByUserId(userId)).toBe(1);

      await Page.deleteOne({ _id: existingPage._id });
    });
  });

  describe('.findByPageId / .removeByPageId', () => {
    it('findByPageId returns every row for the page, unordered and unbounded', async () => {
      const pageId = new ObjectId();
      await Like.add(pageId, new ObjectId());
      await Like.add(pageId, new ObjectId());
      await Like.add(new ObjectId(), new ObjectId());

      const rows = await Like.findByPageId(pageId);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.page.toString() === pageId.toString())).toBe(true);
    });

    it('removeByPageId deletes every row for the page and leaves other pages untouched', async () => {
      const pageId = new ObjectId();
      const otherPageId = new ObjectId();
      await Like.add(pageId, new ObjectId());
      await Like.add(otherPageId, new ObjectId());

      await Like.removeByPageId(pageId);

      expect(await Like.countDocuments({ page: pageId })).toBe(0);
      expect(await Like.countDocuments({ page: otherPageId })).toBe(1);
    });
  });
});
