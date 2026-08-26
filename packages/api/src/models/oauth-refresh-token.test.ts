import mongoose from 'mongoose';

import { crowi } from 'src/test/setup';
import type { OAuthRefreshTokenModel } from 'src/models/oauth-refresh-token';

/**
 * RFC-0010 Phase 3 — OAuthRefreshToken unit tests (active lookup, rotation
 * chain, reuse-detection revokeChain, TTL).
 */
describe('OAuthRefreshToken', () => {
  const ObjectId = mongoose.Types.ObjectId;
  let OAuthRefreshToken: OAuthRefreshTokenModel;

  beforeAll(() => {
    OAuthRefreshToken = crowi.model('OAuthRefreshToken');
  });

  beforeEach(async () => {
    await OAuthRefreshToken.deleteMany({});
  });

  const create = (
    overrides: Partial<{
      revokedAt: Date | null;
      rotatedTo: string | null;
      expiresAt: Date;
      userId: InstanceType<typeof ObjectId>;
      authorizedAt: Date;
      createdAt: Date;
    }> = {},
  ) => {
    const { token, tokenHash } = OAuthRefreshToken.generateToken();
    return OAuthRefreshToken.create({
      tokenHash,
      clientId: 'crowi-cli',
      userId: overrides.userId ?? new ObjectId(),
      scopes: ['pages:read'],
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 86_400_000),
      revokedAt: overrides.revokedAt ?? null,
      rotatedTo: overrides.rotatedTo ?? null,
      ...(overrides.authorizedAt !== undefined ? { authorizedAt: overrides.authorizedAt } : {}),
      ...(overrides.createdAt !== undefined ? { createdAt: overrides.createdAt } : {}),
    }).then((doc) => ({ token, tokenHash, doc }));
  };

  it('generates a crowi_rt_ prefixed token + stable hash', () => {
    const { token, tokenHash } = OAuthRefreshToken.generateToken();
    expect(token.startsWith('crowi_rt_')).toBe(true);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(OAuthRefreshToken.hashToken(token)).toBe(tokenHash);
    expect(OAuthRefreshToken.TOKEN_PREFIX).toBe('crowi_rt_');
  });

  describe('.findActiveByHash', () => {
    it('returns an active token', async () => {
      const { tokenHash } = await create();
      expect(await OAuthRefreshToken.findActiveByHash(tokenHash)).not.toBeNull();
    });
    it('excludes revoked / expired tokens', async () => {
      const revoked = await create({ revokedAt: new Date() });
      const expired = await create({ expiresAt: new Date(Date.now() - 1000) });
      expect(await OAuthRefreshToken.findActiveByHash(revoked.tokenHash)).toBeNull();
      expect(await OAuthRefreshToken.findActiveByHash(expired.tokenHash)).toBeNull();
    });
  });

  describe('.revokeChain (reuse detection)', () => {
    it('revokes the whole rotation chain (ancestors + descendants)', async () => {
      // chain: A -> B -> C  (A.rotatedTo = B, B.rotatedTo = C)
      const c = await create();
      const b = await create({ rotatedTo: c.tokenHash, revokedAt: new Date() });
      const a = await create({ rotatedTo: b.tokenHash, revokedAt: new Date() });

      // Replaying B (already revoked) triggers chain revocation.
      await OAuthRefreshToken.revokeChain(b.tokenHash);

      const after = async (hash: string) => (await OAuthRefreshToken.findOne({ tokenHash: hash }))?.revokedAt;
      expect(await after(a.tokenHash)).not.toBeNull();
      expect(await after(b.tokenHash)).not.toBeNull();
      // C was still active; revokeChain must kill it too.
      expect(await after(c.tokenHash)).not.toBeNull();
    });
  });

  it('declares a TTL index on expiresAt', () => {
    const indexes = OAuthRefreshToken.schema.indexes();
    const ttl = indexes.find(([, opts]) => (opts as { expireAfterSeconds?: number }).expireAfterSeconds === 0);
    expect(ttl).toBeDefined();
  });

  describe('authorizedAt', () => {
    it('stores an explicit authorizedAt', async () => {
      const authorizedAt = new Date(Date.now() - 60_000);
      const { doc } = await create({ authorizedAt });
      expect(doc.authorizedAt?.getTime()).toBe(authorizedAt.getTime());
    });

    it('is undefined on a legacy row that never set it (no backfill)', async () => {
      const { doc } = await create();
      expect(doc.authorizedAt).toBeUndefined();
    });
  });

  describe('.listActiveByUser', () => {
    it('returns only the caller’s own active tips, newest first', async () => {
      const userId = new ObjectId();
      const otherUserId = new ObjectId();
      const now = new Date();

      const older = await create({ userId, createdAt: new Date(now.getTime() - 10_000) });
      const newer = await create({ userId, createdAt: now });
      await create({ userId: otherUserId }); // other user — excluded

      const rows = await OAuthRefreshToken.listActiveByUser(userId, now);
      expect(rows.map((r) => r._id.toString())).toEqual([newer.doc._id.toString(), older.doc._id.toString()]);
    });

    it('excludes revoked, rotated (non-tip), and expired rows', async () => {
      const userId = new ObjectId();
      const now = new Date();

      await create({ userId, revokedAt: now }); // revoked
      await create({ userId, rotatedTo: 'deadbeef' }); // not a tip
      await create({ userId, expiresAt: new Date(now.getTime() - 1000) }); // expired
      const tip = await create({ userId });

      const rows = await OAuthRefreshToken.listActiveByUser(userId, now);
      expect(rows.map((r) => r._id.toString())).toEqual([tip.doc._id.toString()]);
    });

    it('filters expiresAt against the SAME now instant passed by the caller (not a freshly generated one)', async () => {
      const userId = new ObjectId();
      // A row that is active as of `past` but already expired as of `Date.now()`.
      const past = new Date(Date.now() - 120_000);
      const expiresSoonAfterPast = new Date(past.getTime() + 60_000);
      await create({ userId, expiresAt: expiresSoonAfterPast });

      // Using the caller-supplied `past` as `now`, the row is still active.
      const rows = await OAuthRefreshToken.listActiveByUser(userId, past);
      expect(rows).toHaveLength(1);
    });
  });
});
