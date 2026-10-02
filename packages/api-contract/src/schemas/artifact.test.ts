/**
 * Unit test for `ArtifactNavigateMessageSchema`. Run with `node --test`
 * (built-in runner), like the sibling `schemas/page.test.ts`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ARTIFACT_NAVIGATE_MESSAGE_TYPE, ArtifactNavigateMessageSchema } from './artifact';

const base = { type: ARTIFACT_NAVIGATE_MESSAGE_TYPE, href: '/team/guide', disposition: 'same-tab' } as const;

describe('schemas/artifact', () => {
  describe('ArtifactNavigateMessageSchema', () => {
    it('accepts both dispositions', () => {
      assert.equal(ArtifactNavigateMessageSchema.safeParse(base).success, true);
      assert.equal(ArtifactNavigateMessageSchema.safeParse({ ...base, disposition: 'new-tab' }).success, true);
    });

    it('rejects unknown fields, including self-declared trust claims', () => {
      for (const extra of [{ isTrusted: true }, { activation: true }, { base: '/x' }, { timestamp: 1 }]) {
        assert.equal(ArtifactNavigateMessageSchema.safeParse({ ...base, ...extra }).success, false);
      }
    });

    it('rejects a wrong type, an unknown disposition and non-object payloads', () => {
      assert.equal(ArtifactNavigateMessageSchema.safeParse({ ...base, type: 'crowi:artifact-height' }).success, false);
      assert.equal(ArtifactNavigateMessageSchema.safeParse({ ...base, disposition: 'top' }).success, false);
      assert.equal(ArtifactNavigateMessageSchema.safeParse([base]).success, false);
      assert.equal(ArtifactNavigateMessageSchema.safeParse(null).success, false);
      assert.equal(ArtifactNavigateMessageSchema.safeParse('crowi:artifact-navigate').success, false);
    });

    it('bounds href to 1..4096 characters', () => {
      assert.equal(ArtifactNavigateMessageSchema.safeParse({ ...base, href: '' }).success, false);
      assert.equal(ArtifactNavigateMessageSchema.safeParse({ ...base, href: 'a'.repeat(4096) }).success, true);
      assert.equal(ArtifactNavigateMessageSchema.safeParse({ ...base, href: 'a'.repeat(4097) }).success, false);
      assert.equal(ArtifactNavigateMessageSchema.safeParse({ ...base, href: 1 }).success, false);
    });
  });
});
