/**
 * Unit test for the shared `UsernameSchema` contract
 * (feature-username-validation-contract). Run with `node --test` (built-in
 * runner) — no jest dep, matching the sibling `util/html-elements.test.ts`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UsernameSchema } from './username';

describe('schemas/username', () => {
  describe('UsernameSchema', () => {
    it('accepts a 1-character username (lower boundary)', () => {
      const result = UsernameSchema.safeParse('a');
      assert.equal(result.success, true);
    });

    it('accepts a 64-character username (upper boundary)', () => {
      const value = 'a'.repeat(64);
      const result = UsernameSchema.safeParse(value);
      assert.equal(result.success, true);
    });

    it('accepts letters, digits, underscore, and hyphen mixed', () => {
      const result = UsernameSchema.safeParse('Sotaro_Karasawa-99');
      assert.equal(result.success, true);
    });

    it('accepts every individual allowed character (A-Z, a-z, 0-9, _, -)', () => {
      const allowed = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
      for (const char of allowed) {
        assert.equal(UsernameSchema.safeParse(char).success, true, `expected '${char}' to be accepted`);
      }
    });

    it('rejects an empty string', () => {
      assert.equal(UsernameSchema.safeParse('').success, false);
    });

    it('rejects a whitespace-only string', () => {
      assert.equal(UsernameSchema.safeParse('   ').success, false);
    });

    it('rejects a value containing a dot', () => {
      assert.equal(UsernameSchema.safeParse('a.b').success, false);
    });

    it('rejects a value containing a slash', () => {
      assert.equal(UsernameSchema.safeParse('a/b').success, false);
    });

    it('rejects a Unicode character', () => {
      assert.equal(UsernameSchema.safeParse('ソタロウ').success, false);
      assert.equal(UsernameSchema.safeParse('café').success, false);
    });

    it('rejects a 65-character username (one over the upper boundary)', () => {
      assert.equal(UsernameSchema.safeParse('a'.repeat(65)).success, false);
    });

    it('does not transform a valid input (no trim / case-fold / normalization)', () => {
      const mixedCase = 'MixedCase_99-x';
      const result = UsernameSchema.safeParse(mixedCase);
      assert.equal(result.success, true);
      if (result.success) {
        assert.equal(result.data, mixedCase);
      }
    });

    it('does not silently trim leading/trailing whitespace around an otherwise-legal value', () => {
      // A padded value must be rejected outright, not trimmed then accepted.
      assert.equal(UsernameSchema.safeParse(' a ').success, false);
    });
  });
});
