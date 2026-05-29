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

  const create = (overrides: Partial<{ revokedAt: Date | null; rotatedTo: string | null; expiresAt: Date }> = {}) => {
    const { token, tokenHash } = OAuthRefreshToken.generateToken();
    return OAuthRefreshToken.create({
      tokenHash,
      clientId: 'crowi-cli',
      userId: new ObjectId(),
      scopes: ['pages:read'],
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 86_400_000),
      revokedAt: overrides.revokedAt ?? null,
      rotatedTo: overrides.rotatedTo ?? null,
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
});
