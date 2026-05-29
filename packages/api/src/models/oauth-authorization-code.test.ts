import mongoose from 'mongoose';

import { crowi } from 'src/test/setup';
import type { OAuthAuthorizationCodeModel } from 'src/models/oauth-authorization-code';

/**
 * RFC-0010 Phase 3 — OAuthAuthorizationCode unit tests (TTL, single-use
 * consume, usable filtering).
 */
describe('OAuthAuthorizationCode', () => {
  const ObjectId = mongoose.Types.ObjectId;
  let OAuthAuthorizationCode: OAuthAuthorizationCodeModel;

  beforeAll(() => {
    OAuthAuthorizationCode = crowi.model('OAuthAuthorizationCode');
  });

  beforeEach(async () => {
    await OAuthAuthorizationCode.deleteMany({});
  });

  const seed = (overrides: Partial<{ expiresAt: Date; consumedAt: Date | null }> = {}) => {
    const { code, codeHash } = OAuthAuthorizationCode.generateCode();
    return OAuthAuthorizationCode.create({
      codeHash,
      clientId: 'crowi-cli',
      userId: new ObjectId(),
      scopes: ['pages:read'],
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
      redirectUri: 'http://127.0.0.1:1234/cb',
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60_000),
      consumedAt: overrides.consumedAt ?? null,
    }).then((doc) => ({ code, codeHash, doc }));
  };

  describe('.generateCode / .hashCode', () => {
    it('produces an opaque code and a stable 64-hex hash', () => {
      const { code, codeHash } = OAuthAuthorizationCode.generateCode();
      expect(codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(OAuthAuthorizationCode.hashCode(code)).toBe(codeHash);
      expect(code).not.toBe(codeHash);
    });
  });

  describe('.findUsable', () => {
    it('returns an unconsumed, unexpired code', async () => {
      const { codeHash } = await seed();
      expect(await OAuthAuthorizationCode.findUsable(codeHash)).not.toBeNull();
    });

    it('excludes an expired code', async () => {
      const { codeHash } = await seed({ expiresAt: new Date(Date.now() - 1000) });
      expect(await OAuthAuthorizationCode.findUsable(codeHash)).toBeNull();
    });

    it('excludes a consumed code', async () => {
      const { codeHash } = await seed({ consumedAt: new Date() });
      expect(await OAuthAuthorizationCode.findUsable(codeHash)).toBeNull();
    });
  });

  describe('.consume', () => {
    it('marks the code consumed and returns it once', async () => {
      const { codeHash } = await seed();
      const first = await OAuthAuthorizationCode.consume(codeHash);
      expect(first).not.toBeNull();
      expect(first?.consumedAt).not.toBeNull();
      // A second consume returns null (single-use).
      expect(await OAuthAuthorizationCode.consume(codeHash)).toBeNull();
    });
  });

  it('declares a TTL index on expiresAt', () => {
    const indexes = OAuthAuthorizationCode.schema.indexes();
    const ttl = indexes.find(([, opts]) => (opts as { expireAfterSeconds?: number }).expireAfterSeconds === 0);
    expect(ttl).toBeDefined();
    expect((ttl?.[0] as Record<string, number>).expiresAt).toBe(1);
  });
});
