import { describe, expect, it } from 'vitest';
import { diffNewCommentIds } from './comment-highlight';

/**
 * feature-live-page-comment-sync — seen-set diff that decides which
 * comments get the transient new-comment highlight. The invariants the
 * component relies on: first-load suppression, idempotent re-delivery
 * (origin double-send), and retention of deleted ids.
 */
describe('diffNewCommentIds', () => {
  it('highlights nothing on the first load and seeds every id as seen', () => {
    const { newIds, nextSeen } = diffNewCommentIds(null, ['a', 'b', 'c']);
    expect(newIds).toEqual([]);
    expect([...nextSeen].sort()).toEqual(['a', 'b', 'c']);
  });

  it('returns only ids not previously seen and folds them into the seen set', () => {
    const prev = new Set(['a', 'b']);
    const { newIds, nextSeen } = diffNewCommentIds(prev, ['a', 'b', 'c', 'd']);
    expect(newIds).toEqual(['c', 'd']);
    expect([...nextSeen].sort()).toEqual(['a', 'b', 'c', 'd']);
    // The input set is not mutated.
    expect([...prev].sort()).toEqual(['a', 'b']);
  });

  it('is idempotent under a repeat delivery of the same id list (origin double-send)', () => {
    const prev = new Set(['a', 'b']);
    const first = diffNewCommentIds(prev, ['a', 'b', 'c']);
    expect(first.newIds).toEqual(['c']);
    // Second delivery of the identical list yields no new id.
    const second = diffNewCommentIds(first.nextSeen, ['a', 'b', 'c']);
    expect(second.newIds).toEqual([]);
  });

  it('does not re-highlight an existing comment after another one is removed', () => {
    const prev = new Set(['a', 'b', 'c']);
    // 'b' was deleted — the remaining list is a subset of the seen set.
    const { newIds, nextSeen } = diffNewCommentIds(prev, ['a', 'c']);
    expect(newIds).toEqual([]);
    // Deleted ids are retained (harmless — highlight only keys off newIds).
    expect(nextSeen.has('b')).toBe(true);
  });

  it('highlights a re-added id that had been removed from the list but stayed in the seen set', () => {
    // Because deleted ids are retained, a genuinely different new id is
    // still detected while a churned one is not — the seen set is the
    // single source of truth.
    const prev = new Set(['a', 'b']);
    const { newIds } = diffNewCommentIds(prev, ['a', 'b', 'e']);
    expect(newIds).toEqual(['e']);
  });

  it('does not highlight the reader own comment but still folds it into the seen set (AC#4)', () => {
    // The reader posted 'c'; their add-mutation re-fetched the list, so
    // 'c' surfaces as newly seen. Author-keyed suppression must keep it
    // out of newIds while still marking it seen so a later presence
    // re-delivery of the same list never re-examines it.
    const prev = new Set(['a', 'b']);
    const { newIds, nextSeen } = diffNewCommentIds(prev, ['a', 'b', 'c'], new Set(['c']));
    expect(newIds).toEqual([]);
    expect(nextSeen.has('c')).toBe(true);
  });

  it('highlights another user comment while suppressing the reader own in the same batch', () => {
    // A mixed batch: 'c' is the reader's own (suppressed), 'd' is someone
    // else's (highlighted). Both are folded into the seen set.
    const prev = new Set(['a']);
    const { newIds, nextSeen } = diffNewCommentIds(prev, ['a', 'c', 'd'], new Set(['c']));
    expect(newIds).toEqual(['d']);
    expect([...nextSeen].sort()).toEqual(['a', 'c', 'd']);
  });

  it('does not re-highlight the reader own comment on a repeat delivery', () => {
    const prev = new Set(['a']);
    const first = diffNewCommentIds(prev, ['a', 'c'], new Set(['c']));
    expect(first.newIds).toEqual([]);
    // A second delivery (origin double-send) with the same own-id set is
    // still silent.
    const second = diffNewCommentIds(first.nextSeen, ['a', 'c'], new Set(['c']));
    expect(second.newIds).toEqual([]);
  });
});
