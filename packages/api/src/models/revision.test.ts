import faker from 'faker';
import mongoose from 'mongoose';
import { crowi, Fixture } from 'src/test/setup';

describe('Revision (RFC-0003 collab fields)', () => {
  let Revision;
  let Page;
  let user;

  beforeAll(async () => {
    Revision = crowi.model('Revision');
    Page = crowi.model('Page');

    const users = await Fixture.generate('User', [{ name: faker.name.findName(), username: faker.internet.userName(), email: faker.internet.email() }]);
    user = users[0];
  });

  describe('v1.x backward compat', () => {
    test('reads a revision written without the RFC-0003 fields as undefined', async () => {
      // Simulate a v1.x revision: only the historical fields are set.
      // The Phase 1 schema additions must default to undefined so the
      // read path can distinguish "predates RFC-0003" from "explicit
      // empty" (matters for `contributors` — undefined vs []).
      const doc = await Revision.create({
        path: '/legacy/page',
        body: 'legacy body',
        format: 'markdown',
        author: user._id,
        createdAt: new Date(),
      });
      const fetched = await Revision.findById(doc._id).lean();
      expect(fetched.parentRevisionId).toBeUndefined();
      expect(fetched.type).toBeUndefined();
      expect(fetched.yjsUpdate).toBeUndefined();
      expect(fetched.savedBy).toBeUndefined();
      expect(fetched.contributors).toBeUndefined();
      expect(fetched.message).toBeUndefined();
    });
  });

  describe('snapshot revision', () => {
    test('persists a snapshot-type revision with savedBy + contributors', async () => {
      const contributorIds = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
      const doc = await Revision.create({
        path: '/snapshot/page',
        body: 'snapshot body',
        format: 'markdown',
        author: user._id,
        type: 'snapshot',
        savedBy: user._id,
        contributors: contributorIds,
        message: 'initial save',
        createdAt: new Date(),
      });
      const fetched = await Revision.findById(doc._id).lean();
      expect(fetched.type).toBe('snapshot');
      expect(fetched.savedBy.toString()).toBe(user._id.toString());
      expect(fetched.contributors.map((id) => id.toString())).toEqual(contributorIds.map((id) => id.toString()));
      expect(fetched.message).toBe('initial save');
    });
  });

  describe('incremental revision', () => {
    test('persists an incremental revision with yjsUpdate + parentRevisionId', async () => {
      const parent = await Revision.create({
        path: '/incremental/page',
        body: 'parent',
        author: user._id,
        type: 'snapshot',
      });
      const updateBytes = Buffer.from([0x10, 0x20, 0x30]);
      const doc = await Revision.create({
        path: '/incremental/page',
        body: 'parent + delta', // current body snapshot for read fallback
        author: user._id,
        parentRevisionId: parent._id,
        type: 'incremental',
        yjsUpdate: updateBytes,
        savedBy: user._id,
        contributors: [user._id],
      });
      const fetched = await Revision.findById(doc._id);
      expect(fetched.type).toBe('incremental');
      expect(fetched.parentRevisionId?.toString()).toBe(parent._id.toString());
      const asBuffer = Buffer.isBuffer(fetched.yjsUpdate) ? fetched.yjsUpdate : Buffer.from((fetched.yjsUpdate as any).buffer);
      expect(asBuffer.equals(updateBytes)).toBe(true);
    });

    test('rejects type values outside the snapshot/incremental enum', async () => {
      await expect(
        Revision.create({
          path: '/invalid/page',
          body: 'x',
          author: user._id,
          type: 'rogue',
        }),
      ).rejects.toThrow(/`rogue` is not a valid enum value for path `type`/);
    });
  });

  describe('prepareRevision options (Phase 5 collab fields)', () => {
    // Build a minimal page-shaped object that satisfies the
    // `prepareRevision(pageData, body, user, opts)` signature. We don't
    // need a persisted Page document — `prepareRevision` only reads
    // `pageData.path`, runs the renderer, and assigns to a fresh
    // unsaved Revision instance.
    async function seedPage(pathSuffix: string) {
      // The Page model auto-validates `grant` so use the same shape as
      // Page.createPage callers. We never save the returned page.
      return await Page.create({
        path: `/prepare-revision-${pathSuffix}-${Date.now()}`,
        creator: user._id,
        lastUpdateUser: user._id,
        grant: 1,
        status: 'published',
        grantedUsers: [user._id],
      });
    }

    test('omitting options leaves all collab fields undefined (v1.x callsite compat)', async () => {
      const page = await seedPage('compat');
      const rev = await Revision.prepareRevision(page, 'body', user);
      expect(rev.savedBy).toBeUndefined();
      expect(rev.contributors).toBeUndefined();
      expect(rev.message).toBeUndefined();
      expect(rev.type).toBeUndefined();
      expect(rev.parentRevisionId).toBeUndefined();
      // Existing format default still kicks in.
      expect(rev.format).toBe('markdown');
    });

    test('passing options.savedBy assigns the trigger user', async () => {
      const page = await seedPage('savedby');
      const otherUserId = new mongoose.Types.ObjectId();
      const rev = await Revision.prepareRevision(page, 'b', user, { savedBy: otherUserId });
      expect(rev.savedBy?.toString()).toBe(otherUserId.toString());
      // author still tracks the historical "owns the row" semantics —
      // savedBy is a *separate* pointer.
      expect(rev.author.toString()).toBe(user._id.toString());
    });

    test('passing options.contributors assigns the awareness participants', async () => {
      const page = await seedPage('contrib');
      const contributorIds = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
      const rev = await Revision.prepareRevision(page, 'b', user, { contributors: contributorIds });
      expect(rev.contributors?.map((id) => id.toString())).toEqual(contributorIds.map((id) => id.toString()));
    });

    test('passing options.message / type / parentRevisionId assigns them verbatim', async () => {
      const page = await seedPage('meta');
      const parentRevisionId = new mongoose.Types.ObjectId();
      const rev = await Revision.prepareRevision(page, 'b', user, {
        message: 'first checkpoint',
        type: 'snapshot',
        parentRevisionId,
      });
      expect(rev.message).toBe('first checkpoint');
      expect(rev.type).toBe('snapshot');
      expect(rev.parentRevisionId?.toString()).toBe(parentRevisionId.toString());
    });

    test('parentRevisionId: null is forwarded verbatim (explicit "no parent")', async () => {
      const page = await seedPage('parent-null');
      const rev = await Revision.prepareRevision(page, 'b', user, { parentRevisionId: null });
      // `null` ≠ `undefined` here: it signals "explicitly first
      // snapshot" so the read path can branch on it.
      expect(rev.parentRevisionId).toBeNull();
    });

    test('renderer metadata is still stamped under the new options shape', async () => {
      // Sanity check that we didn't accidentally bypass the renderer
      // pipeline by extending the options surface.
      const page = await seedPage('renderer-still-runs');
      const rev = await Revision.prepareRevision(page, '# Heading\n\nbody', user, { savedBy: user._id });
      expect(rev.rendererVersion).toBeDefined();
      expect(rev.meta).toBeDefined();
      // The unified pipeline produced a TOC entry from the H1 header.
      expect(rev.meta?.toc?.[0]?.text).toBe('Heading');
    });
  });
});
