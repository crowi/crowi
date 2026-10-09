/**
 * Pure-data assertions over the
 * `page` contract's RFC-0020 write-path additions: create/update declare the
 * `x-crowi-page-content-type` header, revert does not, and the 400/413/422/
 * 500 response union (plus update's existing 409) is registered on the
 * right routes. Run with `node --test` (built-in runner), matching
 * `contracts/admin/index.test.ts` — pure-data over `createRoute(...)`
 * output needs no jest/vitest dependency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createPageRoute, listPagesRoute, revertToRevisionRoute, updatePageRoute } from './page';

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

  for (const [name, route] of [
    ['createPageRoute', createPageRoute],
    ['updatePageRoute', updatePageRoute],
    ['revertToRevisionRoute', revertToRevisionRoute],
  ] as const) {
    it(`AC-AAG-5 ${name} 400 client schema keeps diagnosticCode / reason / ruleId / target`, () => {
      const response = route.responses['400'];
      const schema = response.content['application/json'].schema;
      const body = {
        error: {
          code: 'ARTIFACT_WRITE_REJECTED',
          reason: 'EXTERNAL_REFERENCE',
          ruleId: 'AI-R11',
          diagnosticCode: 'PAGE_LINK_RESERVED_ROUTE',
          message: 'fixed',
          target: 'a[href]',
          extra: 'dropped',
        },
      };
      const parsed = schema.safeParse(body);
      assert.equal(parsed.success, true);
      const { extra: _extra, ...kept } = body.error;
      assert.deepEqual(parsed.data, { error: kept });

      const generic = schema.safeParse({ error: { code: 'VALIDATION_ERROR', message: 'bad' } });
      assert.equal(generic.success, true);
    });
  }

  it('409 is registered only on updatePageRoute (stale revision_id), not create/revert', () => {
    assert.ok('409' in updatePageRoute.responses, 'updatePageRoute is missing its existing 409 (stale revision_id)');
    assert.ok(!('409' in createPageRoute.responses), 'createPageRoute must not declare a 409 — 422 covers delivery-not-configured');
    assert.ok(!('409' in revertToRevisionRoute.responses), 'revertToRevisionRoute must not declare a 409 — 422 covers delivery-not-configured');
  });
});

describe('listPagesRoute contract', () => {
  it('declares the path_prefix query and appliedPathPrefix response fields', () => {
    const query = listPagesRoute.request.query;
    assert.ok(query && 'shape' in query && 'path_prefix' in (query as { shape: object }).shape, 'path_prefix query missing');
    const ok = listPagesRoute.responses[200];
    const schema = 'content' in ok ? ok.content?.['application/json']?.schema : undefined;
    assert.ok(schema && 'shape' in schema && 'appliedPathPrefix' in (schema as { shape: object }).shape, 'appliedPathPrefix missing');
  });

  it('declares 400/401/403/500', () => {
    for (const status of ['400', '401', '403', '500']) {
      assert.ok(status in listPagesRoute.responses, `listPagesRoute is missing ${status}`);
    }
  });
});
