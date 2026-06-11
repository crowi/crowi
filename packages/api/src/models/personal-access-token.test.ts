import mongoose from 'mongoose';

import { crowi } from 'src/test/setup';
import type { PersonalAccessTokenModel } from 'src/models/personal-access-token';

/**
 * RFC-0010 §Token model — PersonalAccessToken unit tests.
 *
 * Covers token generation (prefix + one-way hash), `findActiveByHash`
 * filtering (revoked / expired excluded, non-expiring included), scope
 * persistence, and the `tokenHash` unique constraint.
 */
describe('PersonalAccessToken', () => {
  const ObjectId = mongoose.Types.ObjectId;
  let PersonalAccessToken: PersonalAccessTokenModel;

  beforeAll(() => {
    PersonalAccessToken = crowi.model('PersonalAccessToken');
  });

  beforeEach(async () => {
    await PersonalAccessToken.deleteMany({});
  });

  describe('.generateToken / .hashToken', () => {
    it('produces a crowi_pat_ prefixed plaintext and a stable SHA-256 hash', () => {
      const { token, tokenHash } = PersonalAccessToken.generateToken();
      expect(token.startsWith('crowi_pat_')).toBe(true);
      // 32 random bytes -> base64url; comfortably long + unguessable.
      expect(token.length).toBeGreaterThan('crowi_pat_'.length + 20);
      // hash is deterministic and 64 hex chars (sha256).
      expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(PersonalAccessToken.hashToken(token)).toBe(tokenHash);
    });

    it('never stores the plaintext (only the hash field exists)', async () => {
      const userId = new ObjectId();
      const { token, tokenHash } = PersonalAccessToken.generateToken();
      const doc = await PersonalAccessToken.create({ tokenHash, userId, name: 'tok', scopes: ['pages:read'] });
      const raw = doc.toObject();
      expect(raw).not.toHaveProperty('token');
      expect(raw.tokenHash).toBe(tokenHash);
      expect(token).not.toBe(tokenHash);
    });
  });

  describe('.findActiveByHash', () => {
    it('returns a non-expiring, non-revoked token', async () => {
      const userId = new ObjectId();
      const { tokenHash } = PersonalAccessToken.generateToken();
      await PersonalAccessToken.create({ tokenHash, userId, name: 'active', scopes: ['read'], expiresAt: null });

      const found = await PersonalAccessToken.findActiveByHash(tokenHash);
      expect(found).not.toBeNull();
      expect(found?.name).toBe('active');
    });

    it('returns a token whose expiry is in the future', async () => {
      const userId = new ObjectId();
      const { tokenHash } = PersonalAccessToken.generateToken();
      await PersonalAccessToken.create({ tokenHash, userId, name: 'fut', scopes: [], expiresAt: new Date(Date.now() + 60_000) });

      const found = await PersonalAccessToken.findActiveByHash(tokenHash);
      expect(found?.name).toBe('fut');
    });

    it('excludes expired tokens', async () => {
      const userId = new ObjectId();
      const { tokenHash } = PersonalAccessToken.generateToken();
      await PersonalAccessToken.create({ tokenHash, userId, name: 'exp', scopes: [], expiresAt: new Date(Date.now() - 1_000) });

      expect(await PersonalAccessToken.findActiveByHash(tokenHash)).toBeNull();
    });

    it('excludes revoked tokens', async () => {
      const userId = new ObjectId();
      const { tokenHash } = PersonalAccessToken.generateToken();
      await PersonalAccessToken.create({ tokenHash, userId, name: 'rev', scopes: [], revokedAt: new Date() });

      expect(await PersonalAccessToken.findActiveByHash(tokenHash)).toBeNull();
    });

    it('returns null for an unknown hash', async () => {
      expect(await PersonalAccessToken.findActiveByHash('deadbeef')).toBeNull();
    });
  });

  describe('scope persistence + listByUser', () => {
    it('stores the scope array verbatim and lists newest-first', async () => {
      const userId = new ObjectId();
      const a = PersonalAccessToken.generateToken();
      const b = PersonalAccessToken.generateToken();
      await PersonalAccessToken.create({ tokenHash: a.tokenHash, userId, name: 'first', scopes: ['pages:read', 'comments:write'] });
      await new Promise((r) => setTimeout(r, 5));
      await PersonalAccessToken.create({ tokenHash: b.tokenHash, userId, name: 'second', scopes: ['read'] });

      const list = await PersonalAccessToken.listByUser(userId);
      expect(list).toHaveLength(2);
      expect(list[0].name).toBe('second');
      expect(list[1].scopes).toEqual(['pages:read', 'comments:write']);
    });

    it('only returns the given user tokens', async () => {
      const me = new ObjectId();
      const other = new ObjectId();
      await PersonalAccessToken.create({ tokenHash: PersonalAccessToken.generateToken().tokenHash, userId: me, name: 'mine', scopes: [] });
      await PersonalAccessToken.create({ tokenHash: PersonalAccessToken.generateToken().tokenHash, userId: other, name: 'theirs', scopes: [] });

      const list = await PersonalAccessToken.listByUser(me);
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe('mine');
    });
  });

  describe('.touchLastUsed', () => {
    it('sets lastUsedAt', async () => {
      const userId = new ObjectId();
      const { tokenHash } = PersonalAccessToken.generateToken();
      const doc = await PersonalAccessToken.create({ tokenHash, userId, name: 'touch', scopes: [] });
      expect(doc.lastUsedAt).toBeNull();

      await doc.touchLastUsed();
      const reread = await PersonalAccessToken.findById(doc._id);
      expect(reread?.lastUsedAt).toBeInstanceOf(Date);
    });
  });

  describe('tokenHash uniqueness', () => {
    it('rejects a duplicate tokenHash', async () => {
      const userId = new ObjectId();
      const { tokenHash } = PersonalAccessToken.generateToken();
      await PersonalAccessToken.create({ tokenHash, userId, name: 'one', scopes: [] });
      // Ensure the unique index is built before asserting the conflict.
      await PersonalAccessToken.init();
      await expect(PersonalAccessToken.create({ tokenHash, userId, name: 'dup', scopes: [] })).rejects.toMatchObject({ code: 11000 });
    });
  });
});
