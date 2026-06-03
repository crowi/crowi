import request from 'supertest';

import { app, crowi } from 'src/test/setup';
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

describe('Routes /api/v2/me (Hono)', () => {
  const Config = () => crowi.model('Config');
  const User = () => crowi.model('User');

  beforeAll(async () => {
    // /auth/login + /auth/register checks rely on `applicationInstall()`
    // having been called, but `/me/*` is auth-only. We still seed the
    // install flag so the test setup mirrors a real deployment.
    await Config().deleteMany({ ns: 'crowi' });
    await Config().applicationInstall();
    await crowi.getConfigService().load();
  });

  afterAll(async () => {
    await Config().deleteMany({ ns: 'crowi' });
    await crowi.getConfigService().load();
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
      const res = await request(app).get('/api/v2/me').set('Authorization', `Bearer ${accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        username: 'me-get',
        name: 'Me Get',
        email: EMAIL,
        hasPassword: true,
        createdAt: expect.any(String),
      });
    });

    it('returns 401 AUTHENTICATION_REQUIRED without a bearer token', async () => {
      const res = await request(app).get('/api/v2/me');
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
        .put('/api/v2/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ userForm: { name: 'Me Put (renamed)', email: EMAIL, lang: 'ja' } });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ name: 'Me Put (renamed)', lang: 'ja' });

      const reread = await User().findById(user._id);
      expect(reread?.name).toBe('Me Put (renamed)');
    });

    it('returns 400 with errors[] when email collides with another user', async () => {
      const OTHER = 'me-put-collide@example.com';
      const other = await seedActiveUser({ name: 'Other', username: 'me-put-other', email: OTHER, password: 'Password!1' });

      const res = await request(app)
        .put('/api/v2/me')
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
        .put('/api/v2/me/password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ oldPassword: 'Password!1', newPassword: 'NewPwd!2', newPasswordConfirm: 'NewPwd!2' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok', message: 'Password updated' });
    });

    it('returns 400 status=error when oldPassword is wrong', async () => {
      // Password is already 'NewPwd!2' from the previous spec; use the
      // wrong old to trigger the guard.
      const res = await request(app)
        .put('/api/v2/me/password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ oldPassword: 'Password!1', newPassword: 'AnotherPwd!3', newPasswordConfirm: 'AnotherPwd!3' });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ status: 'error', errors: ['Wrong current password'] });
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
      const res = await request(app).get('/api/v2/me/recently-viewed-pages').set('Authorization', `Bearer ${accessToken}`);
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
        .post('/api/v2/me/picture')
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
        .post('/api/v2/me/picture')
        .set('Authorization', `Bearer ${accessToken}`)
        .attach('file', png, { filename: 'pixel.png', contentType: 'image/png' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: true, url: expect.any(String) });

      // Must be the STABLE by-key proxy path — never a time-limited
      // signed URL (those expire and 403 once persisted in user.image).
      expect(res.body.url).toMatch(/^\/api\/v2\/attachments\/by-key\//);
      expect(res.body.url).not.toContain('X-Amz-Signature');

      const reread = await User().findById(user._id);
      expect(reread?.image).toEqual(res.body.url);
    });

    it('clears the user image on DELETE /me/picture', async () => {
      const res = await request(app).delete('/api/v2/me/picture').set('Authorization', `Bearer ${accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'ok', message: 'Deleted profile picture' });

      const reread = await User().findById(user._id);
      expect(reread?.image).toBeNull();
    });
  });

  describe('auth boundary', () => {
    it('returns 401 AUTHENTICATION_REQUIRED for PUT /me/password without a bearer token', async () => {
      const res = await request(app).put('/api/v2/me/password').send({ newPassword: 'NewPwd!2', newPasswordConfirm: 'NewPwd!2' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });
  });
});
