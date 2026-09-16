/**
 * feature-html-artifact-write-path AC-AI-16 — pure-data assertions over the
 * `page` contract's RFC-0020 write-path additions: create/update declare the
 * `x-crowi-page-content-type` header, revert does not, and the 400/413/422/
 * 500 response union (plus update's existing 409) is registered on the
 * right routes. Run with `node --test` (built-in runner), matching
 * `contracts/admin/index.test.ts` — pure-data over `createRoute(...)`
 * output needs no jest/vitest dependency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createPageRoute, revertToRevisionRoute, updatePageRoute } from './page';

describe('page write contracts (RFC-0020)', () => {
  it('createPageRoute declares the x-crowi-page-content-type header', () => {
    const headers = createPageRoute.request.headers;
    assert.ok(headers, 'createPageRoute.request.headers is not declared');
    assert.ok('x-crowi-page-content-type' in headers.shape, 'createPageRoute is missing the x-crowi-page-content-type header');
  });

  it('updatePageRoute declares the x-crowi-page-content-type header', () => {
    const headers = updatePageRoute.request.headers;
    assert.ok(headers, 'updatePageRoute.request.headers is not declared');
    assert.ok('x-crowi-page-content-type' in headers.shape, 'updatePageRoute is missing the x-crowi-page-content-type header');
  });

  it('revertToRevisionRoute does NOT declare the x-crowi-page-content-type header', () => {
    assert.ok(
      !('headers' in revertToRevisionRoute.request),
      'revertToRevisionRoute must not accept a content-type header — it re-derives kind from the target Revision',
    );
  });

  const expectedStatuses = ['400', '413', '422', '500'];

  for (const [name, route] of [
    ['createPageRoute', createPageRoute],
    ['updatePageRoute', updatePageRoute],
    ['revertToRevisionRoute', revertToRevisionRoute],
  ] as const) {
    it(`${name} registers 400/413/422/500 responses`, () => {
      for (const status of expectedStatuses) {
        assert.ok(status in route.responses, `${name} is missing a ${status} response`);
      }
    });
  }

  it('409 is registered only on updatePageRoute (stale revision_id), not create/revert', () => {
    assert.ok('409' in updatePageRoute.responses, 'updatePageRoute is missing its existing 409 (stale revision_id)');
    assert.ok(!('409' in createPageRoute.responses), 'createPageRoute must not declare a 409 — 422 covers delivery-not-configured');
    assert.ok(!('409' in revertToRevisionRoute.responses), 'revertToRevisionRoute must not declare a 409 — 422 covers delivery-not-configured');
  });
});
