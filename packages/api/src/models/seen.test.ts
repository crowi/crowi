import mongoose from 'mongoose';
import { crowi } from 'src/test/setup';
import type { SeenModel } from './seen';

/**
 * feature-page-relations-collections AC-1/AC-5 — `Seen` relation model
 * unit/integration tests.
 *
 * `Seen.ensureUniqueIndex()` is awaited in `beforeAll` (mirrors
 * `user-uniqueness.test.ts:24` / `like.test.ts`) — schema is `autoIndex:
 * false` (D-1), so nothing else in this phase builds the `{page,user}`
 * unique index this file's concurrency assertions depend on.
 */
describe('Seen', () => {
  let Seen: SeenModel;
  const ObjectId = mongoose.Types.ObjectId;

  beforeAll(async () => {
    Seen = crowi.model('Seen');
    await Seen.ensureUniqueIndex();
  });

  afterEach(async () => {
    await Seen.deleteMany({});
  });

  describe('ensureUniqueIndex', () => {
    it('builds page single-field, user single-field, and {page:1,user:1} unique indexes, verified from the catalog', async () => {
      const indexes = await Seen.collection.indexes();

      const pageIndex = indexes.find((idx) => Object.keys(idx.key).length === 1 && idx.key.page === 1);
      const userIndex = indexes.find((idx) => Object.keys(idx.key).length === 1 && idx.key.user === 1);
      const compoundIndex = indexes.find((idx) => Object.keys(idx.key).length === 2 && idx.key.page === 1 && idx.key.user === 1);

      expect(pageIndex).toBeDefined();
      expect(userIndex).toBeDefined();
      expect(compoundIndex).toBeDefined();
      expect(compoundIndex?.unique).toBe(true);
      expect(pageIndex?.unique).not.toBe(true);
      expect(userIndex?.unique).not.toBe(true);
    });
  });

  it('does not publicly expose a single-row remove static (only page-level removeByPageId, D-1)', () => {
    expect((Seen as unknown as { remove?: unknown }).remove).toBeUndefined();
  });

  describe('.add', () => {
    it('a first add() inserts a row (inserted:true) with a live createdAt timestamp', async () => {
      const pageId = new ObjectId();
      const userId = new ObjectId();

      const result = await Seen.add(pageId, userId);
      expect(result.inserted).toBe(true);
      expect(result.document).not.toBeNull();
      expect(result.document?.page.toString()).toBe(pageId.toString());
      expect(result.document?.user.toString()).toBe(userId.toString());
      expect(result.document?.createdAt).toBeInstanceOf(Date);

      expect(await Seen.countDocuments({ page: pageId, user: userId })).toBe(1);
    });

    it('a retry add() for the same identity is idempotent: inserted:false, same row, still exactly one row', async () => {
      const pageId = new ObjectId();
      const userId = new ObjectId();

      const first = await Seen.add(pageId, userId);
      const second = await Seen.add(pageId, userId);

      expect(first.inserted).toBe(true);
      expect(second.inserted).toBe(false);
      expect(second.document?._id.toString()).toBe(first.document?._id.toString());
      expect(await Seen.countDocuments({ page: pageId, user: userId })).toBe(1);
    });

    it('concurrent add() calls for the same identity converge on exactly one row (unique index + E11000 fallback, C-CONCURRENCY)', async () => {
      const pageId = new ObjectId();
      const userId = new ObjectId();

      const [a, b] = await Promise.all([Seen.add(pageId, userId), Seen.add(pageId, userId)]);

      expect(a.document).not.toBeNull();
      expect(b.document).not.toBeNull();
      expect(a.document?._id.toString()).toBe(b.document?._id.toString());
      expect([a.inserted, b.inserted].filter(Boolean)).toHaveLength(1);
      expect(await Seen.countDocuments({ page: pageId, user: userId })).toBe(1);
    });
  });

  describe('.getCountsByPageIds', () => {
    it('accepts string page ids and still matches ObjectId-stored rows with a non-zero count (D-2 cast boundary)', async () => {
      const pageId = new ObjectId();
      await Seen.add(pageId, new ObjectId());
      await Seen.add(pageId, new ObjectId());

      const counts = await Seen.getCountsByPageIds([pageId.toString()]);
      expect(counts.get(pageId.toString())).toBe(2);
    });

    it('returns an empty Map for an empty input', async () => {
      expect(await Seen.getCountsByPageIds([])).toEqual(new Map());
    });
  });

  describe('.findByPageId', () => {
    it('returns every row for the page in _id ascending order (D-1 deterministic default sort)', async () => {
      const pageId = new ObjectId();
      const first = await Seen.add(pageId, new ObjectId());
      const second = await Seen.add(pageId, new ObjectId());
      await Seen.add(new ObjectId(), new ObjectId());

      const rows = await Seen.findByPageId(pageId);
      expect(rows).toHaveLength(2);
      const ids = rows.map((r) => r._id.toString());
      expect(ids).toEqual([...ids].sort());
      // Both inserted rows are present regardless of insertion order.
      expect(new Set(ids)).toEqual(new Set([first.document?._id.toString(), second.document?._id.toString()]));
    });

    it('accepts readPreference: "primary" and forwards it onto the query (AC-13 read-back pin)', async () => {
      const pageId = new ObjectId();
      await Seen.add(pageId, new ObjectId());

      const readSpy = jest.fn().mockReturnThis();
      const findSpy = jest.spyOn(Seen, 'find').mockReturnValueOnce({
        sort: () => ({
          read: readSpy,
          exec: async () => [],
        }),
      } as unknown as ReturnType<SeenModel['find']>);

      try {
        await Seen.findByPageId(pageId, { readPreference: 'primary' });
        expect(readSpy).toHaveBeenCalledWith('primary');
      } finally {
        findSpy.mockRestore();
      }
    });
  });

  describe('.removeByPageId', () => {
    it('deletes every row for the page and leaves other pages untouched', async () => {
      const pageId = new ObjectId();
      const otherPageId = new ObjectId();
      await Seen.add(pageId, new ObjectId());
      await Seen.add(otherPageId, new ObjectId());

      await Seen.removeByPageId(pageId);

      expect(await Seen.countDocuments({ page: pageId })).toBe(0);
      expect(await Seen.countDocuments({ page: otherPageId })).toBe(1);
    });

    it('is a no-op (no error) for a page with no Seen rows', async () => {
      await expect(Seen.removeByPageId(new ObjectId())).resolves.toBeUndefined();
    });
  });
});
