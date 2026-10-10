/**
 * Unit test for the `DraftSummarySchema.contentType` field. Run with `node --test`
 * (built-in runner), like the sibling `schemas/page.test.ts`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DraftSummarySchema, ListDraftsResponseSchema } from './draft';

const base = { pageId: 'p1', path: '/a', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };

describe('schemas/draft — DraftSummarySchema.contentType', () => {
  it('stays optional so a response from an older server still parses', () => {
    const parsed = DraftSummarySchema.safeParse(base);
    assert.equal(parsed.success, true);
    assert.equal(parsed.success && parsed.data.contentType, undefined);
  });

  it('accepts exactly the two content types', () => {
    for (const contentType of ['markdown', 'artifact'] as const) {
      const parsed = DraftSummarySchema.safeParse({ ...base, contentType });
      assert.equal(parsed.success && parsed.data.contentType, contentType);
    }
  });

  it('rejects an unknown or non-string content type', () => {
    for (const contentType of ['html', 'Markdown', '', null, 1]) {
      assert.equal(DraftSummarySchema.safeParse({ ...base, contentType }).success, false);
    }
  });

  it('is carried through the list response rows', () => {
    const parsed = ListDraftsResponseSchema.safeParse({ drafts: [{ ...base, contentType: 'artifact' }, base] });
    assert.equal(parsed.success, true);
  });
});
