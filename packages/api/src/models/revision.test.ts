import faker from 'faker';
import mongoose from 'mongoose';
import { crowi, Fixture } from 'src/test/setup';

describe('Revision (RFC-0003 collab fields)', () => {
  let Revision;
  let user;

  beforeAll(async () => {
    Revision = crowi.model('Revision');

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
      ).rejects.toThrow();
    });
  });
});
