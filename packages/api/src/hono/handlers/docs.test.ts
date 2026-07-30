import request from 'supertest';
import { app } from 'src/test/setup';

/**
 * RFC-0006 Phase 6 — integration test for the docs endpoints mounted
 * by `buildHonoApp` (see `packages/api/src/hono/index.ts`).
 *
 * `GET /api/openapi.json` serves the live OpenAPI 3.1 document
 * derived from the running Hono chain. `GET /api/docs` serves the
 * Scalar API Reference UI which loads the JSON above via the CDN
 * standalone bundle. Both are public (no auth) so admins can hit
 * them on a fresh deploy without first logging in.
 */
describe('Hono docs endpoints', () => {
  describe('GET /api/openapi.json', () => {
    it('responds 200 with the OpenAPI 3.1 document', async () => {
      const res = await request(app).get('/api/openapi.json');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body.openapi).toBe('3.1.0');
      expect(res.body.info?.title).toBe('Crowi API');
      // The chain registered every resource in Phase 4 — paths must
      // not be empty.
      expect(Object.keys(res.body.paths ?? {}).length).toBeGreaterThan(0);
    });
  });

  describe('GET /api/docs', () => {
    it('responds 200 with HTML hosting the Scalar API Reference', async () => {
      const res = await request(app).get('/api/docs');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      // Scalar's standalone bundle is loaded via a script tag; the
      // page also embeds the `url` that points clients at the spec.
      expect(res.text).toContain('/api/openapi.json');
    });
  });
});
