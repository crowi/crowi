process.env.WS_TOKEN_SECRET = process.env.WS_TOKEN_SECRET ?? 'test-ws-token-secret-base64-32bytes-=';

import crypto from 'node:crypto';
import type { FederatedProfileTerminalResult } from 'src/auth/federated-profile-terminal';
import { createAuthRegistrationTerminal } from 'src/services/auth-registration';
import { type ConfigRow, restoreCrowiConfig, snapshotCrowiConfig } from 'src/test/config-snapshot';
import { app, crowi } from 'src/test/setup';
import { buildHandoffCanonicalMessage, computeJwkThumbprint } from 'src/util/federated-auth-state';
import request from 'supertest';

const jsonHeaders = { 'Content-Type': 'application/json' };
const TEST_URLS = { apiUrl: 'https://api.test.example', webUrl: 'https://web.test.example' };

/**
 * A fresh P-256 keypair modelling the ORIGINAL `/auth/providers/{name}/start`
 * sender key — its thumbprint (`computeJwkThumbprint`) is what gets passed as
 * `handoffJkt` when seeding a grant via `resolveUnknownProfile` below (the
 * SAME value `hono/handlers/federated-auth.ts`'s real callback would pass
 * from `state.handoffJkt`), plus a `sign()` helper to redeem the resulting
 * code via `POST /auth/handoff`'s sender-constrained proof (same convention
 * as `federated-auth.test.ts#createSenderKeyPair`).
 */
async function createHandoffKeyPair() {
  const { publicKey, privateKey } = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicJwk = (await crypto.webcrypto.subtle.exportKey('jwk', publicKey)) as JsonWebKey;
  const handoffJkt = computeJwkThumbprint(publicJwk);
  const sign = async (message: string): Promise<string> => {
    const sigBuf = await crypto.webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(message));
    return Buffer.from(sigBuf).toString('base64url');
  };
  return { publicJwk, handoffJkt, sign };
}

/** A fixed opaque `handoffJkt` for tests that never redeem the resulting handoff — never parsed, just persisted/compared byte-for-byte. */
const TEST_HANDOFF_JKT = 'test-handoff-jkt';

let savedUrls: { apiUrl: string; webUrl: string } | null;
beforeAll(async () => {
  // `POST /auth/handoff` (redeemed by the round-trip test below) needs
  // trusted origins configured — same convention as `federated-auth.test.ts`.
  savedUrls = crowi.federatedAuthPublicUrls;
  crowi.federatedAuthPublicUrls = TEST_URLS;
});
afterAll(() => {
  crowi.federatedAuthPublicUrls = savedUrls;
});

/**
 * RFC-0014 phase 2 — API integration tests for the federated registration
 * screen (`/auth/federated-registration/:token[/logout]`).
 *
 * `createAuthRegistrationTerminal(crowi).resolve(...)` is called directly to
 * seed a `PendingAuthRegistration` row + obtain its one-time grant — this is
 * the same terminal `buildHonoApp` wires into the federated-auth callback
 * (`hono/index.ts`), so seeding through it (rather than poking the model
 * directly) also exercises AC-1's terminal behaviour end-to-end. `handoffJkt`
 * defaults to the fixed opaque test value — pass a real keypair's thumbprint
 * only for tests that actually redeem the resulting handoff.
 */
const resolveUnknownProfile = (provider: string, providerUserId: string, email: string, providerLabel = 'Google', handoffJkt = TEST_HANDOFF_JKT) =>
  createAuthRegistrationTerminal(crowi).resolve({ provider, profile: { providerUserId, email }, providerLabel, handoffJkt });

/** Narrows a `resolveUnknownProfile` result to its `{kind:'registration'}` grant token — every seeding call in this file resolves to exactly that outcome. */
function tokenOf(result: FederatedProfileTerminalResult): string {
  if (result.kind !== 'registration') throw new Error(`expected a registration outcome, got kind=${result.kind}`);
  return result.token;
}

describe('Routes /api/auth/federated-registration (Hono)', () => {
  const Config = () => crowi.model('Config');
  const User = () => crowi.model('User');
  const PendingAuthRegistration = () => crowi.model('PendingAuthRegistration');
  let configSnapshot: ConfigRow[];

  beforeAll(async () => {
    configSnapshot = await snapshotCrowiConfig(crowi);
    await Config().deleteMany({ ns: 'crowi' });
    await Config().applicationInstall();
    await crowi.getConfigService().load();
  });

  afterAll(async () => {
    await restoreCrowiConfig(crowi, configSnapshot);
  });

  const setRegistrationMode = async (mode: string) => {
    await Config().updateConfig('crowi', 'security:registrationMode', mode);
    await crowi.getConfigService().load();
  };

  afterEach(async () => {
    await setRegistrationMode(Config().SECURITY_REGISTRATION_MODE_OPEN);
  });

  describe('GET /auth/federated-registration/:token (AC-1)', () => {
    it('returns a read-only snapshot for an unknown, verified profile — and creates no User', async () => {
      const email = 'fedreg-ac1@example.com';
      await User().deleteMany({ email });

      const result = await resolveUnknownProfile('fedreg-google', 'fedreg-ac1-sub', email, 'Google');
      expect(result.kind).toBe('registration');
      const token = tokenOf(result);

      expect(await User().countDocuments({ email })).toBe(0);

      const res = await request(app).get(`/api/auth/federated-registration/${token}`);
      expect(res.status).toBe(200);
      // Spec's literal contract (`契約・不変条件`): the snapshot is exactly
      // `{email, provider, providerLabel}` — no `status` field (that
      // belongs to the SUBMIT result only, `FederatedRegistrationResultSchema`).
      expect(res.body).toEqual({ email, provider: 'fedreg-google', providerLabel: 'Google', approvalPending: false });

      expect(await User().countDocuments({ email })).toBe(0);
    });

    it('returns 404 for an unknown token', async () => {
      const res = await request(app).get('/api/auth/federated-registration/not-a-real-grant');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    // The snapshot deliberately carries no free-form status, but it MUST
    // say whether this grant's registration already finalized to
    // "awaiting approval". Without it the screen re-renders an editable
    // username field for a registration that is already submitted — which
    // is what manual QA hit by pressing Back: the field accepted a new
    // username, the submit reported success, and the value was silently
    // discarded (see the re-submit test below).
    it('reports an APPROVAL_PENDING row as already awaiting approval, so the screen does not re-offer the form', async () => {
      const email = 'fedreg-ac8-status-approval@example.com';
      const username = `fedreg-ac8-status-approval-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });
      const result = await resolveUnknownProfile('fedreg-google', 'fedreg-ac8-status-approval-sub', email);
      const token = tokenOf(result);

      await setRegistrationMode(Config().SECURITY_REGISTRATION_MODE_RESTRICTED);
      const submitRes = await request(app).post(`/api/auth/federated-registration/${token}`).set(jsonHeaders).send({ username });
      expect(submitRes.status).toBe(200);
      expect(submitRes.body).toEqual({ status: 'approval_required' });

      // The SAME grant, re-read — this is the Back-button path.
      const backRes = await request(app).get(`/api/auth/federated-registration/${token}`);
      expect(backRes.status).toBe(200);
      expect(backRes.body).toEqual({ email, provider: 'fedreg-google', providerLabel: 'Google', approvalPending: true });

      // Re-authenticating reissues a grant on the SAME (still APPROVAL_PENDING) row.
      const reauth = await resolveUnknownProfile('fedreg-google', 'fedreg-ac8-status-approval-sub', email);
      expect(reauth.kind).toBe('registration');
      const newToken = tokenOf(reauth);

      const res = await request(app).get(`/api/auth/federated-registration/${newToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ email, provider: 'fedreg-google', providerLabel: 'Google', approvalPending: true });
    });

    // Answers the question manual QA raised directly: does the accepted
    // second submit write anything? It must not — the registration is
    // already finalized, and a second username can neither replace the
    // first nor create another account.
    it('a second submit with a different username changes nothing', async () => {
      const email = 'fedreg-resubmit@example.com';
      const first = `fedreg-resubmit-a-${Date.now()}`;
      const second = `fedreg-resubmit-b-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username: { $in: [first, second] } }] });
      const token = tokenOf(await resolveUnknownProfile('fedreg-google', 'fedreg-resubmit-sub', email));

      await setRegistrationMode(Config().SECURITY_REGISTRATION_MODE_RESTRICTED);
      expect((await request(app).post(`/api/auth/federated-registration/${token}`).set(jsonHeaders).send({ username: first })).body).toEqual({
        status: 'approval_required',
      });

      const again = await request(app).post(`/api/auth/federated-registration/${token}`).set(jsonHeaders).send({ username: second });

      expect(again.status).toBe(200);
      expect(again.body).toEqual({ status: 'approval_required' });
      // The account keeps the username it was created with, and no second
      // account appeared for the same address.
      expect(await User().countDocuments({ email })).toBe(1);
      expect(await User().countDocuments({ username: second })).toBe(0);
      expect((await User().findOne({ email }))?.username).toBe(first);
    });
  });

  describe('grant TTL and PROVISIONING reissue (AC-3)', () => {
    it('a PENDING grant past its 15-minute expiresAt is unusable (404)', async () => {
      const email = 'fedreg-ac3-ttl@example.com';
      await User().deleteMany({ email });
      const result = await resolveUnknownProfile('fedreg-google', 'fedreg-ac3-ttl-sub', email);
      const token = tokenOf(result);

      await PendingAuthRegistration().updateOne(
        { provider: 'fedreg-google', providerUserId: 'fedreg-ac3-ttl-sub' },
        { $set: { expiresAt: new Date(Date.now() - 1000) } },
      );

      const res = await request(app).get(`/api/auth/federated-registration/${token}`);
      expect(res.status).toBe(404);
    });

    it('re-authenticating against a PROVISIONING row issues a new grant WITHOUT resetting state/userId', async () => {
      const email = 'fedreg-ac3-provisioning@example.com';
      await User().deleteMany({ email });
      const first = await resolveUnknownProfile('fedreg-google', 'fedreg-ac3-provisioning-sub', email);
      const firstToken = tokenOf(first);

      // Simulate a submit that began (and, e.g., crashed mid-flight). The
      // original grant stays usable while PROVISIONING — it is a
      // resumable, durable row, not yet superseded.
      const grantHash = PendingAuthRegistration().hashGrant(firstToken);
      const provisioning = await PendingAuthRegistration().beginProvisioning(grantHash);
      expect(provisioning?.state).toBe('PROVISIONING');
      const midFlightRes = await request(app).get(`/api/auth/federated-registration/${firstToken}`);
      expect(midFlightRes.status).toBe(200);

      // Re-auth via the IdP reissues a grant on the SAME row (state/userId
      // untouched) — the OLD grant is superseded the moment a NEW one is
      // minted, since `grantHash` is overwritten in place.
      const second = await resolveUnknownProfile('fedreg-google', 'fedreg-ac3-provisioning-sub', email);
      expect(second.kind).toBe('registration');
      const secondToken = tokenOf(second);
      expect(secondToken).not.toBe(firstToken);

      const row = await PendingAuthRegistration().findOne({ provider: 'fedreg-google', providerUserId: 'fedreg-ac3-provisioning-sub' });
      expect(row?.state).toBe('PROVISIONING');

      const staleRes = await request(app).get(`/api/auth/federated-registration/${firstToken}`);
      expect(staleRes.status).toBe(404);

      const res = await request(app).get(`/api/auth/federated-registration/${secondToken}`);
      expect(res.status).toBe(200);
    });
  });

  describe('POST /auth/federated-registration/:token (AC-4)', () => {
    it('Open mode: activates immediately, records emailConfirmedAt, sends no confirmation email, and returns a Phase 1 handoff code bound to the ORIGINAL /start sender key (never a raw token pair — AC-4/AC-8), redeemable via POST /auth/handoff', async () => {
      const email = 'fedreg-ac4-open@example.com';
      const username = `fedreg-ac4-open-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });

      // AC-4: a verified IdP email must never trigger the password-registration
      // flow's confirmation email — assert the mailer is genuinely untouched,
      // not just infer it from the response shape.
      const sendSpy = jest.spyOn(crowi.getMailer(), 'send').mockResolvedValue(undefined as never);
      try {
        const keyPair = await createHandoffKeyPair();
        const result = await resolveUnknownProfile('fedreg-google', 'fedreg-ac4-open-sub', email, 'Google', keyPair.handoffJkt);
        const token = tokenOf(result);

        // AC-8: the submit request carries `username` ONLY — never a
        // sender key of its own.
        const res = await request(app).post(`/api/auth/federated-registration/${token}`).set(jsonHeaders).send({ username });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: 'active', code: expect.any(String) });
        // AC-4/AC-8: never a raw token pair, never the user object, in this response.
        expect(res.body.accessToken).toBeUndefined();
        expect(res.body.refreshToken).toBeUndefined();
        expect(res.body.user).toBeUndefined();

        const created = await User().findOne({ email });
        expect(created?.status).toBe(User().STATUS_ACTIVE);
        expect(created?.emailConfirmedAt).toBeTruthy();
        expect(created?.password).toBeFalsy();

        expect(sendSpy).not.toHaveBeenCalled();

        // The code is genuinely redeemable ONLY by the keypair whose
        // thumbprint was persisted at grant-issuance time (`handoffJkt`
        // above) — proving this isn't just a differently-shaped response
        // but the REAL sender-constrained handoff mechanism (same endpoint
        // Phase 1's OAuth callback uses), bound to the ORIGINAL `/start`
        // proof, never to anything the submit request itself could supply.
        const proofMessage = buildHandoffCanonicalMessage(TEST_URLS.apiUrl, res.body.code);
        const signature = await keyPair.sign(proofMessage);
        const handoffRes = await request(app)
          .post('/api/auth/handoff')
          .set(jsonHeaders)
          .send({ code: res.body.code, proof: { publicJwk: keyPair.publicJwk, signature } });
        expect(handoffRes.status).toBe(200);
        expect(handoffRes.body.accessToken).toEqual(expect.any(String));
        expect(handoffRes.body.refreshToken).toEqual(expect.any(String));
        expect(handoffRes.body.user).toMatchObject({ email, username });
      } finally {
        sendSpy.mockRestore();
      }
    });

    it('AC-8: a DIFFERENT keypair than the one the grant was issued against cannot redeem the resulting handoff — a stolen registration URL cannot rebind the handoff to an attacker-supplied key', async () => {
      const email = 'fedreg-ac8-sender-binding@example.com';
      const username = `fedreg-ac8-sender-binding-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });

      const originalKeyPair = await createHandoffKeyPair();
      const result = await resolveUnknownProfile('fedreg-google', 'fedreg-ac8-sender-binding-sub', email, 'Google', originalKeyPair.handoffJkt);
      const token = tokenOf(result);

      // The submit request has no `handoff_jwk` field at all — an attacker
      // holding only the stolen `token` cannot supply a key of their own.
      const res = await request(app).post(`/api/auth/federated-registration/${token}`).set(jsonHeaders).send({ username });
      expect(res.status).toBe(200);
      const code = res.body.code as string;

      // An attacker's OWN keypair (never involved in the original /start)
      // cannot redeem the code.
      const attackerKeyPair = await createHandoffKeyPair();
      const proofMessage = buildHandoffCanonicalMessage(TEST_URLS.apiUrl, code);
      const signature = await attackerKeyPair.sign(proofMessage);
      const handoffRes = await request(app)
        .post('/api/auth/handoff')
        .set(jsonHeaders)
        .send({ code, proof: { publicJwk: attackerKeyPair.publicJwk, signature } });
      expect(handoffRes.status).toBe(401);
    });

    it('Restricted mode: stays REGISTERED, records emailConfirmedAt, and returns approval_required (no tokens)', async () => {
      const email = 'fedreg-ac4-restricted@example.com';
      const username = `fedreg-ac4-restricted-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });

      const result = await resolveUnknownProfile('fedreg-google', 'fedreg-ac4-restricted-sub', email);
      const token = tokenOf(result);

      await setRegistrationMode(Config().SECURITY_REGISTRATION_MODE_RESTRICTED);

      const res = await request(app).post(`/api/auth/federated-registration/${token}`).set(jsonHeaders).send({ username });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'approval_required' });
      expect(res.body.accessToken).toBeUndefined();

      const created = await User().findOne({ email });
      expect(created?.status).toBe(User().STATUS_REGISTERED);
      expect(created?.emailConfirmedAt).toBeTruthy();
    });

    it('AC-8: re-submitting an ALREADY-approval_required grant re-reports approval_required (200) — never the same 404 as an expired link, so a reload/re-auth can still tell "awaiting an admin" from "your link died"', async () => {
      const email = 'fedreg-ac8-approval-revisit@example.com';
      const username = `fedreg-ac8-approval-revisit-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });

      const result = await resolveUnknownProfile('fedreg-google', 'fedreg-ac8-approval-revisit-sub', email);
      const token = tokenOf(result);

      await setRegistrationMode(Config().SECURITY_REGISTRATION_MODE_RESTRICTED);
      const first = await request(app).post(`/api/auth/federated-registration/${token}`).set(jsonHeaders).send({ username });
      expect(first.body).toEqual({ status: 'approval_required' });

      // The visitor reloads (or re-authenticates): GET still 200s, so they
      // land back on the username form and submit again. That second submit
      // must NOT look like an expired grant — the row is genuinely finalized
      // to APPROVAL_PENDING and is deliberately not re-provisionable, but its
      // STATUS is still reportable to the same grant holder.
      const getRes = await request(app).get(`/api/auth/federated-registration/${token}`);
      expect(getRes.status).toBe(200);

      const second = await request(app).post(`/api/auth/federated-registration/${token}`).set(jsonHeaders).send({ username });
      expect(second.status).toBe(200);
      expect(second.body).toEqual({ status: 'approval_required' });

      // Purely a status re-report: the account behind it is untouched, still
      // awaiting the ordinary admin-approval path, and no second User exists.
      expect(await User().countDocuments({ email })).toBe(1);
      const stillRegistered = await User().findOne({ email });
      expect(stillRegistered?.status).toBe(User().STATUS_REGISTERED);
    });

    it('returns 404 for an unknown/expired/cancelled grant', async () => {
      const res = await request(app).post('/api/auth/federated-registration/not-a-real-grant').set(jsonHeaders).send({ username: 'whoever' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('rejects an invalid username with 400 VALIDATION_ERROR before creating a User', async () => {
      const email = 'fedreg-invalid-username@example.com';
      await User().deleteMany({ email });
      const result = await resolveUnknownProfile('fedreg-google', 'fedreg-invalid-username-sub', email);
      const token = tokenOf(result);

      const res = await request(app).post(`/api/auth/federated-registration/${token}`).set(jsonHeaders).send({ username: 'bad.name' });
      expect(res.status).toBe(400);
      expect(await User().countDocuments({ email })).toBe(0);
    });
  });

  describe('POST /auth/federated-registration/:token/logout (AC-2)', () => {
    it('cancels a PENDING grant — subsequent GET and POST both 404', async () => {
      const email = 'fedreg-logout@example.com';
      await User().deleteMany({ email });
      const result = await resolveUnknownProfile('fedreg-google', 'fedreg-logout-sub', email);
      const token = tokenOf(result);

      const logoutRes = await request(app).post(`/api/auth/federated-registration/${token}/logout`);
      expect(logoutRes.status).toBe(204);

      const getRes = await request(app).get(`/api/auth/federated-registration/${token}`);
      expect(getRes.status).toBe(404);

      const postRes = await request(app).post(`/api/auth/federated-registration/${token}`).set(jsonHeaders).send({ username: 'whoever' });
      expect(postRes.status).toBe(404);
    });

    it('is idempotent for an unknown token (still 204)', async () => {
      const res = await request(app).post('/api/auth/federated-registration/not-a-real-grant/logout');
      expect(res.status).toBe(204);
    });

    it('cancels an APPROVAL_PENDING grant too — the status page 404s afterward, without touching the underlying REGISTERED account', async () => {
      const email = 'fedreg-logout-approval@example.com';
      const username = `fedreg-logout-approval-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });
      const result = await resolveUnknownProfile('fedreg-google', 'fedreg-logout-approval-sub', email);
      const token = tokenOf(result);

      await setRegistrationMode(Config().SECURITY_REGISTRATION_MODE_RESTRICTED);
      const submitRes = await request(app).post(`/api/auth/federated-registration/${token}`).set(jsonHeaders).send({ username });
      expect(submitRes.status).toBe(200);
      expect(submitRes.body).toEqual({ status: 'approval_required' });

      const logoutRes = await request(app).post(`/api/auth/federated-registration/${token}/logout`);
      expect(logoutRes.status).toBe(204);

      const getRes = await request(app).get(`/api/auth/federated-registration/${token}`);
      expect(getRes.status).toBe(404);

      // Untouched: still REGISTERED, awaiting the normal admin-approval
      // path — logout invalidates only this journal row's own token, it
      // never un-registers the account it already created.
      const created = await User().findOne({ email });
      expect(created?.status).toBe(User().STATUS_REGISTERED);
    });

    it('AC-2: logout AFTER a fully-completed active submit actually invalidates the grant — GET and POST both 404 afterward — while leaving the (already genuinely ACTIVE) account untouched', async () => {
      const email = 'fedreg-logout-already-active@example.com';
      const username = `fedreg-logout-already-active-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });
      const result = await resolveUnknownProfile('fedreg-google', 'fedreg-logout-already-active-sub', email);
      const token = tokenOf(result);

      const submitRes = await request(app).post(`/api/auth/federated-registration/${token}`).set(jsonHeaders).send({ username });
      expect(submitRes.status).toBe(200);
      expect(submitRes.body.status).toBe('active');

      const logoutRes = await request(app).post(`/api/auth/federated-registration/${token}/logout`);
      expect(logoutRes.status).toBe(204);

      // The registration genuinely, fully finished before this logout ran
      // (the durable `UserActivation` marker is `done`) — the CANCELLED
      // write must stick this time: a stale/shared token calling logout
      // long after completion must actually kill the grant, not silently
      // report success (204) while quietly restoring it to ACTIVE and
      // leaving it just as usable as before.
      const row = await PendingAuthRegistration().findOne({ provider: 'fedreg-google', providerUserId: 'fedreg-logout-already-active-sub' });
      expect(row?.state).toBe('CANCELLED');

      const getRes = await request(app).get(`/api/auth/federated-registration/${token}`);
      expect(getRes.status).toBe(404);
      const postRes = await request(app).post(`/api/auth/federated-registration/${token}`).set(jsonHeaders).send({ username: 'whoever' });
      expect(postRes.status).toBe(404);

      // The account itself is untouched — logout never un-registers an
      // already-completed account, it only kills this journal row's token.
      const created = await User().findOne({ email });
      expect(created?.status).toBe(User().STATUS_ACTIVE);
    });

    it('AC-2: logout during the not-yet-drained crash window (User already genuinely ACTIVE, durable UserActivation marker NOT yet done) still PERMANENTLY invalidates the grant — GET and POST both 404 afterward — while leaving the ACTIVE account untouched (regression: this window used to silently revert the cancel back to ACTIVE with the SAME grantHash, leaving the just-"logged-out" token fully usable)', async () => {
      const email = 'fedreg-logout-not-drained@example.com';
      const username = `fedreg-logout-not-drained-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });
      const result = await resolveUnknownProfile('fedreg-google', 'fedreg-logout-not-drained-sub', email);
      const token = tokenOf(result);

      // `UserActivation.markActivationDone` is the LAST write
      // `drainUserActivation` performs — strictly AFTER the journal's own
      // ACTIVE write, the User's own ACTIVE CAS, and `ensureUserPage`'s
      // page creation have all already committed. Injecting a real logout
      // HTTP request right there reproduces "User genuinely ACTIVE, durable
      // marker still NOT done" (the exact crash-recovery window design
      // decision 4 describes) without needing to hand-seed model state.
      const UserActivation = crowi.model('UserActivation');
      const originalMarkActivationDone = UserActivation.markActivationDone.bind(UserActivation);
      const markSpy = jest.spyOn(UserActivation, 'markActivationDone').mockImplementationOnce(async (userId) => {
        const logoutRes = await request(app).post(`/api/auth/federated-registration/${token}/logout`);
        expect(logoutRes.status).toBe(204);
        return originalMarkActivationDone(userId);
      });

      let submitRes: request.Response;
      try {
        submitRes = await request(app).post(`/api/auth/federated-registration/${token}`).set(jsonHeaders).send({ username });
      } finally {
        markSpy.mockRestore();
      }
      // The submit's own outcome was already decided (its ACTIVE CAS and
      // page creation both ran) BEFORE the injected logout fired — it still
      // succeeds and still finishes draining (the marker really does reach
      // `done` — asserted below).
      expect(submitRes.status).toBe(200);
      expect(submitRes.body.status).toBe('active');

      // But the SAME token this very submit was reached through must never
      // work again — logout permanently invalidated it, even though it
      // landed strictly inside the not-yet-drained crash window.
      const getRes = await request(app).get(`/api/auth/federated-registration/${token}`);
      expect(getRes.status).toBe(404);
      const postRes = await request(app).post(`/api/auth/federated-registration/${token}`).set(jsonHeaders).send({ username: 'whoever' });
      expect(postRes.status).toBe(404);

      const row = await PendingAuthRegistration().findOne({ provider: 'fedreg-google', providerUserId: 'fedreg-logout-not-drained-sub' });
      expect(row?.state).toBe('CANCELLED');

      const created = await User().findOne({ email });
      expect(created?.status).toBe(User().STATUS_ACTIVE);
      const marker = await UserActivation.findOne({ userId: created?._id });
      expect(marker?.status).toBe('done');
    });

    it('a logout racing with an in-flight submit never activates the account behind a cancelled grant (AC-2 security)', async () => {
      const email = 'fedreg-logout-race@example.com';
      const username = `fedreg-logout-race-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });
      const result = await resolveUnknownProfile('fedreg-google', 'fedreg-logout-race-sub', email);
      const token = tokenOf(result);

      const [submitRes, logoutRes] = await Promise.all([
        request(app).post(`/api/auth/federated-registration/${token}`).set(jsonHeaders).send({ username }),
        request(app).post(`/api/auth/federated-registration/${token}/logout`),
      ]);
      expect(logoutRes.status).toBe(204);

      const row = await PendingAuthRegistration().findOne({ provider: 'fedreg-google', providerUserId: 'fedreg-logout-race-sub' });
      const created = await User().findOne({ email });

      // The submit response is the authoritative signal of whether the
      // state machine's OWN finalize write genuinely committed — keying off
      // it (rather than the journal row's FINAL state) correctly covers a
      // third possible outcome the row's state alone can't distinguish: the
      // submit can win outright AND fully, durably complete (drain done)
      // strictly BEFORE the concurrent logout's own read runs, in which
      // case AC-2 now (correctly) lets the CANCEL stick — permanently
      // invalidating the grant — while the account itself stays ACTIVE
      // (logout never un-registers an already-completed account).
      if (submitRes.body?.status === 'active') {
        expect(created?.status).toBe(User().STATUS_ACTIVE);
      } else {
        // The submit's finalize write was blocked by an earlier-landing
        // cancel (AC-2 security) — the row is CANCELLED and the account
        // never activated.
        expect(row?.state).toBe('CANCELLED');
        expect(created?.status).not.toBe(User().STATUS_ACTIVE);
      }
    });

    it('a logout that lands DETERMINISTICALLY between beginProvisioning and the guarded ACTIVE finalize write always blocks activation (AC-2 security)', async () => {
      const email = 'fedreg-logout-deterministic@example.com';
      const username = `fedreg-logout-deterministic-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });
      const result = await resolveUnknownProfile('fedreg-google', 'fedreg-logout-deterministic-sub', email);
      const token = tokenOf(result);

      // Forces the interleave deterministically (unlike the Promise.all
      // race above, which tolerates either side winning): submit's own
      // `ensurePendingMarker` call is the LAST await before the guarded
      // ACTIVE finalize write — injecting a real logout HTTP request
      // there, and awaiting it, guarantees the finalize step runs strictly
      // AFTER the cancellation has already landed.
      const UserActivation = crowi.model('UserActivation');
      const originalEnsurePendingMarker = UserActivation.ensurePendingMarker.bind(UserActivation);
      const activationSpy = jest.spyOn(UserActivation, 'ensurePendingMarker').mockImplementationOnce(async (userId) => {
        await originalEnsurePendingMarker(userId);
        const logoutRes = await request(app).post(`/api/auth/federated-registration/${token}/logout`);
        expect(logoutRes.status).toBe(204);
      });

      try {
        const submitRes = await request(app).post(`/api/auth/federated-registration/${token}`).set(jsonHeaders).send({ username });
        expect(submitRes.status).toBe(404);
        expect(submitRes.body.error.code).toBe('NOT_FOUND');
      } finally {
        activationSpy.mockRestore();
      }

      const row = await PendingAuthRegistration().findOne({ provider: 'fedreg-google', providerUserId: 'fedreg-logout-deterministic-sub' });
      expect(row?.state).toBe('CANCELLED');
      const created = await User().findOne({ email });
      expect(created?.status).not.toBe(User().STATUS_ACTIVE);
    });

    it("a logout that lands AFTER the journal's own ACTIVE write but BEFORE the User's ACTIVE CAS is caught by the compensating post-CAS re-check, reverting the User CAS this submit itself performed (AC-2 security — the narrower gap between the two separate CAS writes)", async () => {
      const email = 'fedreg-logout-post-journal-active@example.com';
      const username = `fedreg-logout-post-journal-active-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });
      const result = await resolveUnknownProfile('fedreg-google', 'fedreg-logout-post-journal-active-sub', email);
      const token = tokenOf(result);

      // The journal's OWN finalize write (`state:'ACTIVE'`) runs strictly
      // BEFORE the User's ACTIVE CAS — `User.updateOne` is therefore the
      // ONLY call to that method in a plain, non-restricted,
      // non-concurrent submit, making it the exact injection point for "a
      // logout lands AFTER the journal write but BEFORE the User CAS
      // actually executes".
      const UserModel = crowi.model('User');
      const originalUserUpdateOne = UserModel.updateOne.bind(UserModel);
      const updateSpy = jest.spyOn(UserModel, 'updateOne').mockImplementationOnce(async (filter, update) => {
        const logoutRes = await request(app).post(`/api/auth/federated-registration/${token}/logout`);
        expect(logoutRes.status).toBe(204);
        return originalUserUpdateOne(filter, update);
      });

      try {
        const submitRes = await request(app).post(`/api/auth/federated-registration/${token}`).set(jsonHeaders).send({ username });
        // The wrapped User CAS still executes underneath (and, in
        // isolation, succeeds — the User was still REGISTERED at that
        // instant) — but the compensating post-CAS re-check inside
        // `provisionPendingRegistration` sees the journal is now
        // CANCELLED and reverts it: 404, never a success response.
        expect(submitRes.status).toBe(404);
        expect(submitRes.body.error.code).toBe('NOT_FOUND');
      } finally {
        updateSpy.mockRestore();
      }

      const row = await PendingAuthRegistration().findOne({ provider: 'fedreg-google', providerUserId: 'fedreg-logout-post-journal-active-sub' });
      expect(row?.state).toBe('CANCELLED');
      const created = await User().findOne({ email });
      // Reverted by the compensating check — never left ACTIVE behind a
      // CANCELLED journal, even though the CAS itself momentarily succeeded.
      expect(created?.status).not.toBe(User().STATUS_ACTIVE);
    });

    it("AC-2/AC-7: a logout that lands AFTER beginProvisioning but BEFORE the in-flight submit's OWN userId-reservation CAS clears the lease itself, fencing that write out and creating NO phantom User — even though NO fresh re-authentication ever revives the row (regression: the CANCELLED write used to leave provisioningLeaseToken/provisioningLeaseExpiresAt untouched, and the userId-reservation CAS's own filter does not check `state` at all — only `{userId: null, provisioningLeaseToken}` — so it would otherwise still match)", async () => {
      const email = 'fedreg-logout-pre-reservation@example.com';
      const username = `fedreg-logout-pre-reservation-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });
      const result = await resolveUnknownProfile('fedreg-google', 'fedreg-logout-pre-reservation-sub', email);
      const token = tokenOf(result);

      // `provisionPendingRegistration` calls `beginProvisioning` exactly
      // once — inject the real logout HTTP request right after it returns
      // (row is now PROVISIONING, `userId` still `null`), strictly BEFORE
      // the submit ever reaches its own userId-reservation CAS.
      const PendingAuthRegistrationModel = PendingAuthRegistration();
      const originalBeginProvisioning = PendingAuthRegistrationModel.beginProvisioning.bind(PendingAuthRegistrationModel);
      const beginSpy = jest.spyOn(PendingAuthRegistrationModel, 'beginProvisioning').mockImplementationOnce(async (hash: string) => {
        const claimed = await originalBeginProvisioning(hash);
        const logoutRes = await request(app).post(`/api/auth/federated-registration/${token}/logout`);
        expect(logoutRes.status).toBe(204);
        return claimed;
      });

      let submitRes: request.Response;
      try {
        submitRes = await request(app).post(`/api/auth/federated-registration/${token}`).set(jsonHeaders).send({ username });
      } finally {
        beginSpy.mockRestore();
      }

      // Fenced out at the userId-reservation CAS itself (the lease token
      // this submit was claiming no longer matches — logout cleared it) —
      // never reaches `active`, and never creates a User for a row that was
      // already cancelled before the submit got the chance to reserve one.
      expect(submitRes.status).toBe(404);
      expect(submitRes.body.error.code).toBe('NOT_FOUND');
      expect(await User().countDocuments({ email })).toBe(0);
      expect(await User().countDocuments({ username })).toBe(0);

      const row = await PendingAuthRegistration().findOne({ provider: 'fedreg-google', providerUserId: 'fedreg-logout-pre-reservation-sub' });
      expect(row?.state).toBe('CANCELLED');
      expect(row?.userId).toBeNull();
    });
  });

  describe('GET grant replay after full completion (AC-2)', () => {
    it('a fully-drained ACTIVE row (durable UserActivation marker already `done`) 404s on GET too, not just POST — the verified email/provider snapshot is not readable indefinitely for an already-completed registration', async () => {
      const email = 'fedreg-get-replay-done@example.com';
      const username = `fedreg-get-replay-done-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });
      const result = await resolveUnknownProfile('fedreg-google', 'fedreg-get-replay-done-sub', email);
      const token = tokenOf(result);

      const submitRes = await request(app).post(`/api/auth/federated-registration/${token}`).set(jsonHeaders).send({ username });
      expect(submitRes.status).toBe(200);
      expect(submitRes.body.status).toBe('active');

      const created = await User().findOne({ email });
      const UserActivation = crowi.model('UserActivation');
      const marker = await UserActivation.findOne({ userId: created?._id });
      expect(marker?.status).toBe('done');

      const getRes = await request(app).get(`/api/auth/federated-registration/${token}`);
      expect(getRes.status).toBe(404);
      expect(getRes.body.error.code).toBe('NOT_FOUND');
    });

    it('an ACTIVE row whose durable marker is NOT yet `done` (the crash-recovery window) still returns 200 — only a GENUINELY complete registration 404s', async () => {
      const email = 'fedreg-get-replay-not-done@example.com';
      const username = `fedreg-get-replay-not-done-${Date.now()}`;
      await User().deleteMany({ $or: [{ email }, { username }] });
      const result = await resolveUnknownProfile('fedreg-google', 'fedreg-get-replay-not-done-sub', email);
      const token = tokenOf(result);

      const pageSpy = jest.spyOn(crowi.model('Page'), 'createPage').mockImplementationOnce(async () => {
        throw new Error('injected crash: page side effect');
      });
      try {
        const submitRes = await request(app).post(`/api/auth/federated-registration/${token}`).set(jsonHeaders).send({ username });
        expect(submitRes.status).toBe(500);
      } finally {
        pageSpy.mockRestore();
      }

      const created = await User().findOne({ email });
      expect(created?.status).toBe(User().STATUS_ACTIVE);
      const UserActivation = crowi.model('UserActivation');
      const marker = await UserActivation.findOne({ userId: created?._id });
      expect(marker?.status).not.toBe('done');

      const getRes = await request(app).get(`/api/auth/federated-registration/${token}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body).toEqual({ email, provider: 'fedreg-google', providerLabel: 'Google', approvalPending: false });
    });
  });
});
