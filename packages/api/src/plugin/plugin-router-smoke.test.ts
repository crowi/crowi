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
 *       `/api/v2/plugins/<name>/<path>` (200) and the `<name>` segment
 *       isolates two plugins that mount the same sub-path.
 *   (b) a `public: true` route is reachable unauthenticated; a
 *       non-public route is 401 without a JWT and 200 with one.
 *   (c) a public route handler reads the exact raw body via
 *       `c.req.text()` (no body-consuming validator ran ahead of it).
 *   (d) the existing real plugins (storage/mail/renderer/search) still
 *       boot — implicitly covered by the shared harness building the real
 *       app in `beforeAll` without error (every other suite relies on it).
 */
import type { CrowiPlugin } from '@crowi/plugin-api';
import { getRequestListener } from '@hono/node-server';
import type { IncomingMessage, ServerResponse } from 'node:http';
import request from 'supertest';

import { crowi, Fixture } from 'src/test/setup';
import { buildHonoApp } from 'src/hono';
import { stripApiV2Prefix } from 'src/hono/path-rewrite';
import type { UserDocument } from 'src/models/user';
import { createJwtUtil } from 'src/util/jwt';

/**
 * Build a Node `RequestListener` over a Hono app assembled from
 * `plugins` (instead of the real loaded set). Mirrors the harness's own
 * `/api/v2` prefix strip so supertest can dial `/api/v2/...`.
 */
const buildAppFromPlugins = (plugins: CrowiPlugin[]): ((req: IncomingMessage, res: ServerResponse) => void) => {
  const manager = crowi.pluginManager;
  if (!manager) throw new Error('PluginManager not bootstrapped in harness');
  const spy = jest.spyOn(manager, 'getLoadedPlugins').mockReturnValue(plugins);
  try {
    const honoApp = buildHonoApp(crowi);
    return getRequestListener((req: Request) => honoApp.fetch(stripApiV2Prefix(req)));
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
    await crowi.model('User').deleteMany({ email: 'plugin-route@example.com' });
  });

  it('mounts a public route at /api/v2/plugins/<name>/<path> reachable unauthenticated', async () => {
    const plugin: CrowiPlugin = {
      name: '@crowi/plugin-smoke',
      version: '0.0.0',
      registerRoutes: (scope) => {
        scope.route('GET', '/ping', (c) => c.json({ pong: true }), { public: true });
      },
    };
    const app = buildAppFromPlugins([plugin]);

    const res = await request(app).get('/api/v2/plugins/@crowi/plugin-smoke/ping');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pong: true });
  });

  it('isolates two plugins mounting the same sub-path by the <name> segment', async () => {
    const makePlugin = (name: string, marker: string): CrowiPlugin => ({
      name,
      version: '0.0.0',
      registerRoutes: (scope) => {
        scope.route('GET', '/who', (c) => c.json({ marker }), { public: true });
      },
    });
    const app = buildAppFromPlugins([makePlugin('@crowi/plugin-a', 'A'), makePlugin('@crowi/plugin-b', 'B')]);

    const resA = await request(app).get('/api/v2/plugins/@crowi/plugin-a/who');
    const resB = await request(app).get('/api/v2/plugins/@crowi/plugin-b/who');
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

    const unauth = await request(app).get('/api/v2/plugins/@crowi/plugin-authed/secret');
    expect(unauth.status).toBe(401);
    expect(unauth.body.error?.code).toBe('AUTHENTICATION_REQUIRED');

    const authed = await request(app).get('/api/v2/plugins/@crowi/plugin-authed/secret').set('Authorization', `Bearer ${webToken}`);
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
          { public: true },
        );
      },
    };
    const app = buildAppFromPlugins([plugin]);

    const res = await request(app).post('/api/v2/plugins/@crowi/plugin-rawbody/events').set('Content-Type', 'application/json').send(rawBody);
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(rawBody);
    expect(res.body.length).toBe(rawBody.length);
  });
});
