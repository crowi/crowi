/**
 * Unit test for `PageSchema` (feature-page-relations-collections AC-2).
 * Run with `node --test` (built-in runner) — no jest dep, matching the
 * sibling `schemas/username.test.ts`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PageSchema } from './page';

const basePage = {
  _id: '000000000000000000000001',
  path: '/foo',
  commentCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  likerCount: 0,
  seenUsersCount: 0,
  isLiked: false,
};

describe('schemas/page', () => {
  describe('PageSchema', () => {
    it('accepts a Page carrying the required likerCount / seenUsersCount / isLiked fields', () => {
      const result = PageSchema.safeParse(basePage);
      assert.equal(result.success, true);
    });

    it('rejects a Page missing likerCount', () => {
      const { likerCount: _likerCount, ...rest } = basePage;
      const result = PageSchema.safeParse(rest);
      assert.equal(result.success, false);
    });

    it('rejects a Page missing seenUsersCount', () => {
      const { seenUsersCount: _seenUsersCount, ...rest } = basePage;
      const result = PageSchema.safeParse(rest);
      assert.equal(result.success, false);
    });

    it('rejects a Page missing isLiked', () => {
      const { isLiked: _isLiked, ...rest } = basePage;
      const result = PageSchema.safeParse(rest);
      assert.equal(result.success, false);
    });

    it('rejects a negative likerCount', () => {
      const result = PageSchema.safeParse({ ...basePage, likerCount: -1 });
      assert.equal(result.success, false);
    });

    it('rejects a non-integer seenUsersCount', () => {
      const result = PageSchema.safeParse({ ...basePage, seenUsersCount: 1.5 });
      assert.equal(result.success, false);
    });

    it('strips an incoming liker array field — it is not part of the schema (C-API)', () => {
      const result = PageSchema.safeParse({ ...basePage, liker: ['000000000000000000000002'] });
      assert.equal(result.success, true);
      if (result.success) {
        assert.equal('liker' in result.data, false);
      }
    });
  });
});
