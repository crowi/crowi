import { describe, expect, it } from 'vitest';
import { buildPortalMetaChips } from './portal-meta-bar';

describe('buildPortalMetaChips', () => {
  it('always shows the comments chip (you can post the first one at 0)', () => {
    const chips = buildPortalMetaChips({ commentCount: 0, backlinkCount: 0, backlinkHasMore: false, attachmentCount: 0 });
    expect(chips).toEqual([{ key: 'comments', count: 0, more: false }]);
  });

  it('shows backlinks / attachments only when non-empty, in order', () => {
    const chips = buildPortalMetaChips({ commentCount: 3, backlinkCount: 2, backlinkHasMore: false, attachmentCount: 1 });
    expect(chips.map((c) => c.key)).toEqual(['comments', 'backlinks', 'attachments']);
    expect(chips).toContainEqual({ key: 'backlinks', count: 2, more: false });
    expect(chips).toContainEqual({ key: 'attachments', count: 1, more: false });
  });

  it('omits an empty backlinks / attachments chip', () => {
    const chips = buildPortalMetaChips({ commentCount: 1, backlinkCount: 0, backlinkHasMore: false, attachmentCount: 4 });
    expect(chips.map((c) => c.key)).toEqual(['comments', 'attachments']);
  });

  it('flags backlinks as "more" when the peek was capped', () => {
    const chips = buildPortalMetaChips({ commentCount: 0, backlinkCount: 5, backlinkHasMore: true, attachmentCount: 0 });
    expect(chips).toContainEqual({ key: 'backlinks', count: 5, more: true });
  });
});
