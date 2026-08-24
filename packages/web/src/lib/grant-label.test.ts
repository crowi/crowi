import { PageGrantEnum } from '@crowi/api-contract';
import { describe, expect, it } from 'vitest';

import { grantLabel } from './grant-label';

describe('grantLabel', () => {
  it.each([
    [PageGrantEnum.PUBLIC, '公開'],
    [PageGrantEnum.RESTRICTED, 'リンクのみ'],
    [PageGrantEnum.SPECIFIED, '指定ユーザー'],
    [PageGrantEnum.OWNER, '自分のみ'],
  ])('returns the localized label for grant %s', (grant, expected) => {
    expect(grantLabel(grant)).toBe(expected);
  });

  it('returns null for an unknown grant', () => {
    expect(grantLabel(99)).toBeNull();
  });
});
