import request from 'supertest';

import { app, crowi } from 'src/test/setup';
import { type ConfigRow, restoreCrowiConfig, snapshotCrowiConfig } from 'src/test/config-snapshot';
import type { UserDocument } from 'src/models/user';
import { createJwtUtil } from 'src/util/jwt';

/**
 * RFC-0006 Phase 4 Batch 2 — integration tests for the migrated `me`
 * resource (8 endpoints behind `createJwtAuth`).
 *
 * Wire-format parity with the ts-rest era is the explicit AC. We cover
 * the auth boundary (401 without Bearer), the happy path for read /
 * mutate / delete endpoints, and the structured-error envelope for
 * password + profile-update failure paths. Picture upload is exercised
 * with a synthetic in-memory PNG so the multipart parsing + temp-file
 * pipeline runs end-to-end.
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

describe('Routes /api/me (Hono)', () => {
  const Config = () => crowi.model('Config');
  const User = () => crowi.model('User');
  let configSnapshot: ConfigRow[];

  beforeAll(async () => {
    // Snapshot the shared crowi config BEFORE wiping it, so afterAll can
    // restore the namespace to its as-discovered (installed) state instead of
    // leaving it empty for the next file (the cross-file seed-401 flake).
    configSnapshot = await snapshotCrowiConfig(crowi);
    // /auth/login + /auth/register checks rely on `applicationInstall()`
    // having been called, but `/me/*` is auth-only. We still seed the
    // install flag so the test setup mirrors a real deployment.
    await Config().deleteMany({ ns: 'crowi' });
    await Config().applicationInstall();
    await crowi.getConfigService().load();
  });

  afterAll(async () => {
    await restoreCrowiConfig(crowi, configSnapshot);
  });

  describe('GET /me', () => {
    const EMAIL = 'me-get@example.com';
    let accessToken: string;

    beforeAll(async () => {
      const seeded = await seedActiveUser({ name: 'Me Get', username: 'me-get', email: EMAIL, password: 'Password!1' });
      accessToken = seeded.accessToken;
    });
    afterAll(async () => {
      await User().deleteMany({ email: EMAIL });
    });

    it('returns the current user profile when authenticated', async () => {
      const res = await request(app).get('/api/me').set('Authorization', `Bearer ${accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        username: 'me-get',
        name: 'Me Get',
        email: EMAIL,
        hasPassword: true,
        createdAt: expect.any(String),
        // Schema default — existing rows without an explicit theme read back
        // 'system' from the Mongoose default.
        theme: 'system',
        // AC-5: no linked UserIdentity row for this user.
        federated: false,
      });
    });

    it('returns 401 AUTHENTICATION_REQUIRED without a bearer token', async () => {
      const res = await request(app).get('/api/me');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });
  });

  describe('PUT /me', () => {
    const EMAIL = 'me-put@example.com';
    let accessToken: string;
    let user: UserDocument;

    beforeAll(async () => {
      const seeded = await seedActiveUser({ name: 'Me Put', username: 'me-put', email: EMAIL, password: 'Password!1' });
      user = seeded.user;
      accessToken = seeded.accessToken;
    });
    afterAll(async () => {
      await User().deleteMany({ $or: [{ email: EMAIL }, { email: 'me-put-new@example.com' }] });
    });

    it('updates name + lang and returns the updated profile', async () => {
      const res = await request(app)
        .put('/api/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ userForm: { name: 'Me Put (renamed)', email: EMAIL, lang: 'ja' } });
      expect(res.status).toBe(200);
      // AC-5: no linked UserIdentity row for this user.
      expect(res.body).toMatchObject({ name: 'Me Put (renamed)', lang: 'ja', federated: false });

      const reread = await User().findById(user._id);
      expect(reread?.name).toBe('Me Put (renamed)');
    });

    // AC-4: a non-federated user's email-change request is unaffected by the
    // lock — it still goes through the confirm-by-email flow untouched.
    it('AC-4: requests a real email change and returns emailChangePending, leaving User.email unchanged until confirmed', async () => {
      const sendSpy = jest.spyOn(crowi.getMailer(), 'send').mockResolvedValue(undefined);
      try {
        const res = await request(app)
          .put('/api/me')
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ userForm: { name: 'Me Put (renamed)', email: 'me-put-new@example.com', lang: 'en' } });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ emailChangePending: true, federated: false });

        const reread = await User().findById(user._id);
        expect(reread?.email).toBe(EMAIL);
        expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ to: 'me-put-new@example.com', htmlTemplate: 'emailChange' }));
      } finally {
        sendSpy.mockRestore();
      }
    });

    it('returns 400 with errors[] when email collides with another user', async () => {
      const OTHER = 'me-put-collide@example.com';
      const other = await seedActiveUser({ name: 'Other', username: 'me-put-other', email: OTHER, password: 'Password!1' });

      const res = await request(app)
        .put('/api/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ userForm: { name: 'Me Put', email: OTHER, lang: 'en' } });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        status: 'error',
        errors: ['It can not be changed to that mail address'],
      });

      await User().deleteOne({ _id: other.user._id });
    });
  });

  describe('PUT /me — federated identity email lock', () => {
    const EMAIL = 'me-put-federated@example.com';
    const NEW_EMAIL = 'me-put-federated-new@example.com';
    let accessToken: string;
    let user: UserDocument;

    beforeAll(async () => {
      const seeded = await seedActiveUser({ name: 'Me Put Federated', username: 'me-put-federated', email: EMAIL, password: 'Password!1' });
      user = seeded.user;
      accessToken = seeded.accessToken;
      await crowi.model('UserIdentity').create({ userId: user._id, provider: 'google', providerUserId: `sub-${user._id.toString()}` });
    });
    afterAll(async () => {
      await User().deleteMany({ $or: [{ email: EMAIL }, { email: NEW_EMAIL }] });
      await crowi.model('UserIdentity').deleteMany({ userId: user._id });
    });

    it('AC-1: refuses the email change with 400 EMAIL_LOCKED_BY_FEDERATED_IDENTITY, leaving User.email unchanged and sending no confirmation mail', async () => {
      const sendSpy = jest.spyOn(crowi.getMailer(), 'send');
      try {
        const res = await request(app)
          .put('/api/me')
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ userForm: { name: 'Attempted Rename', email: NEW_EMAIL, lang: 'en' } });

        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ status: 'error', code: 'EMAIL_LOCKED_BY_FEDERATED_IDENTITY' });

        const reread = await User().findById(user._id);
        expect(reread?.email).toBe(EMAIL);
        // AC-2: name/lang from the same (rejected) request were not
        // applied either — the whole request is refused, not just email.
        expect(reread?.name).toBe('Me Put Federated');
        expect(reread?.lang).toBe('en');
        expect(sendSpy).not.toHaveBeenCalled();
      } finally {
        sendSpy.mockRestore();
      }
    });

    it('AC-3: a resubmission of the SAME email still saves name/lang and returns 200', async () => {
      const res = await request(app)
        .put('/api/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ userForm: { name: 'Renamed OK', email: EMAIL, lang: 'ja' } });

      expect(res.status).toBe(200);
      // AC-5: the response reports the real state even though this PUT
      // carried no email change.
      expect(res.body).toMatchObject({ name: 'Renamed OK', lang: 'ja', federated: true });
      expect(res.body.emailChangePending).toBeUndefined();

      const reread = await User().findById(user._id);
      expect(reread?.name).toBe('Renamed OK');
      expect(reread?.lang).toBe('ja');
      expect(reread?.email).toBe(EMAIL);
    });

    // AC-5 + the performance contract in one place: a same-email PUT pays
    // for the identity lookup that keeps `federated` honest, but pays for it
    // by skipping the duplicate-email pre-check — which the unique index on
    // `email` makes a foregone "no collision" when the address is the
    // caller's own. Net query count is the same as before the lock existed.
    it('AC-5: a same-email PUT reports federated: true and swaps the duplicate pre-check for the identity lookup', async () => {
      const findOneSpy = jest.spyOn(User(), 'findOne');
      const existsSpy = jest.spyOn(crowi.model('UserIdentity'), 'exists');
      try {
        const res = await request(app)
          .put('/api/me')
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ userForm: { name: 'Renamed Again', email: EMAIL, lang: 'en' } });

        expect(res.status).toBe(200);
        expect(res.body.federated).toBe(true);
        // Mongoose's `findById` delegates to `findOne({ _id })`, and both the
        // auth middleware and `populateSecrets()` go through it — so count
        // only the calls that actually carry an `email` predicate.
        const emailLookups = findOneSpy.mock.calls.filter(([filter]) => filter != null && typeof filter === 'object' && 'email' in filter);
        expect(emailLookups).toHaveLength(0);
        expect(existsSpy).toHaveBeenCalledTimes(1);
      } finally {
        findOneSpy.mockRestore();
        existsSpy.mockRestore();
      }
    });

    it('AC-5: GET /me also reports federated: true for this user', async () => {
      const res = await request(app).get('/api/me').set('Authorization', `Bearer ${accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.federated).toBe(true);
    });
  });

  describe('PATCH /me/theme', () => {
    const EMAIL = 'me-theme@example.com';
    let accessToken: string;
    let user: UserDocument;

    beforeAll(async () => {
      const seeded = await seedActiveUser({ name: 'Me Theme', username: 'me-theme', email: EMAIL, password: 'Password!1' });
      user = seeded.user;
      accessToken = seeded.accessToken;
    });
    afterAll(async () => {
      await User().deleteMany({ email: EMAIL });
    });

    it('persists the theme and echoes it back', async () => {
      const res = await request(app).patch('/api/me/theme').set('Authorization', `Bearer ${accessToken}`).send({ theme: 'dark' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok', theme: 'dark' });

      const reread = await User().findById(user._id);
      expect(reread?.theme).toBe('dark');
    });

    it('round-trips the new theme on GET /me', async () => {
      await request(app).patch('/api/me/theme').set('Authorization', `Bearer ${accessToken}`).send({ theme: 'light' });
      const res = await request(app).get('/api/me').set('Authorization', `Bearer ${accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.theme).toBe('light');
    });

    it('returns 400 on an invalid theme value', async () => {
      const res = await request(app).patch('/api/me/theme').set('Authorization', `Bearer ${accessToken}`).send({ theme: 'sepia' });
      expect(res.status).toBe(400);
    });

    it('returns 401 without a bearer token', async () => {
      const res = await request(app).patch('/api/me/theme').send({ theme: 'dark' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });
  });

  describe('PUT /me/password', () => {
    const EMAIL = 'me-password@example.com';
    let accessToken: string;

    beforeAll(async () => {
      const seeded = await seedActiveUser({ name: 'Me Pwd', username: 'me-pwd', email: EMAIL, password: 'Password!1' });
      accessToken = seeded.accessToken;
    });
    afterAll(async () => {
      await User().deleteMany({ email: EMAIL });
    });

    it('updates the password on valid old + new pair', async () => {
      const res = await request(app)
        .put('/api/me/password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ oldPassword: 'Password!1', newPassword: 'NewPwd!2', newPasswordConfirm: 'NewPwd!2' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'ok', message: 'Password updated' });
      // The change revoked every earlier session, this one included, so
      // carry on with the replacement pair the response handed back (the
      // web client does the same via `storeTokens`).
      expect(res.body.accessToken).toBeTruthy();
      accessToken = res.body.accessToken;
    });

    it('returns 400 status=error when oldPassword is wrong', async () => {
      // Password is already 'NewPwd!2' from the previous spec; use the
      // wrong old to trigger the guard.
      const res = await request(app)
        .put('/api/me/password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ oldPassword: 'Password!1', newPassword: 'AnotherPwd!3', newPasswordConfirm: 'AnotherPwd!3' });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ status: 'error', errors: ['Wrong current password'] });
    });

    it('revokes sessions minted before the change and returns a fresh pair', async () => {
      const REVOKE_EMAIL = 'me-password-revoke@example.com';
      const seeded = await seedActiveUser({ name: 'Me Pwd Revoke', username: 'me-pwd-revoke', email: REVOKE_EMAIL, password: 'Password!1' });
      const staleToken = seeded.accessToken;

      const res = await request(app)
        .put('/api/me/password')
        .set('Authorization', `Bearer ${staleToken}`)
        .send({ oldPassword: 'Password!1', newPassword: 'NewPwd!2', newPasswordConfirm: 'NewPwd!2' });
      expect(res.status).toBe(200);

      // The whole point of changing a password: a session an attacker
      // already holds must stop working.
      const stale = await request(app).get('/api/me').set('Authorization', `Bearer ${staleToken}`);
      expect(stale.status).toBe(401);

      // ...but the caller's own tab keeps working, on the pair the
      // response just handed back.
      expect(res.body.accessToken).toBeTruthy();
      expect(res.body.refreshToken).toBeTruthy();
      const fresh = await request(app).get('/api/me').set('Authorization', `Bearer ${res.body.accessToken}`);
      expect(fresh.status).toBe(200);

      await User().deleteMany({ email: REVOKE_EMAIL });
    });
  });

  // Personal access token management (`/me/access-tokens`, replacing the
  // legacy `/me/apiToken`) is covered in `access-token.test.ts`.

  describe('GET /me/recently-viewed-pages', () => {
    const EMAIL = 'me-rvp@example.com';
    let accessToken: string;

    beforeAll(async () => {
      const seeded = await seedActiveUser({ name: 'Me Rvp', username: 'me-rvp', email: EMAIL, password: 'Password!1' });
      accessToken = seeded.accessToken;
    });
    afterAll(async () => {
      await User().deleteMany({ email: EMAIL });
    });

    it('returns an empty list when lru has no entries', async () => {
      const res = await request(app).get('/api/me/recently-viewed-pages').set('Authorization', `Bearer ${accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ pages: [] });
    });
  });

  describe('POST + DELETE /me/picture', () => {
    const EMAIL = 'me-pic@example.com';
    let accessToken: string;
    let user: UserDocument;

    beforeAll(async () => {
      const seeded = await seedActiveUser({ name: 'Me Pic', username: 'me-pic', email: EMAIL, password: 'Password!1' });
      accessToken = seeded.accessToken;
      user = seeded.user;
    });
    afterAll(async () => {
      await User().deleteMany({ email: EMAIL });
    });

    it('rejects non-image uploads with 400 status=error', async () => {
      const res = await request(app)
        .post('/api/me/picture')
        .set('Authorization', `Bearer ${accessToken}`)
        .attach('file', Buffer.from('not an image'), { filename: 'note.txt', contentType: 'text/plain' });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ status: 'error', errors: expect.arrayContaining([expect.stringContaining('File type error')]) });
    });

    it('uploads a tiny PNG and updates the user image url', async () => {
      // Minimal 1x1 transparent PNG (signature + IHDR + IDAT + IEND).
      const png = Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000005000119cce9be0000000049454e44ae426082',
        'hex',
      );
      const res = await request(app)
        .post('/api/me/picture')
        .set('Authorization', `Bearer ${accessToken}`)
        .attach('file', png, { filename: 'pixel.png', contentType: 'image/png' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: true, url: expect.any(String) });

      // Must be the STABLE by-key proxy path — never a time-limited
      // signed URL (those expire and 403 once persisted in user.image).
      expect(res.body.url).toMatch(/^\/api\/attachments\/by-key\//);
      expect(res.body.url).not.toContain('X-Amz-Signature');

      const reread = await User().findById(user._id);
      expect(reread?.image).toEqual(res.body.url);
    });

    it('clears the user image on DELETE /me/picture', async () => {
      const res = await request(app).delete('/api/me/picture').set('Authorization', `Bearer ${accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'ok', message: 'Deleted profile picture' });

      const reread = await User().findById(user._id);
      expect(reread?.image).toBeNull();
    });
  });

  describe('auth boundary', () => {
    it('returns 401 AUTHENTICATION_REQUIRED for PUT /me/password without a bearer token', async () => {
      const res = await request(app).put('/api/me/password').send({ newPassword: 'NewPwd!2', newPasswordConfirm: 'NewPwd!2' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });
  });
});
