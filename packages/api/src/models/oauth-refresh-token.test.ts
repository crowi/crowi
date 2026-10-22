import crypto from 'node:crypto';

import mongoose from 'mongoose';

import { crowi } from 'src/test/setup';
import type { OAuthRefreshTokenModel } from 'src/models/oauth-refresh-token';

/**
 * RFC-0010 Phase 3 — OAuthRefreshToken unit tests (active lookup, family
 * revocation, family-less rejection, list index, TTL).
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
      familyId: string;
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
      familyId: overrides.familyId ?? crypto.randomUUID(),
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

  describe('familyId field', () => {
    it('has no schema default — a legacy row stays family-less when read', async () => {
      const { token, tokenHash } = OAuthRefreshToken.generateToken();
      void token;
      await OAuthRefreshToken.collection.insertOne({
        tokenHash,
        clientId: 'crowi-cli',
        userId: new ObjectId(),
        scopes: [],
        expiresAt: new Date(Date.now() + 86_400_000),
        revokedAt: null,
        rotatedTo: null,
        createdAt: new Date(),
      });
      const row = await OAuthRefreshToken.findOne({ tokenHash });
      expect(row?.familyId).toBeUndefined();
      // Loading it twice must not mint a different family each time.
      expect((await OAuthRefreshToken.findOne({ tokenHash }))?.familyId).toBeUndefined();
    });
  });

  describe('.findActiveByHash family guards', () => {
    const rawLegacy = async (familyId: unknown) => {
      const { tokenHash } = OAuthRefreshToken.generateToken();
      await OAuthRefreshToken.collection.insertOne({
        tokenHash,
        clientId: 'crowi-cli',
        userId: new ObjectId(),
        scopes: [],
        expiresAt: new Date(Date.now() + 86_400_000),
        revokedAt: null,
        rotatedTo: null,
        createdAt: new Date(),
        ...(familyId === undefined ? {} : { familyId }),
      });
      return tokenHash;
    };

    it.each([
      ['missing', undefined],
      ['null', null],
      ['empty string', ''],
    ])('revokes and rejects a %s-family row without inventing a family', async (_label, familyId) => {
      const tokenHash = await rawLegacy(familyId);
      expect(await OAuthRefreshToken.findActiveByHash(tokenHash)).toBeNull();
      const after = await OAuthRefreshToken.collection.findOne({ tokenHash });
      expect(after?.revokedAt).toBeInstanceOf(Date);
      expect(after?.familyId ?? null).toBe(familyId === undefined ? null : familyId);
    });

    it('does not return an unrevoked row whose family has a revocation record', async () => {
      const row = await create();
      await crowi.model('OAuthTokenFamilyRevocation').markRevoked(row.doc.familyId as string, row.doc.userId, new Date());
      expect(await OAuthRefreshToken.findActiveByHash(row.tokenHash)).toBeNull();
    });
  });

  describe('.revokeFamily', () => {
    it('revokes every row of the family, including rows with no rotatedTo link between them', async () => {
      const userId = new ObjectId();
      const familyId = crypto.randomUUID();
      const linked = await create({ userId, familyId, rotatedTo: 'x', revokedAt: new Date(Date.now() - 5000) });
      const forkA = await create({ userId, familyId });
      const forkB = await create({ userId, familyId });

      await OAuthRefreshToken.revokeFamily(familyId, userId);

      const rev = async (hash: string) => (await OAuthRefreshToken.findOne({ tokenHash: hash }))?.revokedAt;
      expect(await rev(forkA.tokenHash)).toBeInstanceOf(Date);
      expect(await rev(forkB.tokenHash)).toBeInstanceOf(Date);
      // An earlier revokedAt is never rewritten.
      expect((await rev(linked.tokenHash))?.getTime()).toBe(linked.doc.revokedAt?.getTime());
    });

    it('does not touch another user or another family, even with the same family string', async () => {
      const userId = new ObjectId();
      const otherUser = new ObjectId();
      const familyId = crypto.randomUUID();
      const mine = await create({ userId, familyId });
      const theirs = await create({ userId: otherUser, familyId });
      const otherFamily = await create({ userId });

      await OAuthRefreshToken.revokeFamily(familyId, userId);

      expect((await OAuthRefreshToken.findOne({ tokenHash: mine.tokenHash }))?.revokedAt).not.toBeNull();
      expect((await OAuthRefreshToken.findOne({ tokenHash: theirs.tokenHash }))?.revokedAt).toBeNull();
      expect((await OAuthRefreshToken.findOne({ tokenHash: otherFamily.tokenHash }))?.revokedAt).toBeNull();
      const Rev = crowi.model('OAuthTokenFamilyRevocation');
      expect(await Rev.isRevoked(familyId, userId)).toBe(true);
      expect(await Rev.isRevoked(familyId, otherUser)).toBe(false);
    });

    it('persists the record before the bulk update, and succeeds with zero rows', async () => {
      const Rev = crowi.model('OAuthTokenFamilyRevocation');
      const order: string[] = [];
      const markSpy = jest.spyOn(Rev, 'markRevoked').mockImplementation(async () => {
        order.push('record');
      });
      const updateSpy = jest.spyOn(OAuthRefreshToken, 'updateMany').mockImplementation((() => {
        order.push('bulk');
        return Promise.resolve({ modifiedCount: 0 });
      }) as never);
      try {
        await OAuthRefreshToken.revokeFamily(crypto.randomUUID(), new ObjectId());
      } finally {
        markSpy.mockRestore();
        updateSpy.mockRestore();
      }
      expect(order).toEqual(['record', 'bulk']);

      const familyId = crypto.randomUUID();
      const userId = new ObjectId();
      await OAuthRefreshToken.revokeFamily(familyId, userId);
      expect(await Rev.isRevoked(familyId, userId)).toBe(true);
    });

    it('rejects an empty family id', async () => {
      await expect(OAuthRefreshToken.revokeFamily('', new ObjectId())).rejects.toThrow();
    });

    it('keeps the record when the bulk update fails, and a retry completes', async () => {
      const userId = new ObjectId();
      const familyId = crypto.randomUUID();
      const row = await create({ userId, familyId });
      const spy = jest.spyOn(OAuthRefreshToken, 'updateMany').mockRejectedValueOnce(new Error('injected') as never);
      try {
        await expect(OAuthRefreshToken.revokeFamily(familyId, userId)).rejects.toThrow('injected');
      } finally {
        spy.mockRestore();
      }
      expect(await crowi.model('OAuthTokenFamilyRevocation').isRevoked(familyId, userId)).toBe(true);
      // Still unrevoked as a row, but findActiveByHash refuses it via the record.
      expect(await OAuthRefreshToken.findActiveByHash(row.tokenHash)).toBeNull();
      await OAuthRefreshToken.revokeFamily(familyId, userId);
      expect((await OAuthRefreshToken.findOne({ tokenHash: row.tokenHash }))?.revokedAt).not.toBeNull();
    });
  });

  it('does not expose revokeChain any more', () => {
    expect((OAuthRefreshToken as unknown as Record<string, unknown>).revokeChain).toBeUndefined();
  });

  it('does not index rotatedTo', () => {
    const keys = OAuthRefreshToken.schema.indexes().map(([fields]) => Object.keys(fields as object));
    expect(keys.flat()).not.toContain('rotatedTo');
  });

  it('declares a TTL index on expiresAt', () => {
    const indexes = OAuthRefreshToken.schema.indexes();
    const ttl = indexes.find(([, opts]) => (opts as { expireAfterSeconds?: number }).expireAfterSeconds === 0);
    expect(ttl).toBeDefined();
  });

  it('declares the family and list indexes under their fixed names', () => {
    const indexes = OAuthRefreshToken.schema.indexes();
    const named = (name: string) => indexes.find(([, opts]) => (opts as { name?: string }).name === name)?.[0];
    expect(named('oauthRefreshToken_family_user')).toEqual({ familyId: 1, userId: 1 });
    expect(named('oauthRefreshToken_user_active_created')).toEqual({ userId: 1, revokedAt: 1, createdAt: -1 });
    const opts = indexes.find(([, o]) => (o as { name?: string }).name === 'oauthRefreshToken_user_active_created')?.[1] as Record<string, unknown>;
    expect(opts.partialFilterExpression).toBeUndefined();
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

    describe('index use (explain)', () => {
      const FUTURE = () => new Date(Date.now() + 30 * 86_400_000);

      const seed = async (userId: InstanceType<typeof ObjectId>, otherUserId: InstanceType<typeof ObjectId>, revokedCount: number, withTips: boolean) => {
        await OAuthRefreshToken.syncIndexes();
        const base = {
          clientId: 'crowi-cli',
          scopes: ['pages:read'],
          expiresAt: FUTURE(),
          rotatedTo: null,
        };
        const hist = (u: InstanceType<typeof ObjectId>, i: number) => ({
          ...base,
          tokenHash: `hist-${u.toHexString()}-${i}-${Math.random()}`,
          userId: u,
          familyId: crypto.randomUUID(),
          revokedAt: new Date(),
          rotatedTo: 'next',
          createdAt: new Date(Date.now() - i * 1000),
        });
        await OAuthRefreshToken.collection.insertMany([
          ...Array.from({ length: revokedCount }, (_, i) => hist(userId, i + 10)),
          ...Array.from({ length: revokedCount }, (_, i) => hist(otherUserId, i + 10)),
          ...(withTips ? [0, 1, 2] : []).map((i) => ({
            ...base,
            tokenHash: `tip-${userId.toHexString()}-${i}`,
            userId,
            familyId: crypto.randomUUID(),
            revokedAt: null,
            createdAt: new Date(Date.now() - i * 1000),
          })),
        ]);
      };

      const explainStats = async (userId: InstanceType<typeof ObjectId>) => {
        const plan = (await OAuthRefreshToken.find({ userId, revokedAt: null, rotatedTo: null, expiresAt: { $gt: new Date() } })
          .sort({ createdAt: -1 })
          .hint('oauthRefreshToken_user_active_created')
          .explain('executionStats')) as unknown as {
          executionStats: { nReturned: number; totalDocsExamined: number; totalKeysExamined: number };
          queryPlanner: { winningPlan: unknown };
        };
        return { stats: plan.executionStats, winning: JSON.stringify(plan.queryPlanner.winningPlan) };
      };

      it('scans only the tip range of the user/revokedAt index, independent of revoked history size', async () => {
        const userId = new ObjectId();
        const otherUserId = new ObjectId();
        await seed(userId, otherUserId, 2000, true);

        const first = await explainStats(userId);
        expect(first.winning).toContain('oauthRefreshToken_user_active_created');
        expect(first.winning).toContain('IXSCAN');
        expect(first.winning).not.toContain('COLLSCAN');
        expect(first.winning).not.toContain('"stage":"SORT"');
        expect(first.stats.nReturned).toBe(3);
        expect(first.stats.totalDocsExamined).toBeLessThanOrEqual(6);
        expect(first.stats.totalKeysExamined).toBeLessThanOrEqual(10);

        await seed(userId, otherUserId, 2000, false);
        const second = await explainStats(userId);
        expect(second.stats.totalDocsExamined).toBeLessThanOrEqual(12);
        expect(second.stats.totalKeysExamined).toBeLessThanOrEqual(16);
      });
    });
  });
});
