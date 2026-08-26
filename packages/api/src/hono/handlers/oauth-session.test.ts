import crypto from 'node:crypto';
import type { OAuthRefreshTokenModel } from 'src/models/oauth-refresh-token';
import type { UserDocument } from 'src/models/user';
import { type ConfigRow, restoreCrowiConfig, snapshotCrowiConfig } from 'src/test/config-snapshot';
import { app, crowi } from 'src/test/setup';
import { authHeaders, cookieAuthHeaders, createTestUser } from 'src/test/test-helpers';
import { createJwtUtil } from 'src/util/jwt';
import request from 'supertest';

/**
 * Integration tests for `/me/oauth-sessions` (list active OAuth refresh-token rotation-chain tips + revoke a reachable component).
 *
 * Covers (AC-aligned):
 *  - list metadata, active-tip filtering, clientName resolution + raw-id fallback (AC-2), exact response keys / no secrets (AC-3)
 *  - DELETE revokes the reachable component, subsequent refresh invalid_grant (AC-4), foreign/invalid/unknown id -> 404 (AC-5)
 *  - auth boundary matrix: web/PAT/OAuth bearer, cookie-only, no credential, registered/suspended/invited user (AC-10)
 *  - DELETE leaves an already-issued access token usable within its TTL (AC-11)
 *  - clientName resolution failure after revoke still returns 200 with a raw clientId, and does not resurrect the chain (AC-12)
 *  - old (already-rotated) tip id still reaches the chain while its document exists; TTL-deleted before/after the ownership lookup both 404, and a post-ownership-check deletion mid-`revokeChain` leaves the successor active (AC-13)
 *  - concurrent refresh on the SAME predecessor forks into 2 active successors; deleting one never revokes the other (AC-14)
 *  - a single refresh's transient 2-row window (successor committed, predecessor not yet saved) converges to 1 row after completion, and must not be conflated with the AC-14 fork (AC-15)
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
  const createRow = (tokenHash: string, overrides: Partial<{ userId: UserDocument['_id']; clientId: string; expiresAt: Date; revokedAt: Date }> = {}) =>
    Refresh().create({
      tokenHash: Refresh().hashToken(tokenHash),
      clientId: overrides.clientId ?? 'crowi-cli',
      userId: overrides.userId ?? user._id,
      scopes: ['pages:read'],
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 86_400_000),
      ...(overrides.revokedAt !== undefined ? { revokedAt: overrides.revokedAt } : {}),
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
    it('revokes the reachable component; a subsequent refresh of that token is invalid_grant (AC-4)', async () => {
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

    it('404s (never 200) when the addressed tip is TTL-deleted between the ownership lookup and revokeChain re-querying its origin, and its active successor stays active (AC-13)', async () => {
      const pair = await getInitialPair();
      const originHash = Refresh().hashToken(pair.refresh_token);
      const origin = await Refresh().findOne({ tokenHash: originHash });
      const id = (origin?._id as unknown as { toString(): string }).toString();

      // A prior normal rotation gives the origin an ACTIVE successor before
      // we race its own document out from under `revokeChain`.
      const rotated = await tokenRequest({ grant_type: 'refresh_token', refresh_token: pair.refresh_token, client_id: 'crowi-cli' });
      expect(rotated.status).toBe(200);
      const successorHash = Refresh().hashToken(rotated.body.refresh_token as string);

      const originalRevokeChain = Refresh().revokeChain.bind(Refresh());
      const spy = jest.spyOn(Refresh(), 'revokeChain').mockImplementation(async (hash: string) => {
        if (hash === originHash) {
          // Simulate the TTL sweep landing between the handler's ownership
          // lookup and `revokeChain`'s own re-query of this same hash.
          await Refresh().deleteOne({ tokenHash: originHash });
        }
        return originalRevokeChain(hash);
      });

      try {
        const delRes = await del(id);
        expect(delRes.status).toBe(404);
        expect(delRes.body.error.code).toBe('NOT_FOUND');
      } finally {
        spy.mockRestore();
      }

      // revokeChain's traversal never discovered the rotatedTo link (the
      // origin row it would have read it from was already gone) — the
      // successor it should have reached stays active.
      const successor = await Refresh().findOne({ tokenHash: successorHash });
      expect(successor?.revokedAt).toBeNull();
    });

    it('a concurrent refresh fork produces 2 unlinked active successors; deleting one never revokes the other (AC-14)', async () => {
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

      // The unlinked successor (last-write-wins loser of the `rotatedTo`
      // race on the shared predecessor) is a SEPARATE component — this
      // DELETE must not have reached it.
      const stillActive = await Refresh().findById(otherId);
      expect(stillActive?.revokedAt).toBeNull();
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
