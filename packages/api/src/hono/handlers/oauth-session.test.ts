import crypto from 'node:crypto';
import type { OAuthRefreshTokenModel } from 'src/models/oauth-refresh-token';
import type { UserDocument } from 'src/models/user';
import { type ConfigRow, restoreCrowiConfig, snapshotCrowiConfig } from 'src/test/config-snapshot';
import { app, crowi } from 'src/test/setup';
import { authHeaders, cookieAuthHeaders, createTestUser } from 'src/test/test-helpers';
import { createJwtUtil } from 'src/util/jwt';
import request from 'supertest';

/**
 * Integration tests for `/me/oauth-sessions` (list active OAuth refresh-token tips + revoke the whole sign-in family).
 *
 * Covers (AC-aligned):
 *  - list metadata, active-tip filtering, clientName resolution + raw-id fallback (AC-2), exact response keys / no secrets (AC-3)
 *  - DELETE revokes the family, subsequent refresh invalid_grant (AC-4), foreign/invalid/unknown/family-less id -> 404 (AC-5)
 *  - auth boundary matrix: web/PAT/OAuth bearer, cookie-only, no credential, registered/suspended/invited user (AC-10)
 *  - DELETE leaves an already-issued access token usable within its TTL (AC-11)
 *  - clientName resolution failure after revoke still returns 200 with a raw clientId, and does not resurrect the family (AC-12)
 *  - old (already-rotated) tip id still reaches the family while its document exists; TTL-deleted before/after the ownership lookup both 404 but a post-lookup deletion still revokes the family (AC-13)
 *  - concurrent refresh on the SAME predecessor forks into 2 active successors; deleting either revokes both (AC-14)
 *  - a single refresh's transient 2-row window converges to 1 row (AC-15)
 *  - a refresh that straddles a DELETE (before the successor insert, before the post-insert check, after it) never leaves a usable token
 *  - failure injection: record save, bulk update, and retry
 */

const seedActiveUser = async (info: { name: string; username: string; email: string; password: string }) => {
  const User = crowi.model('User');
  await User.deleteMany({ $or: [{ email: info.email }, { username: info.username }] });
  return new Promise<{ user: UserDocument; accessToken: string }>((resolve, reject) => {
    User.createUserByEmailAndPassword(info.name, info.username, info.email, info.password, 'en', async (err, user) => {
      if (err) return reject(err);
      user.status = User.STATUS_ACTIVE;
      await user.save();
      const accessToken = createJwtUtil(crowi).generateTokens(user).accessToken;
      resolve({ user, accessToken });
    });
  });
};

const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
};

/** A 2-party rendezvous: `arrive()` resolves for BOTH callers only once BOTH have called it. */
const twoPartyBarrier = () => {
  let releaseFirst: (() => void) | undefined;
  let arrivals = 0;
  const firstArrived = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  return async (): Promise<void> => {
    arrivals += 1;
    if (arrivals === 1) {
      await firstArrived;
    } else {
      releaseFirst?.();
    }
  };
};

describe('Routes /api/me/oauth-sessions (Hono)', () => {
  const Config = () => crowi.model('Config');
  const User = () => crowi.model('User');
  const Refresh = (): OAuthRefreshTokenModel => crowi.model('OAuthRefreshToken');
  const OAuthClient = () => crowi.model('OAuthClient');
  const Code = () => crowi.model('OAuthAuthorizationCode');
  const PAT = () => crowi.model('PersonalAccessToken');

  const EMAIL = 'oauth-session-owner@example.com';
  const REDIRECT = 'http://127.0.0.1:51987/callback';
  let user: UserDocument;
  let webToken: string;
  let configSnapshot: ConfigRow[];

  beforeAll(async () => {
    configSnapshot = await snapshotCrowiConfig(crowi);
    await Config().deleteMany({ ns: 'crowi' });
    await Config().applicationInstall();
    await crowi.getConfigService().load();
    const seeded = await seedActiveUser({ name: 'OAuth Session Owner', username: 'oauth-session-owner', email: EMAIL, password: 'Password!1' });
    user = seeded.user;
    webToken = seeded.accessToken;
  });

  afterAll(async () => {
    await restoreCrowiConfig(crowi, configSnapshot);
    await User().deleteMany({ email: EMAIL });
    await Refresh().deleteMany({ userId: user._id });
    await Code().deleteMany({ userId: user._id });
    await PAT().deleteMany({ userId: user._id });
  });

  beforeEach(async () => {
    await Refresh().deleteMany({ userId: user._id });
    await Code().deleteMany({ userId: user._id });
    await PAT().deleteMany({ userId: user._id });
  });

  const web = (req: request.Test) => req.set('Authorization', `Bearer ${webToken}`);
  const list = () => web(request(app).get('/api/me/oauth-sessions'));
  const del = (id: string) => web(request(app).delete(`/api/me/oauth-sessions/${id}`));

  /** A raw `OAuthRefreshToken` row for tests that seed rows outside the real grant flow (not this user's own chain). */
  const createRow = (
    tokenHash: string,
    overrides: Partial<{ userId: UserDocument['_id']; clientId: string; expiresAt: Date; revokedAt: Date; familyId: string | null }> = {},
  ) =>
    Refresh().create({
      tokenHash: Refresh().hashToken(tokenHash),
      clientId: overrides.clientId ?? 'crowi-cli',
      userId: overrides.userId ?? user._id,
      scopes: ['pages:read'],
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 86_400_000),
      ...(overrides.revokedAt !== undefined ? { revokedAt: overrides.revokedAt } : {}),
      ...(overrides.familyId === null ? {} : { familyId: overrides.familyId ?? crypto.randomUUID() }),
    });

  const authorize = async (scope = 'pages:read pages:write') => {
    const { verifier, challenge } = pkce();
    const res = await web(request(app).post('/api/oauth/authorize')).send({
      client_id: 'crowi-cli',
      redirect_uri: REDIRECT,
      scope,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
    });
    expect(res.status).toBe(200);
    const code = new URL(res.body.redirectUri).searchParams.get('code') as string;
    return { code, verifier };
  };

  const tokenRequest = (body: Record<string, unknown>) => request(app).post('/api/oauth/token').send(body);

  /** Full authorization_code exchange -> the chain's origin access+refresh pair. */
  const getInitialPair = async () => {
    const { code, verifier } = await authorize();
    const res = await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: 'crowi-cli' });
    expect(res.status).toBe(200);
    return res.body as { access_token: string; refresh_token: string };
  };

  describe('GET /me/oauth-sessions', () => {
    it('lists metadata for the active tip only, excluding revoked/expired/non-tip/other-user rows (AC-2)', async () => {
      const pair = await getInitialPair();

      // Someone else's active tip must never appear.
      const other = await createTestUser({ name: 'OAuth Session Other', username: 'oauth-session-other', email: 'oauth-session-other@example.com' });
      await createRow('crowi_rt_other', { userId: other.user._id });

      // A revoked row and an expired row for the SAME user must be excluded too.
      await createRow('crowi_rt_revoked', { revokedAt: new Date() });
      await createRow('crowi_rt_expired', { expiresAt: new Date(Date.now() - 1000) });

      const res = await list();
      expect(res.status).toBe(200);
      expect(res.body.oauthSessions).toHaveLength(1);
      const row = res.body.oauthSessions[0];
      expect(row.clientId).toBe('crowi-cli');
      expect(row.clientName).toBe('Crowi CLI');
      expect(row.scopes).toEqual(['pages:read', 'pages:write']);
      expect(row.authorizedAt).toEqual(expect.any(String));
      expect(row.lastRefreshedAt).toEqual(expect.any(String));
      expect(row.expiresAt).toEqual(expect.any(String));

      // Own-chain-origin sanity: the tip id belongs to THIS refresh_token.
      const originHash = Refresh().hashToken(pair.refresh_token);
      const origin = await Refresh().findOne({ tokenHash: originHash });
      expect(row.id).toBe(origin?._id.toString());

      await Refresh().deleteMany({ userId: other.user._id });
    });

    it('returns lastRefreshedAt-descending order for multiple distinct chains', async () => {
      const older = await getInitialPair();
      await new Promise((resolve) => setTimeout(resolve, 5));
      const newer = await getInitialPair();
      void older;

      const res = await list();
      expect(res.status).toBe(200);
      expect(res.body.oauthSessions).toHaveLength(2);
      const times = res.body.oauthSessions.map((row: { lastRefreshedAt: string }) => new Date(row.lastRefreshedAt).getTime());
      expect(times[0]).toBeGreaterThanOrEqual(times[1]);
      void newer;
    });

    it('falls back to the raw clientId when the client is unregistered (AC-2)', async () => {
      await createRow('crowi_rt_unregistered', { clientId: 'not-a-registered-client' });

      const res = await list();
      expect(res.status).toBe(200);
      const row = res.body.oauthSessions.find((r: { clientId: string }) => r.clientId === 'not-a-registered-client');
      expect(row.clientName).toBe('not-a-registered-client');
    });

    it('falls back to the raw clientId (never a 500) when the client display-name query itself fails (AC-2)', async () => {
      await getInitialPair();
      const spy = jest.spyOn(OAuthClient(), 'find').mockImplementation(() => {
        throw new Error('injected client lookup failure');
      });
      try {
        const res = await list();
        expect(res.status).toBe(200);
        expect(res.body.oauthSessions).toHaveLength(1);
        expect(res.body.oauthSessions[0].clientName).toBe('crowi-cli');
      } finally {
        spy.mockRestore();
      }
    });

    it('returns an empty list without querying OAuthClient when there are no active tips', async () => {
      const spy = jest.spyOn(OAuthClient(), 'find');
      try {
        const res = await list();
        expect(res.status).toBe(200);
        expect(res.body.oauthSessions).toEqual([]);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it('the fetched row carries EXACTLY the 7 public metadata fields — no tokenHash / secrets (AC-3)', async () => {
      await getInitialPair();
      const res = await list();
      expect(res.status).toBe(200);
      const row = res.body.oauthSessions[0];
      expect(Object.keys(row).sort()).toEqual(['authorizedAt', 'clientId', 'clientName', 'expiresAt', 'id', 'lastRefreshedAt', 'scopes'].sort());
      expect(row).not.toHaveProperty('tokenHash');
      expect(row).not.toHaveProperty('token');
      expect(row).not.toHaveProperty('sessionId');
    });
  });

  describe('DELETE /me/oauth-sessions/:id', () => {
    it('revokes the family; a subsequent refresh of that token is invalid_grant (AC-4)', async () => {
      const pair = await getInitialPair();
      const res = await list();
      const id = res.body.oauthSessions[0].id as string;

      const delRes = await del(id);
      expect(delRes.status).toBe(200);
      expect(delRes.body.id).toBe(id);
      expect(Object.keys(delRes.body).sort()).toEqual(['authorizedAt', 'clientId', 'clientName', 'expiresAt', 'id', 'lastRefreshedAt', 'scopes'].sort());

      const refreshAttempt = await tokenRequest({ grant_type: 'refresh_token', refresh_token: pair.refresh_token, client_id: 'crowi-cli' });
      expect(refreshAttempt.status).toBe(400);
      expect(refreshAttempt.body.error).toBe('invalid_grant');
    });

    it('leaves an already-issued access token usable within its TTL after DELETE (AC-11)', async () => {
      const { code, verifier } = await authorize('profile:read');
      const pairRes = await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: 'crowi-cli' });
      expect(pairRes.status).toBe(200);
      const pair = pairRes.body as { access_token: string; refresh_token: string };

      const res = await list();
      expect(res.body.oauthSessions).toHaveLength(1);
      const id = res.body.oauthSessions[0].id as string;

      const delRes = await del(id);
      expect(delRes.status).toBe(200);

      const apiRes = await request(app).get('/api/me/recently-viewed-pages').set('Authorization', `Bearer ${pair.access_token}`);
      expect(apiRes.status).toBe(200);
    });

    it('resolves clientName after revocation, falling back to raw clientId on a display-name query failure without reviving the chain (AC-12)', async () => {
      const pair = await getInitialPair();
      const res = await list();
      const id = res.body.oauthSessions[0].id as string;

      const spy = jest.spyOn(OAuthClient(), 'find').mockImplementation(() => {
        throw new Error('injected client lookup failure');
      });
      try {
        const delRes = await del(id);
        expect(delRes.status).toBe(200);
        expect(delRes.body.clientName).toBe('crowi-cli');
      } finally {
        spy.mockRestore();
      }

      const refreshAttempt = await tokenRequest({ grant_type: 'refresh_token', refresh_token: pair.refresh_token, client_id: 'crowi-cli' });
      expect(refreshAttempt.status).toBe(400);
      expect(refreshAttempt.body.error).toBe('invalid_grant');
    });

    it('a foreign, malformed, or unknown id all 404 identically without touching any chain (AC-5)', async () => {
      const pair = await getInitialPair();
      const other = await createTestUser({ name: 'OAuth Session Foreign', username: 'oauth-session-foreign', email: 'oauth-session-foreign@example.com' });
      const otherTip = await createRow('crowi_rt_foreign_owner', { userId: other.user._id });

      const foreign = await del(otherTip._id.toString());
      expect(foreign.status).toBe(404);
      expect(foreign.body.error.code).toBe('NOT_FOUND');

      const malformed = await del('not-an-object-id');
      expect(malformed.status).toBe(404);
      expect(malformed.body.error.code).toBe('NOT_FOUND');

      const unknown = await del('507f1f77bcf86cd799439011');
      expect(unknown.status).toBe(404);

      // Foreign chain must still be revocable by ITS owner — proves DELETE never touched it.
      const stillForeignActive = await Refresh().findOne({ _id: otherTip._id });
      expect(stillForeignActive?.revokedAt).toBeNull();

      // Own chain unaffected.
      const refreshStillWorks = await tokenRequest({ grant_type: 'refresh_token', refresh_token: pair.refresh_token, client_id: 'crowi-cli' });
      expect(refreshStillWorks.status).toBe(200);

      await Refresh().deleteMany({ userId: other.user._id });
    });

    it('an old (already-rotated) tip id still reaches the current active successor while its document exists (AC-13)', async () => {
      const pair = await getInitialPair();
      const originHash = Refresh().hashToken(pair.refresh_token);
      const origin = await Refresh().findOne({ tokenHash: originHash });

      const rotated = await tokenRequest({ grant_type: 'refresh_token', refresh_token: pair.refresh_token, client_id: 'crowi-cli' });
      expect(rotated.status).toBe(200);
      const successorHash = Refresh().hashToken(rotated.body.refresh_token as string);

      // Delete via the OLD (pre-rotation) tip id — its document still exists.
      const delRes = await del((origin?._id as unknown as { toString(): string }).toString());
      expect(delRes.status).toBe(200);

      const successor = await Refresh().findOne({ tokenHash: successorHash });
      expect(successor?.revokedAt).not.toBeNull();
    });

    it('404s without side effects when the addressed tip was TTL-deleted BEFORE the ownership lookup (AC-13)', async () => {
      const pair = await getInitialPair();
      const originHash = Refresh().hashToken(pair.refresh_token);
      const origin = await Refresh().findOne({ tokenHash: originHash });
      const id = (origin?._id as unknown as { toString(): string }).toString();

      await Refresh().deleteOne({ tokenHash: originHash });

      const delRes = await del(id);
      expect(delRes.status).toBe(404);

      // Nothing to revoke — the token was already gone before the attempt.
      const stillGone = await Refresh().findOne({ tokenHash: originHash });
      expect(stillGone).toBeNull();
    });

    it('404s (never 200) when the addressed tip is TTL-deleted between the ownership lookup and the post-check, but the family is still revoked (AC-13)', async () => {
      const pair = await getInitialPair();
      const originHash = Refresh().hashToken(pair.refresh_token);
      const origin = await Refresh().findOne({ tokenHash: originHash });
      const id = (origin?._id as unknown as { toString(): string }).toString();

      const rotated = await tokenRequest({ grant_type: 'refresh_token', refresh_token: pair.refresh_token, client_id: 'crowi-cli' });
      expect(rotated.status).toBe(200);
      const successorHash = Refresh().hashToken(rotated.body.refresh_token as string);

      const originalRevokeFamily = Refresh().revokeFamily.bind(Refresh());
      const spy = jest.spyOn(Refresh(), 'revokeFamily').mockImplementation(async (familyId, userId) => {
        await Refresh().deleteOne({ tokenHash: originHash });
        return originalRevokeFamily(familyId, userId);
      });

      try {
        const delRes = await del(id);
        expect(delRes.status).toBe(404);
        expect(delRes.body.error.code).toBe('NOT_FOUND');
      } finally {
        spy.mockRestore();
      }

      const successor = await Refresh().findOne({ tokenHash: successorHash });
      expect(successor?.revokedAt).not.toBeNull();
    });

    it('404s a family-less (pre-migration) id without side effects', async () => {
      const legacy = await createRow('crowi_rt_legacy_session', { familyId: null });
      const res = await del(legacy._id.toString());
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect((await Refresh().findById(legacy._id))?.revokedAt).toBeNull();
    });

    it('a concurrent refresh fork produces 2 unlinked active successors; deleting one revokes both (AC-14)', async () => {
      const pair = await getInitialPair();

      const arrive = twoPartyBarrier();
      const originalFindActiveByHash = Refresh().findActiveByHash.bind(Refresh());
      const spy = jest.spyOn(Refresh(), 'findActiveByHash').mockImplementation(async (hash: string) => {
        const result = await originalFindActiveByHash(hash);
        // Both concurrent refreshes must have read the SAME active
        // predecessor before either proceeds to mint + save its successor.
        await arrive();
        return result;
      });

      let refreshA: request.Response;
      let refreshB: request.Response;
      try {
        [refreshA, refreshB] = await Promise.all([
          tokenRequest({ grant_type: 'refresh_token', refresh_token: pair.refresh_token, client_id: 'crowi-cli' }),
          tokenRequest({ grant_type: 'refresh_token', refresh_token: pair.refresh_token, client_id: 'crowi-cli' }),
        ]);
      } finally {
        spy.mockRestore();
      }

      expect(refreshA.status).toBe(200);
      expect(refreshB.status).toBe(200);
      expect(refreshA.body.refresh_token).not.toBe(refreshB.body.refresh_token);

      const res = await list();
      expect(res.status).toBe(200);
      expect(res.body.oauthSessions).toHaveLength(2);

      const idToDelete = res.body.oauthSessions[0].id as string;
      const otherId = res.body.oauthSessions[1].id as string;

      const delRes = await del(idToDelete);
      expect(delRes.status).toBe(200);

      expect((await Refresh().findById(otherId))?.revokedAt).not.toBeNull();
      for (const r of [refreshA, refreshB]) {
        const reuse = await tokenRequest({ grant_type: 'refresh_token', refresh_token: r.body.refresh_token, client_id: 'crowi-cli' });
        expect(reuse.status).toBe(400);
        expect(reuse.body.error).toBe('invalid_grant');
      }
    });

    describe('a refresh that straddles a DELETE', () => {
      /** Resolves the returned gate's `reached` once the hook fires; the hook then parks until `release()`. */
      const gate = () => {
        let markReached: (() => void) | undefined;
        let release: (() => void) | undefined;
        const reached = new Promise<void>((resolve) => {
          markReached = resolve;
        });
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          reached,
          release: () => release?.(),
          park: async () => {
            markReached?.();
            await released;
          },
        };
      };

      /** Record every {token, tokenHash} pair `generateToken` hands out, so a test can present the plaintext. */
      const captureTokens = () => {
        const original = Refresh().generateToken.bind(Refresh());
        const minted: { token: string; tokenHash: string }[] = [];
        const spy = jest.spyOn(Refresh(), 'generateToken').mockImplementation(() => {
          const pair = original();
          minted.push(pair);
          return pair;
        });
        return { minted, spy };
      };

      const expectTokenDead = async (token: string) => {
        const res = await tokenRequest({ grant_type: 'refresh_token', refresh_token: token, client_id: 'crowi-cli' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_grant');
      };

      it('DELETE between the predecessor read and the successor insert: the successor is revoked and no pair is returned', async () => {
        const pair = await getInitialPair();
        const origin = await Refresh().findOne({ tokenHash: Refresh().hashToken(pair.refresh_token) });
        const g = gate();
        const { minted, spy: genSpy } = captureTokens();
        const original = Refresh().findActiveByHash.bind(Refresh());
        let first = true;
        const findSpy = jest.spyOn(Refresh(), 'findActiveByHash').mockImplementation(async (hash: string) => {
          const result = await original(hash);
          if (first) {
            first = false;
            await g.park();
          }
          return result;
        });

        let refreshRes: request.Response;
        try {
          const refreshPromise = Promise.resolve(tokenRequest({ grant_type: 'refresh_token', refresh_token: pair.refresh_token, client_id: 'crowi-cli' }));
          await g.reached;
          expect(minted).toHaveLength(0);
          const delRes = await del((origin?._id as unknown as { toString(): string }).toString());
          expect(delRes.status).toBe(200);
          expect(minted).toHaveLength(0);
          g.release();
          refreshRes = await refreshPromise;
        } finally {
          g.release();
          findSpy.mockRestore();
          genSpy.mockRestore();
        }

        expect(refreshRes.status).toBe(400);
        expect(refreshRes.body.error).toBe('invalid_grant');
        expect(refreshRes.body.refresh_token).toBeUndefined();
        expect(refreshRes.body.access_token).toBeUndefined();
        expect(minted).toHaveLength(1);
        const successor = await Refresh().findOne({ tokenHash: minted[0].tokenHash });
        expect(successor?.revokedAt).not.toBeNull();
        await expectTokenDead(minted[0].token);
      });

      it('DELETE after the successor insert but before the post-insert record check: the successor is revoked', async () => {
        const pair = await getInitialPair();
        const origin = await Refresh().findOne({ tokenHash: Refresh().hashToken(pair.refresh_token) });
        const Rev = crowi.model('OAuthTokenFamilyRevocation');
        const g = gate();
        const { minted, spy: genSpy } = captureTokens();
        const original = Rev.isRevoked.bind(Rev);
        let calls = 0;
        const revSpy = jest.spyOn(Rev, 'isRevoked').mockImplementation(async (familyId, userId) => {
          calls += 1;
          // 1st call = refresh entry guard, 2nd = the post-insert check.
          if (calls === 2) await g.park();
          return original(familyId, userId);
        });

        let refreshRes: request.Response;
        try {
          const refreshPromise = Promise.resolve(tokenRequest({ grant_type: 'refresh_token', refresh_token: pair.refresh_token, client_id: 'crowi-cli' }));
          await g.reached;
          expect(minted).toHaveLength(1);
          expect(await Refresh().exists({ tokenHash: minted[0].tokenHash })).not.toBeNull();
          const delRes = await del((origin?._id as unknown as { toString(): string }).toString());
          expect(delRes.status).toBe(200);
          g.release();
          refreshRes = await refreshPromise;
        } finally {
          g.release();
          revSpy.mockRestore();
          genSpy.mockRestore();
        }

        expect(refreshRes.status).toBe(400);
        expect(refreshRes.body.error).toBe('invalid_grant');
        expect(refreshRes.body.refresh_token).toBeUndefined();
        expect((await Refresh().findOne({ tokenHash: minted[0].tokenHash }))?.revokedAt).not.toBeNull();
        await expectTokenDead(minted[0].token);
      });

      it('DELETE after the post-insert check passed: the bulk update revokes the successor even though its response is 200', async () => {
        const pair = await getInitialPair();
        const origin = await Refresh().findOne({ tokenHash: Refresh().hashToken(pair.refresh_token) });
        const Rev = crowi.model('OAuthTokenFamilyRevocation');
        const g = gate();
        const original = Rev.isRevoked.bind(Rev);
        let calls = 0;
        const revSpy = jest.spyOn(Rev, 'isRevoked').mockImplementation(async (familyId, userId) => {
          calls += 1;
          const result = await original(familyId, userId);
          if (calls === 2) await g.park();
          return result;
        });

        let refreshRes: request.Response;
        try {
          const refreshPromise = Promise.resolve(tokenRequest({ grant_type: 'refresh_token', refresh_token: pair.refresh_token, client_id: 'crowi-cli' }));
          await g.reached;
          const delRes = await del((origin?._id as unknown as { toString(): string }).toString());
          expect(delRes.status).toBe(200);
          g.release();
          refreshRes = await refreshPromise;
        } finally {
          g.release();
          revSpy.mockRestore();
        }

        expect(refreshRes.status).toBe(200);
        await expectTokenDead(refreshRes.body.refresh_token as string);
      });
    });

    describe('failure injection', () => {
      it('a failed record save returns 500 and never runs the bulk update', async () => {
        const pair = await getInitialPair();
        const res = await list();
        const id = res.body.oauthSessions[0].id as string;
        const Rev = crowi.model('OAuthTokenFamilyRevocation');
        const markSpy = jest.spyOn(Rev, 'markRevoked').mockRejectedValue(new Error('injected'));
        const bulkSpy = jest.spyOn(Refresh(), 'updateMany');
        try {
          const delRes = await del(id);
          expect(delRes.status).toBe(500);
          expect(bulkSpy).not.toHaveBeenCalled();
        } finally {
          markSpy.mockRestore();
          bulkSpy.mockRestore();
        }
        const stillOk = await tokenRequest({ grant_type: 'refresh_token', refresh_token: pair.refresh_token, client_id: 'crowi-cli' });
        expect(stillOk.status).toBe(200);
      });

      it('a failed bulk update returns 500, keeps the record so the family is unusable, and a retry succeeds', async () => {
        const pair = await getInitialPair();
        const res = await list();
        const id = res.body.oauthSessions[0].id as string;
        const bulkSpy = jest.spyOn(Refresh(), 'updateMany').mockRejectedValueOnce(new Error('injected') as never);
        try {
          const delRes = await del(id);
          expect(delRes.status).toBe(500);
        } finally {
          bulkSpy.mockRestore();
        }

        const row = await Refresh().findById(id);
        expect(row?.revokedAt).toBeNull();
        expect(await crowi.model('OAuthTokenFamilyRevocation').isRevoked(row?.familyId as string, user._id)).toBe(true);
        const blocked = await tokenRequest({ grant_type: 'refresh_token', refresh_token: pair.refresh_token, client_id: 'crowi-cli' });
        expect(blocked.status).toBe(400);
        expect(blocked.body.error).toBe('invalid_grant');

        const retry = await del(id);
        expect(retry.status).toBe(200);
        expect((await Refresh().findById(id))?.revokedAt).not.toBeNull();
      });
    });

    it('the transient 2-row window of a single ordinary rotation converges to 1 row, and is NOT the AC-14 fork (AC-15)', async () => {
      const pair = await getInitialPair();

      let markCreateReached: (() => void) | undefined;
      const createReached = new Promise<void>((resolve) => {
        markCreateReached = resolve;
      });
      let releaseCreate: (() => void) | undefined;
      const releaseGate = new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });

      const originalCreate = Refresh().create.bind(Refresh());
      const spy = jest.spyOn(Refresh(), 'create').mockImplementation(async (...args: Parameters<typeof originalCreate>) => {
        // biome-ignore lint/suspicious/noExplicitAny: mirrors Mongoose's own overloaded create() signature
        const created = await (originalCreate as any)(...args);
        markCreateReached?.();
        await releaseGate;
        return created;
      });

      // `Promise.resolve(...)` (not a bare variable assignment) is required
      // here: supertest/superagent's request is a thenable that dispatches
      // the actual HTTP call lazily, only on its first `.then()` — wrapping
      // it forces that dispatch NOW rather than only once `refreshPromise`
      // is finally awaited below, which would deadlock against `createReached`.
      const refreshPromise = Promise.resolve(tokenRequest({ grant_type: 'refresh_token', refresh_token: pair.refresh_token, client_id: 'crowi-cli' }));

      try {
        // Parked exactly between "successor committed" and "predecessor
        // revoked/saved" — both rows are still active tips.
        await createReached;
        const midFlight = await list();
        expect(midFlight.status).toBe(200);
        expect(midFlight.body.oauthSessions).toHaveLength(2);
      } finally {
        releaseCreate?.();
        spy.mockRestore();
      }

      const rotated = await refreshPromise;
      expect(rotated.status).toBe(200);

      const converged = await list();
      expect(converged.status).toBe(200);
      expect(converged.body.oauthSessions).toHaveLength(1);
      expect(converged.body.oauthSessions[0].clientId).toBe('crowi-cli');
    });
  });

  describe('auth boundary (AC-10)', () => {
    it('401s with no credential', async () => {
      const res = await request(app).get('/api/me/oauth-sessions');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('401s a cookie-only credential (this boundary is header-only)', async () => {
      const res = await request(app).get('/api/me/oauth-sessions').set(cookieAuthHeaders(webToken));
      expect(res.status).toBe(401);
    });

    it('403 FORBIDDEN for an active-user PAT bearer on both GET and DELETE', async () => {
      const { token } = PAT().generateToken();
      await PAT().create({ tokenHash: PAT().hashToken(token), userId: user._id, name: 'oauth-session-boundary-pat', scopes: ['profile:read'] });

      const getRes = await request(app).get('/api/me/oauth-sessions').set(authHeaders(token));
      expect(getRes.status).toBe(403);
      expect(getRes.body.error.code).toBe('FORBIDDEN');

      const delRes = await request(app).delete('/api/me/oauth-sessions/507f1f77bcf86cd799439011').set(authHeaders(token));
      expect(delRes.status).toBe(403);
      expect(delRes.body.error.code).toBe('FORBIDDEN');
    });

    it('403 FORBIDDEN for an active-user OAuth bearer', async () => {
      const oauthToken = createJwtUtil(crowi).signOauthAccessToken({ user, scopes: ['pages:read'], clientId: 'crowi-cli' });
      const res = await request(app).get('/api/me/oauth-sessions').set(authHeaders(oauthToken));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it.each([
      ['registered', 'STATUS_REGISTERED' as const, 'USER_REGISTERED'],
      ['suspended', 'STATUS_SUSPENDED' as const, 'USER_SUSPENDED'],
      ['invited', 'STATUS_INVITED' as const, 'USER_INVITED'],
    ])('403 %s for a valid-credential user whose status is %s', async (label, statusConst, expectedCode) => {
      const inactive = await createTestUser({ name: `OAuth Session ${label}`, username: `oauthSession${label}`, email: `oauth-session-${label}@example.com` });
      inactive.user.status = User()[statusConst];
      await inactive.user.save();

      const res = await request(app).get('/api/me/oauth-sessions').set(authHeaders(inactive.accessToken));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(expectedCode);
    });
  });
});
