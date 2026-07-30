/**
 * RFC-0013 Phase 0 — smoke test for plugin-contributed HTTP routes.
 *
 * Drives a synthetic plugin's `registerRoutes` through the real
 * `buildHonoApp` so the full path — `makePluginRouterScope` mount,
 * per-path `createJwtAuth` install, raw-body delivery — is exercised
 * end-to-end against the same Hono dispatch the production server uses.
 *
 * The shared harness (`src/test/setup`) boots one Crowi + Hono app per
 * file from the *real* loaded plugins, so we cannot inject a test plugin
 * into it. Instead we stub `getLoadedPlugins()` to return our synthetic
 * plugin and build a throwaway app with `buildHonoApp(crowi)` — the stub
 * is restored after each test, so the shared `app` is untouched.
 *
 * Covers the Phase 0 acceptance criteria:
 *   (a) a trivial plugin route answers at
 *       `/api/plugins/<name>/<path>` (200) and the `<name>` segment
 *       isolates two plugins that mount the same sub-path.
 *   (b) an `auth: 'public'` route is reachable unauthenticated; a
 *       `'user'` (default) route is 401 without a JWT and 200 with one.
 *   (c) a public route handler reads the exact raw body via
 *       `c.req.text()` (no body-consuming validator ran ahead of it).
 *   (d) the existing real plugins (storage/mail/renderer/search) still
 *       boot — implicitly covered by the shared harness building the real
 *       app in `beforeAll` without error (every other suite relies on it).
 *
 * Also covers the route authz-tiers feature (feature-plugin-route-authz-tiers):
 *   (e) an `auth: 'admin'` route is 403 (`ADMIN_REQUIRED`) for a non-admin
 *       authenticated user and 200 for an admin.
 *   (f) the real `@crowi/plugin-slack` plugin's `POST /manifest` route is
 *       gated behind `auth: 'admin'` end-to-end (AC-4).
 */
import type { CrowiPlugin } from '@crowi/plugin-api';
import slackPlugin from '@crowi/plugin-slack';
import { getRequestListener } from '@hono/node-server';
import type { IncomingMessage, ServerResponse } from 'node:http';
import request from 'supertest';

import { crowi, Fixture } from 'src/test/setup';
import { authHeaders, createTestUser } from 'src/test/test-helpers';
import { buildHonoApp } from 'src/hono';
import { stripApiPrefix } from 'src/hono/path-rewrite';
import type { UserDocument } from 'src/models/user';
import { createJwtUtil } from 'src/util/jwt';

/**
 * Build a Node `RequestListener` over a Hono app assembled from
 * `plugins` (instead of the real loaded set). Mirrors the harness's own
 * `/api` prefix strip so supertest can dial `/api/...`.
 */
const buildAppFromPlugins = (plugins: CrowiPlugin[]): ((req: IncomingMessage, res: ServerResponse) => void) => {
  const manager = crowi.pluginManager;
  if (!manager) throw new Error('PluginManager not bootstrapped in harness');
  const spy = jest.spyOn(manager, 'getLoadedPlugins').mockReturnValue(plugins);
  try {
    const honoApp = buildHonoApp(crowi);
    return getRequestListener((req: Request) => honoApp.fetch(stripApiPrefix(req)));
  } finally {
    // The plugins are already captured inside the built app's closures;
    // restoring the spy here keeps the shared `crowi` pristine.
    spy.mockRestore();
  }
};

describe('plugin HTTP routes (registerRoutes)', () => {
  let user: UserDocument;
  let webToken: string;

  beforeAll(async () => {
    const User = crowi.model('User');
    const [u] = await Fixture.generate('User', [{ name: 'Plugin Route Tester', username: 'pluginRouteTester', email: 'plugin-route@example.com' }]);
    u.status = User.STATUS_ACTIVE;
    await u.save();
    user = u as UserDocument;
    webToken = createJwtUtil(crowi).generateTokens(user).accessToken;
  });

  afterAll(async () => {
    await crowi.model('User').deleteMany({
      email: {
        $in: [
          'plugin-route@example.com',
          'plugin-route-non-admin@example.com',
          'plugin-route-admin@example.com',
          'slack-manifest-non-admin@example.com',
          'slack-manifest-admin@example.com',
        ],
      },
    });
  });

  it('mounts a public route at /api/plugins/<name>/<path> reachable unauthenticated', async () => {
    const plugin: CrowiPlugin = {
      name: '@crowi/plugin-smoke',
      version: '0.0.0',
      registerRoutes: (scope) => {
        scope.route('GET', '/ping', (c) => c.json({ pong: true }), { auth: 'public' });
      },
    };
    const app = buildAppFromPlugins([plugin]);

    const res = await request(app).get('/api/plugins/@crowi/plugin-smoke/ping');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pong: true });
  });

  it('isolates two plugins mounting the same sub-path by the <name> segment', async () => {
    const makePlugin = (name: string, marker: string): CrowiPlugin => ({
      name,
      version: '0.0.0',
      registerRoutes: (scope) => {
        scope.route('GET', '/who', (c) => c.json({ marker }), { auth: 'public' });
      },
    });
    const app = buildAppFromPlugins([makePlugin('@crowi/plugin-a', 'A'), makePlugin('@crowi/plugin-b', 'B')]);

    const resA = await request(app).get('/api/plugins/@crowi/plugin-a/who');
    const resB = await request(app).get('/api/plugins/@crowi/plugin-b/who');
    expect(resA.body).toEqual({ marker: 'A' });
    expect(resB.body).toEqual({ marker: 'B' });
  });

  it('gates a non-public route behind JWT: 401 without a token, 200 with one', async () => {
    const plugin: CrowiPlugin = {
      name: '@crowi/plugin-authed',
      version: '0.0.0',
      registerRoutes: (scope) => {
        // No opts → authed. The handler echoes the authenticated user so
        // we know `createJwtAuth` ran and populated `c.get('user')`.
        scope.route('GET', '/secret', (c) => c.json({ userId: c.get('user')._id.toString() }));
      },
    };
    const app = buildAppFromPlugins([plugin]);

    const unauth = await request(app).get('/api/plugins/@crowi/plugin-authed/secret');
    expect(unauth.status).toBe(401);
    expect(unauth.body.error?.code).toBe('AUTHENTICATION_REQUIRED');

    const authed = await request(app).get('/api/plugins/@crowi/plugin-authed/secret').set('Authorization', `Bearer ${webToken}`);
    expect(authed.status).toBe(200);
    expect(authed.body.userId).toBe(user._id.toString());
  });

  it('delivers the exact raw body to a public POST handler (c.req.text())', async () => {
    // The Slack signature check hashes the raw bytes, so the handler must
    // see them verbatim — no validator may have consumed the stream.
    const rawBody = '{"type":"url_verification","challenge":"abc 123 + & = \\u00e9"}';
    const plugin: CrowiPlugin = {
      name: '@crowi/plugin-rawbody',
      version: '0.0.0',
      registerRoutes: (scope) => {
        scope.route(
          'POST',
          '/events',
          async (c) => {
            const text = await c.req.text();
            return c.json({ received: text, length: text.length });
          },
          { auth: 'public' },
        );
      },
    };
    const app = buildAppFromPlugins([plugin]);

    const res = await request(app).post('/api/plugins/@crowi/plugin-rawbody/events').set('Content-Type', 'application/json').send(rawBody);
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(rawBody);
    expect(res.body.length).toBe(rawBody.length);
  });

  it("gates an auth: 'admin' route: 401 without a token, 403 for a non-admin user, 200 for an admin", async () => {
    const plugin: CrowiPlugin = {
      name: '@crowi/plugin-adminonly',
      version: '0.0.0',
      registerRoutes: (scope) => {
        scope.route('GET', '/danger', (c) => c.json({ userId: c.get('user')._id.toString() }), { auth: 'admin' });
      },
    };
    const app = buildAppFromPlugins([plugin]);
    const { accessToken: nonAdminToken } = await createTestUser({
      name: 'Plugin Route Non Admin',
      username: 'pluginRouteNonAdmin',
      email: 'plugin-route-non-admin@example.com',
      admin: false,
    });
    const { user: adminUser, accessToken: adminToken } = await createTestUser({
      name: 'Plugin Route Admin',
      username: 'pluginRouteAdmin',
      email: 'plugin-route-admin@example.com',
      admin: true,
    });

    const unauth = await request(app).get('/api/plugins/@crowi/plugin-adminonly/danger');
    expect(unauth.status).toBe(401);
    expect(unauth.body.error?.code).toBe('AUTHENTICATION_REQUIRED');

    const nonAdmin = await request(app).get('/api/plugins/@crowi/plugin-adminonly/danger').set(authHeaders(nonAdminToken));
    expect(nonAdmin.status).toBe(403);
    expect(nonAdmin.body.error?.code).toBe('ADMIN_REQUIRED');

    const admin = await request(app).get('/api/plugins/@crowi/plugin-adminonly/danger').set(authHeaders(adminToken));
    expect(admin.status).toBe(200);
    expect(admin.body.userId).toBe(adminUser._id.toString());
  });

  describe('feature-plugin-registration-isolation AC-5: a throwing registerRoutes is isolated per-plugin', () => {
    afterEach(jest.restoreAllMocks);

    it("does not prevent another plugin's routes or a non-plugin route from mounting, and logs the failure", async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const broken: CrowiPlugin = {
        name: '@crowi/plugin-broken-routes',
        version: '0.0.0',
        registerRoutes: () => {
          throw new Error('registerRoutes exploded');
        },
      };
      const healthy: CrowiPlugin = {
        name: '@crowi/plugin-healthy-routes',
        version: '0.0.0',
        registerRoutes: (scope) => {
          scope.route('GET', '/ok', (c) => c.json({ ok: true }), { auth: 'public' });
        },
      };

      // Building the app itself must not throw, even though `broken`'s
      // `registerRoutes` throws synchronously during the mount loop — this
      // is the crux of AC-5 (pre-fix, this would propagate out of
      // `buildHonoApp` and take the whole boot down with it).
      const app = buildAppFromPlugins([broken, healthy]);

      const healthyRes = await request(app).get('/api/plugins/@crowi/plugin-healthy-routes/ok');
      expect(healthyRes.status).toBe(200);
      expect(healthyRes.body).toEqual({ ok: true });

      // A non-plugin route registered *after* `mountPluginRoutes` in
      // `buildHonoApp` still responds — proof the whole chain kept building
      // past the broken plugin.
      const nonPluginRes = await request(app).get('/api/app/info');
      expect(nonPluginRes.status).toBe(200);

      expect(consoleSpy).toHaveBeenCalledWith(
        "[crowi:plugin:@crowi/plugin-broken-routes] registerRoutes failed; this plugin's HTTP routes are not mounted: registerRoutes exploded",
      );
    });
  });

  describe('AC-4: @crowi/plugin-slack POST /manifest is admin-gated', () => {
    it('returns 403 (ADMIN_REQUIRED) for a non-admin authenticated user', async () => {
      const app = buildAppFromPlugins([slackPlugin]);
      const { accessToken: nonAdminToken } = await createTestUser({
        name: 'Slack Manifest Non Admin',
        username: 'slackManifestNonAdmin',
        email: 'slack-manifest-non-admin@example.com',
        admin: false,
      });

      const res = await request(app).post('/api/plugins/@crowi/plugin-slack/manifest').set(authHeaders(nonAdminToken)).send({});

      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('ADMIN_REQUIRED');
    });

    it('returns 200 with the manifest JSON for an admin user', async () => {
      const app = buildAppFromPlugins([slackPlugin]);
      const { accessToken: adminToken } = await createTestUser({
        name: 'Slack Manifest Admin',
        username: 'slackManifestAdmin',
        email: 'slack-manifest-admin@example.com',
        admin: true,
      });

      const res = await request(app).post('/api/plugins/@crowi/plugin-slack/manifest').set(authHeaders(adminToken)).send({});

      expect(res.status).toBe(200);
      expect(typeof res.body.settings?.event_subscriptions?.request_url).toBe('string');
    });
  });
});
