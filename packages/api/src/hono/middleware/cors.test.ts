/**
 * RFC-0006 Phase 6 Sub-batch C — unit tests for the Hono port of the
 * Express `cors` middleware.
 *
 * The tests dial the built Hono app directly via `honoApp.fetch(...)`
 * instead of going through supertest, because the supertest path
 * traverses Express's own `cors()` apply (still installed in
 * `express-init.ts` until Sub-batch D), which would short-circuit
 * OPTIONS preflights before they reach Hono. Sub-batch D removes the
 * Express stack and the redundancy goes away.
 *
 * `buildHonoApp` returns the unprefixed chain (handlers register at
 * `/app/info`, `/pages/:id`, ...). The `/api` prefix is applied by
 * `createAdaptorServer` in production via the Express bridge in
 * `routes/index.ts`. We dial the unprefixed paths here so requests
 * actually reach a handler.
 *
 * The test harness boots Crowi with `BASE_URL=http://localhost:13001`,
 * so that origin is the canonical allow-listed value across these
 * cases.
 */
import { buildHonoApp } from 'src/hono';
import { crowi } from 'src/test/setup';

const BASE_ORIGIN = 'http://localhost:13001';

describe('Hono cors middleware', () => {
  describe('preflight (OPTIONS)', () => {
    it('responds with Access-Control-Allow-* headers for an allow-listed origin (baseUrl match)', async () => {
      const honoApp = buildHonoApp(crowi);
      const res = await honoApp.fetch(
        new Request(`${BASE_ORIGIN}/app/info`, {
          method: 'OPTIONS',
          headers: {
            Origin: BASE_ORIGIN,
            'Access-Control-Request-Method': 'GET',
            'Access-Control-Request-Headers': 'Authorization,Content-Type',
          },
        }),
      );

      // Hono's `cors` middleware returns 204 (or 200) for preflights;
      // accept either to keep the assertion robust against minor
      // upstream changes.
      expect([200, 204]).toContain(res.status);
      // Echoes the request origin (credentials require an exact origin,
      // not a wildcard).
      expect(res.headers.get('access-control-allow-origin')).toBe(BASE_ORIGIN);
      expect(res.headers.get('access-control-allow-credentials')).toBe('true');
      const allowMethods = res.headers.get('access-control-allow-methods') ?? '';
      expect(allowMethods).toContain('GET');
      expect(allowMethods).toContain('POST');
      expect(allowMethods).toContain('OPTIONS');
      const allowHeaders = res.headers.get('access-control-allow-headers') ?? '';
      expect(allowHeaders).toContain('Authorization');
      expect(allowHeaders).toContain('Content-Type');
    });

    it('rejects an unknown origin under non-development node_env (no allow-origin header emitted)', async () => {
      // The harness boots Crowi with `node_env` defaulting from
      // `NODE_ENV` (= `'test'` under jest), which is NOT
      // `'development'`, so the dev-mode "allow anything" fallback in
      // `buildOriginResolver` is inactive. Verify the resolver
      // rejects an off-list origin by header absence.
      const honoApp = buildHonoApp(crowi);
      const res = await honoApp.fetch(
        new Request(`${BASE_ORIGIN}/app/info`, {
          method: 'OPTIONS',
          headers: {
            Origin: 'http://evil.example.com',
            'Access-Control-Request-Method': 'GET',
          },
        }),
      );
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('allows a resolved federated-auth web origin distinct from CLIENT_URL/baseUrl (same-site split-origin)', async () => {
      // AUTH_PUBLIC_WEB_URL=https://wiki.example.com / AUTH_PUBLIC_API_URL=https://api.example.com,
      // with CLIENT_URL a different value (the harness's own http://localhost:13001) — production-relevant
      // because `node_env` under jest is 'test', not 'development' (see the rejection test above).
      const savedUrls = crowi.federatedAuthPublicUrls;
      crowi.federatedAuthPublicUrls = { apiUrl: 'https://api.example.com', webUrl: 'https://wiki.example.com' };
      try {
        const honoApp = buildHonoApp(crowi);
        const preflight = await honoApp.fetch(
          new Request(`${BASE_ORIGIN}/app/info`, {
            method: 'OPTIONS',
            headers: {
              Origin: 'https://wiki.example.com',
              'Access-Control-Request-Method': 'POST',
              'Access-Control-Request-Headers': 'Authorization,Content-Type',
            },
          }),
        );
        expect([200, 204]).toContain(preflight.status);
        expect(preflight.headers.get('access-control-allow-origin')).toBe('https://wiki.example.com');
        expect(preflight.headers.get('access-control-allow-credentials')).toBe('true');
        const allowMethods = preflight.headers.get('access-control-allow-methods') ?? '';
        expect(allowMethods).toContain('POST');

        const actual = await honoApp.fetch(
          new Request(`${BASE_ORIGIN}/app/info`, {
            method: 'GET',
            headers: { Origin: 'https://wiki.example.com' },
          }),
        );
        expect(actual.status).toBe(200);
        expect(actual.headers.get('access-control-allow-origin')).toBe('https://wiki.example.com');
        expect(actual.headers.get('access-control-allow-credentials')).toBe('true');
      } finally {
        crowi.federatedAuthPublicUrls = savedUrls;
      }
    });

    it('still rejects an unrelated third-party origin even with a federated-auth web origin resolved', async () => {
      const savedUrls = crowi.federatedAuthPublicUrls;
      crowi.federatedAuthPublicUrls = { apiUrl: 'https://api.example.com', webUrl: 'https://wiki.example.com' };
      try {
        const honoApp = buildHonoApp(crowi);
        const res = await honoApp.fetch(
          new Request(`${BASE_ORIGIN}/app/info`, {
            method: 'OPTIONS',
            headers: {
              Origin: 'http://evil.example.com',
              'Access-Control-Request-Method': 'POST',
            },
          }),
        );
        expect(res.headers.get('access-control-allow-origin')).toBeNull();
      } finally {
        crowi.federatedAuthPublicUrls = savedUrls;
      }
    });

    it('allows any localhost origin when node_env is development', async () => {
      // Build a fresh Hono app under a temporarily-flipped node_env
      // so the dev-mode localhost allow rule fires. Restore right
      // after so unrelated tests in the same worker are unaffected.
      const original = crowi.node_env;
      crowi.node_env = 'development';
      try {
        const devHonoApp = buildHonoApp(crowi);
        const res = await devHonoApp.fetch(
          new Request(`${BASE_ORIGIN}/app/info`, {
            method: 'OPTIONS',
            headers: {
              Origin: 'http://localhost:4302',
              'Access-Control-Request-Method': 'GET',
            },
          }),
        );
        expect([200, 204]).toContain(res.status);
        expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:4302');
      } finally {
        crowi.node_env = original;
      }
    });
  });

  describe('actual (non-preflight) request', () => {
    it('attaches Access-Control-Allow-Origin to the response for an allow-listed origin', async () => {
      const honoApp = buildHonoApp(crowi);
      const res = await honoApp.fetch(
        new Request(`${BASE_ORIGIN}/app/info`, {
          method: 'GET',
          headers: { Origin: BASE_ORIGIN },
        }),
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe(BASE_ORIGIN);
      expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    });

    it('serves requests without an Origin header (curl / server-to-server)', async () => {
      const honoApp = buildHonoApp(crowi);
      const res = await honoApp.fetch(new Request(`${BASE_ORIGIN}/app/info`, { method: 'GET' }));

      // The endpoint succeeds; no Access-Control-Allow-Origin is
      // emitted because the browser CORS check doesn't apply.
      expect(res.status).toBe(200);
    });
  });
});
