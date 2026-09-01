import { faker } from '@faker-js/faker';
import { crowi, Fixture, randomUsername } from 'src/test/setup';
import type { UserIdentityModel } from 'src/models/user-identity';

/**
 * feature-auth-google-phase0-sdk-identity — `UserIdentity` model + indexes.
 *
 * Phase 0 ships the model and its three indexes only (no create/find/delete
 * helpers yet — see `user-identity.ts`'s doc comment), so this suite covers
 * AC-5 (schema shape) and AC-6 (the two unique constraints + the plain
 * `{ userId }` index) directly against the raw Mongoose model.
 */

const isE11000 = (err: unknown): boolean => typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;

describe('UserIdentity', () => {
  let UserIdentity: UserIdentityModel;
  let userAId: string;
  let userBId: string;

  beforeAll(async () => {
    UserIdentity = crowi.model('UserIdentity');
    // `syncIndexes()` blocks until index creation is acked by mongod —
    // mongoose's autoIndex fire-and-forgets, which races the per-test-file
    // db (see `page-yjs-update.test.ts` for the same precedent).
    await UserIdentity.syncIndexes();

    const users = await Fixture.generate('User', [
      { name: faker.person.fullName(), username: randomUsername(), email: faker.internet.email() },
      { name: faker.person.fullName(), username: randomUsername(), email: faker.internet.email() },
    ]);
    userAId = users[0]._id.toString();
    userBId = users[1]._id.toString();
  });

  afterEach(async () => {
    await UserIdentity.deleteMany({});
  });

  describe('schema (AC-5)', () => {
    it('is registered on the Crowi model registry and can be retrieved via crowi.model()', () => {
      expect(UserIdentity).toBeDefined();
    });

    it('uses the RFC-0014 §7 physical collection name user_identities, not mongoose default pluralization', () => {
      expect(UserIdentity.collection.collectionName).toBe('user_identities');
    });

    it('persists required userId/provider/providerUserId and defaults linkedAt', async () => {
      const before = Date.now();
      const doc = await UserIdentity.create({ userId: userAId, provider: 'google', providerUserId: 'google-sub-1' });
      const after = Date.now();

      expect(doc.userId.toString()).toBe(userAId);
      expect(doc.provider).toBe('google');
      expect(doc.providerUserId).toBe('google-sub-1');
      expect(doc.linkedAt).toBeInstanceOf(Date);
      expect(doc.linkedAt.getTime()).toBeGreaterThanOrEqual(before - 1);
      expect(doc.linkedAt.getTime()).toBeLessThanOrEqual(after + 1);
      expect(doc.providerRefreshTokenEnc).toBeUndefined();
    });

    it('accepts an optional providerRefreshTokenEnc', async () => {
      const doc = await UserIdentity.create({
        userId: userAId,
        provider: 'google',
        providerUserId: 'google-sub-2',
        providerRefreshTokenEnc: 'enc:opaque-ciphertext',
      });
      expect(doc.providerRefreshTokenEnc).toBe('enc:opaque-ciphertext');
    });

    it('rejects documents missing required fields', async () => {
      await expect(UserIdentity.create({ provider: 'google', providerUserId: 'sub' })).rejects.toThrow(/Path `userId` is required/);
      await expect(UserIdentity.create({ userId: userAId, providerUserId: 'sub' })).rejects.toThrow(/Path `provider` is required/);
      await expect(UserIdentity.create({ userId: userAId, provider: 'google' })).rejects.toThrow(/Path `providerUserId` is required/);
    });
  });

  describe('indexes (AC-6)', () => {
    it('declares the two unique compound indexes and the plain {userId} index', async () => {
      const indexes = await UserIdentity.collection.indexes();

      const providerUnique = indexes.find((idx) => idx.name === 'userIdentity_provider_providerUserId_unique');
      expect(providerUnique).toBeDefined();
      expect(providerUnique?.key).toEqual({ provider: 1, providerUserId: 1 });
      expect(providerUnique?.unique).toBe(true);

      const userProviderUnique = indexes.find((idx) => idx.name === 'userIdentity_userId_provider_unique');
      expect(userProviderUnique).toBeDefined();
      expect(userProviderUnique?.key).toEqual({ userId: 1, provider: 1 });
      expect(userProviderUnique?.unique).toBe(true);

      const userIdIndex = indexes.find((idx) => idx.name === 'userIdentity_userId');
      expect(userIdIndex).toBeDefined();
      expect(userIdIndex?.key).toEqual({ userId: 1 });
      expect(userIdIndex?.unique).toBeUndefined();
    });

    it('rejects a second identity with the same {provider, providerUserId} for a different user', async () => {
      await UserIdentity.create({ userId: userAId, provider: 'google', providerUserId: 'shared-subject' });
      await expect(UserIdentity.create({ userId: userBId, provider: 'google', providerUserId: 'shared-subject' })).rejects.toMatchObject({
        code: 11000,
      });
    });

    it('rejects a second identity with the same {userId, provider} pointing at a different provider subject', async () => {
      await UserIdentity.create({ userId: userAId, provider: 'google', providerUserId: 'subject-1' });
      await expect(UserIdentity.create({ userId: userAId, provider: 'google', providerUserId: 'subject-2' })).rejects.toMatchObject({
        code: 11000,
      });
    });

    it('allows the same user to hold identities for two different providers', async () => {
      await UserIdentity.create({ userId: userAId, provider: 'google', providerUserId: 'google-subject' });
      await expect(UserIdentity.create({ userId: userAId, provider: 'github', providerUserId: 'github-subject' })).resolves.toMatchObject({
        provider: 'github',
      });
    });

    it('isDuplicateKeyError-style E11000 is raised for the provider/providerUserId collision', async () => {
      await UserIdentity.create({ userId: userAId, provider: 'google', providerUserId: 'probe-subject' });
      try {
        await UserIdentity.create({ userId: userBId, provider: 'google', providerUserId: 'probe-subject' });
        throw new Error('expected a duplicate-key error');
      } catch (err) {
        expect(isE11000(err)).toBe(true);
      }
    });

    it('also rejects an updateOne() that would collide an existing document into a duplicate {userId, provider} pair', async () => {
      // MongoDB's unique indexes enforce on every write, not just insert —
      // a document mutated via updateOne() into a pre-existing key is
      // rejected the same way create() is above.
      await UserIdentity.create({ userId: userAId, provider: 'google', providerUserId: 'subject-1' });
      const other = await UserIdentity.create({ userId: userAId, provider: 'github', providerUserId: 'subject-2' });

      await expect(UserIdentity.updateOne({ _id: other._id }, { $set: { provider: 'google' } })).rejects.toMatchObject({
        code: 11000,
      });
    });
  });
});
