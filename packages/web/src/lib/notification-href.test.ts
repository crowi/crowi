import { describe, expect, it } from 'vitest';
import { NotificationActionEnum } from '@crowi/api-contract';
import { resolveNotificationHref } from './notification-href';
import { SCROLL_TARGETS } from './scroll-to-section';

describe('resolveNotificationHref', () => {
  const target = { _id: 'page-id', path: '/foo/bar' };

  it('appends the comments-section hash for COMMENT notifications', () => {
    const href = resolveNotificationHref({ action: NotificationActionEnum.COMMENT, target });
    expect(href).toBe(`/foo/bar#${SCROLL_TARGETS.COMMENTS}`);
  });

  it('returns the bare target path for LIKE notifications', () => {
    const href = resolveNotificationHref({ action: NotificationActionEnum.LIKE, target });
    expect(href).toBe('/foo/bar');
  });

  it('returns the bare target path for MENTION notifications', () => {
    const href = resolveNotificationHref({ action: NotificationActionEnum.MENTION, target });
    expect(href).toBe('/foo/bar');
  });
});
