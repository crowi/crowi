/**
 * RFC-0006 Phase 4 Batch 9 — admin path-prefix smoke test (RFC open
 * question 4). Asserts every admin route path begins with `/admin/`.
 * Failing this is a sign that an admin sub-contract was edited and the
 * `/admin/<sub>` prefix was accidentally dropped — that would route
 * the endpoint into an unrelated handler family at runtime and bypass
 * the `createJwtAdminRequired` install.
 *
 * Run with `node --test` (built-in test runner) — no jest / vitest dep
 * needed because the assertion is pure-data.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { adminAppRoutes } from './app';
import { adminAuthRoutes } from './auth';
import { adminMailRoutes } from './mail';
import { adminPluginsRoutes } from './plugins';
import { adminSearchRoutes } from './search';
import { adminSecurityRoutes } from './security';
import { adminStorageRoutes } from './storage';
import { adminUsersRoutes } from './users';

const allAdminRoutes = [
  ...Object.entries(adminAppRoutes),
  ...Object.entries(adminAuthRoutes),
  ...Object.entries(adminSecurityRoutes),
  ...Object.entries(adminMailRoutes),
  ...Object.entries(adminStorageRoutes),
  ...Object.entries(adminSearchRoutes),
  ...Object.entries(adminUsersRoutes),
  ...Object.entries(adminPluginsRoutes),
];

describe('admin contract path prefix', () => {
  it('every admin route path starts with /admin/', () => {
    for (const [name, route] of allAdminRoutes) {
      assert.ok(route.path.startsWith('/admin/'), `Route ${name} has path "${route.path}" which does not start with "/admin/"`);
    }
  });

  it('every admin route declares a method', () => {
    for (const [name, route] of allAdminRoutes) {
      assert.ok(typeof route.method === 'string' && route.method.length > 0, `Route ${name} is missing a method declaration`);
    }
  });
});
