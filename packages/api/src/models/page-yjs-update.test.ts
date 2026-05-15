import faker from 'faker';
import mongoose from 'mongoose';
import { crowi, Fixture } from 'src/test/setup';

describe('PageYjsUpdate', () => {
  let PageYjsUpdate;
  let Page;
  let user;
  let page;

  beforeAll(async () => {
    PageYjsUpdate = crowi.model('PageYjsUpdate');
    Page = crowi.model('Page');

    const users = await Fixture.generate('User', [{ name: faker.name.findName(), username: faker.internet.userName(), email: faker.internet.email() }]);
    user = users[0];

    page = await Page.createPage(`/yjs-update-${faker.lorem.slug()}`, '# yjs', user, {});
  });

  describe('create + read', () => {
    test('persists a Yjs update buffer and reads it back as Buffer', async () => {
      const payload = Buffer.from([1, 2, 3, 4, 5]);
      const doc = await PageYjsUpdate.create({ pageId: page._id, payload });

      const fetched = await PageYjsUpdate.findById(doc._id);
      expect(fetched).not.toBeNull();
      expect(fetched.pageId.toString()).toBe(page._id.toString());
      // Mongoose returns Buffer-typed sub-types; `.equals` confirms
      // byte-identical round trip (driver did not stringify it).
      expect(Buffer.isBuffer(fetched.payload) || fetched.payload instanceof mongoose.mongo.Binary).toBe(true);
      const asBuffer = Buffer.isBuffer(fetched.payload) ? fetched.payload : Buffer.from(fetched.payload.buffer);
      expect(asBuffer.equals(payload)).toBe(true);
      expect(fetched.createdAt).toBeInstanceOf(Date);
    });

    test('defaults createdAt when omitted', async () => {
      const before = Date.now();
      const doc = await PageYjsUpdate.create({ pageId: page._id, payload: Buffer.from([0xff]) });
      const after = Date.now();
      expect(doc.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1);
      expect(doc.createdAt.getTime()).toBeLessThanOrEqual(after + 1);
    });

    test('rejects documents missing required fields', async () => {
      await expect(PageYjsUpdate.create({ pageId: page._id })).rejects.toThrow();
      await expect(PageYjsUpdate.create({ payload: Buffer.from([0x00]) })).rejects.toThrow();
    });
  });

  describe('indexes', () => {
    test('declares the compound {pageId, createdAt} and TTL {createdAt} indexes', async () => {
      // `Model.collection.indexes()` returns the live MongoDB index
      // catalogue. We assert by name so renaming an index in code
      // surfaces immediately, and we verify the TTL is configured
      // for 1 hour (3600s) per the RFC-0003 Phase 4 contract.
      // syncIndexes() blocks until index creation is acked by mongod;
      // mongoose's autoIndex fire-and-forgets which races with the
      // per-test-file db introduced by docker-mongo CI.
      await PageYjsUpdate.syncIndexes();
      const indexes = await PageYjsUpdate.collection.indexes();
      const compound = indexes.find((idx) => idx.name === 'pageYjsUpdate_pageId_createdAt');
      expect(compound).toBeDefined();
      expect(compound?.key).toEqual({ pageId: 1, createdAt: 1 });

      const ttl = indexes.find((idx) => idx.name === 'pageYjsUpdate_ttl');
      expect(ttl).toBeDefined();
      expect(ttl?.key).toEqual({ createdAt: 1 });
      expect(ttl?.expireAfterSeconds).toBe(3600);
    });
  });
});
