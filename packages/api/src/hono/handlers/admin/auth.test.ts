import request from 'supertest';
import { app, crowi } from 'src/test/setup';
import { authHeaders, createTestUser } from 'src/test/test-helpers';

/**
 * Reset the two auth:* keys back to defaults between tests so each case
 * starts from a known state. Mirrors the security.test.ts helper.
 */
const resetAuthConfig = async () => {
  const configService = crowi.getConfigService();
  await configService.saveConfig('crowi', {
    'auth:requireThirdPartyAuth': false,
    'auth:disablePasswordAuth': false,
  });
};

/**
 * Make sure googleLoginEnabled() returns true so that the user's googleId
 * counts toward `hasValidThirdPartyId()`. Only matters for the 400
 * THIRD_PARTY_AUTH_UNAVAILABLE path (a third-party-linked admin is still
 * rejected); other tests don't depend on these values being set.
 */
const enableGoogleOAuth = async () => {
  await crowi.getConfigService().saveConfig('crowi', {
    'google:clientId': 'test-google-client-id',
    'google:clientSecret': 'test-google-client-secret',
  });
};

const disableThirdPartyOAuth = async () => {
  await crowi.getConfigService().saveConfig('crowi', {
    'google:clientId': '',
    'google:clientSecret': '',
    'github:clientId': '',
    'github:clientSecret': '',
  });
};

describe('Routes /api/admin/auth (Hono)', () => {
  let adminToken: string;
  let adminWithGoogleToken: string;
  let userToken: string;

  beforeAll(async () => {
    const admin = await createTestUser({
      name: 'Auth Admin',
      username: 'authAdmin',
      email: 'auth-admin@example.com',
      admin: true,
    });
    adminToken = admin.accessToken;

    const adminWithGoogle = await createTestUser({
      name: 'Auth Admin With Google',
      username: 'authAdminGoogle',
      email: 'auth-admin-google@example.com',
      admin: true,
      googleId: 'google-test-id-123',
    });
    adminWithGoogleToken = adminWithGoogle.accessToken;

    const normal = await createTestUser({
      name: 'Auth Normal',
      username: 'authNormal',
      email: 'auth-normal@example.com',
      admin: false,
    });
    userToken = normal.accessToken;
  });

  beforeEach(async () => {
    await resetAuthConfig();
    await disableThirdPartyOAuth();
  });

  describe('GET /api/admin/auth', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/admin/auth');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 403 for a non-admin user', async () => {
      const res = await request(app).get('/api/admin/auth').set(authHeaders(userToken));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ADMIN_REQUIRED');
    });

    it('returns the current auth:* settings (defaults) for an admin', async () => {
      const res = await request(app).get('/api/admin/auth').set(authHeaders(adminToken));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        requireThirdPartyAuth: false,
        disablePasswordAuth: false,
      });
    });

    it('reflects values previously written via configService', async () => {
      await crowi.getConfigService().saveConfig('crowi', {
        'auth:requireThirdPartyAuth': true,
        'auth:disablePasswordAuth': false,
      });

      const res = await request(app).get('/api/admin/auth').set(authHeaders(adminToken));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        requireThirdPartyAuth: true,
        disablePasswordAuth: false,
      });
    });
  });

  describe('PUT /api/admin/auth', () => {
    // The only body the endpoint now accepts: both third-party-dependent
    // settings off. Enabling either is rejected (400) because third-party
    // sign-in was removed from core.
    const validBody = {
      requireThirdPartyAuth: false,
      disablePasswordAuth: false,
    };

    it('returns 401 without auth', async () => {
      const res = await request(app).put('/api/admin/auth').send(validBody);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 403 for a non-admin user', async () => {
      const res = await request(app).put('/api/admin/auth').set(authHeaders(userToken)).send(validBody);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ADMIN_REQUIRED');
    });

    it('returns 400 when requireThirdPartyAuth is not a boolean', async () => {
      const res = await request(app)
        .put('/api/admin/auth')
        .set(authHeaders(adminToken))
        .send({
          ...validBody,
          requireThirdPartyAuth: 'yes',
        });
      expect(res.status).toBe(400);
    });

    it('returns 400 when disablePasswordAuth is missing', async () => {
      const res = await request(app).put('/api/admin/auth').set(authHeaders(adminToken)).send({
        requireThirdPartyAuth: true,
      });
      expect(res.status).toBe(400);
    });

    it('persists the two auth:* keys (both off) and returns the updated settings', async () => {
      const res = await request(app).put('/api/admin/auth').set(authHeaders(adminToken)).send({
        requireThirdPartyAuth: false,
        disablePasswordAuth: false,
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        requireThirdPartyAuth: false,
        disablePasswordAuth: false,
      });

      // Round-trip via GET to verify the in-memory cache and the persisted
      // values are in sync.
      const getRes = await request(app).get('/api/admin/auth').set(authHeaders(adminToken));
      expect(getRes.status).toBe(200);
      expect(getRes.body.requireThirdPartyAuth).toBe(false);
      expect(getRes.body.disablePasswordAuth).toBe(false);
    });

    it('returns 400 when disablePasswordAuth is enabled (third-party sign-in removed from core)', async () => {
      // Third-party (Google / GitHub) sign-in was removed from core, so
      // hasValidThirdPartyId() is permanently false. The endpoint hard-rejects
      // turning on either third-party-dependent setting to prevent a lockout.
      const res = await request(app).put('/api/admin/auth').set(authHeaders(adminToken)).send({
        requireThirdPartyAuth: false,
        disablePasswordAuth: true,
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('THIRD_PARTY_AUTH_UNAVAILABLE');
      expect(typeof res.body.error.message).toBe('string');
      expect(res.body.error.message.length).toBeGreaterThan(0);

      // The config should not have been written.
      const cfg = crowi.getConfig();
      expect(cfg.crowi['auth:disablePasswordAuth']).toBe(false);
    });

    it('returns 400 when requireThirdPartyAuth is enabled (third-party sign-in removed from core)', async () => {
      const res = await request(app).put('/api/admin/auth').set(authHeaders(adminToken)).send({
        requireThirdPartyAuth: true,
        disablePasswordAuth: false,
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('THIRD_PARTY_AUTH_UNAVAILABLE');

      const cfg = crowi.getConfig();
      expect(cfg.crowi['auth:requireThirdPartyAuth']).toBe(false);
    });

    it('rejects enabling these settings even for an admin with a connected third-party identity', async () => {
      // The guard is now unconditional: it no longer depends on the acting
      // admin's third-party connection, because third-party sign-in is gone.
      await enableGoogleOAuth();

      const res = await request(app).put('/api/admin/auth').set(authHeaders(adminWithGoogleToken)).send({
        requireThirdPartyAuth: true,
        disablePasswordAuth: true,
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('THIRD_PARTY_AUTH_UNAVAILABLE');
    });

    it('does not touch unrelated keys in the crowi namespace', async () => {
      // Seed an unrelated config value first.
      await crowi.getConfigService().saveConfig('crowi', {
        'app:title': 'Custom Crowi Title',
      });

      const res = await request(app).put('/api/admin/auth').set(authHeaders(adminToken)).send(validBody);
      expect(res.status).toBe(200);

      const cfg = crowi.getConfig();
      expect(cfg.crowi['app:title']).toBe('Custom Crowi Title');
      expect(cfg.crowi['auth:requireThirdPartyAuth']).toBe(false);
    });
  });
});
