import type { PageWithRevision } from '@crowi/api-contract';
import { PageGrantEnum } from '@crowi/api-contract';
import { describe, expect, it } from 'vitest';
import { isHeadNewer, isLifecycleChanged, mergePageLevelFields, pageLevelFieldsChanged, pageUserDisplayName } from './live-sync-reconcile';

function makePage(overrides: Partial<PageWithRevision> = {}): PageWithRevision {
  return {
    _id: 'page-1',
    path: '/docs/example',
    grant: PageGrantEnum.PUBLIC,
    grantedUsers: [],
    status: undefined,
    revision: {
      _id: 'rev-1',
      path: '/docs/example',
      body: '# hi',
      format: 'markdown',
      createdAt: '2026-05-01T00:00:00.000Z',
    },
    latestRevision: 'rev-1',
    creator: null,
    lastUpdateUser: { _id: 'u1', username: 'alice', name: 'Alice', email: 'a@example.com', createdAt: '2026-01-01T00:00:00.000Z' },
    liker: [],
    commentCount: 0,
    extended: undefined,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    likerCount: 0,
    seenUsersCount: 0,
    redirectTo: null,
    ...overrides,
  } as PageWithRevision;
}

describe('isHeadNewer (tie-break compare, head-GET only)', () => {
  it('is true when fetched.createdAt is strictly after current', () => {
    const current = { _id: 'rev-1', createdAt: '2026-05-01T00:00:00.000Z' };
    const fetched = { _id: 'rev-2', createdAt: '2026-05-01T00:00:01.000Z' };
    expect(isHeadNewer(current, fetched)).toBe(true);
  });

  it('is false when fetched.createdAt is before current', () => {
    const current = { _id: 'rev-2', createdAt: '2026-05-01T00:00:01.000Z' };
    const fetched = { _id: 'rev-1', createdAt: '2026-05-01T00:00:00.000Z' };
    expect(isHeadNewer(current, fetched)).toBe(false);
  });

  it('is false for the exact same revision (identical timestamp and id)', () => {
    const rev = { _id: 'rev-1', createdAt: '2026-05-01T00:00:00.000Z' };
    expect(isHeadNewer(rev, { ...rev })).toBe(false);
  });

  it('tie-break: is true for the SAME millisecond but a DIFFERENT id (strict > would reject this)', () => {
    const current = { _id: 'rev-1', createdAt: '2026-05-01T00:00:00.000Z' };
    const fetched = { _id: 'rev-2', createdAt: '2026-05-01T00:00:00.000Z' };
    // A naive `fetchedTime > currentTime` is false here — the tie-break
    // widening (`fetchedTime === currentTime && fetched._id !== current._id`)
    // is what makes this swap-worthy.
    expect(Date.parse(fetched.createdAt) > Date.parse(current.createdAt)).toBe(false);
    expect(isHeadNewer(current, fetched)).toBe(true);
  });
});

describe('isLifecycleChanged', () => {
  it('is true when the fetched page carries a redirectTo (Page.deletePage stub)', () => {
    const current = makePage({ _id: 'page-1' });
    const fetched = makePage({ _id: 'page-1', redirectTo: '/docs/moved' });
    expect(isLifecycleChanged(current, fetched)).toBe(true);
  });

  it('is true when the fetched page has a different _id (path reused by another page)', () => {
    const current = makePage({ _id: 'page-1' });
    const fetched = makePage({ _id: 'page-2', redirectTo: null });
    expect(isLifecycleChanged(current, fetched)).toBe(true);
  });

  it('is false for the same live page (same _id, no redirectTo)', () => {
    const current = makePage({ _id: 'page-1' });
    const fetched = makePage({ _id: 'page-1', redirectTo: null });
    expect(isLifecycleChanged(current, fetched)).toBe(false);
  });
});

describe('pageLevelFieldsChanged / mergePageLevelFields (grant-only change, revision untouched)', () => {
  it('detects a grant change with the revision unchanged', () => {
    const current = makePage({ grant: PageGrantEnum.PUBLIC, grantedUsers: [] });
    const fetched = makePage({ grant: PageGrantEnum.RESTRICTED, grantedUsers: ['u1'] });
    expect(pageLevelFieldsChanged(current, fetched)).toBe(true);
  });

  it('reports no change when only revision-correlated fields differ (handled by the full-swap branch instead)', () => {
    const current = makePage({
      updatedAt: '2026-05-01T00:00:00.000Z',
      lastUpdateUser: { _id: 'u1', username: 'alice', name: 'Alice', email: 'a@example.com', createdAt: '2026-01-01T00:00:00.000Z' },
    });
    const fetched = makePage({
      updatedAt: '2026-05-02T00:00:00.000Z',
      lastUpdateUser: { _id: 'u2', username: 'bob', name: 'Bob', email: 'b@example.com', createdAt: '2026-01-01T00:00:00.000Z' },
    });
    expect(pageLevelFieldsChanged(current, fetched)).toBe(false);
  });

  it('merges ONLY the page-level fields, leaving revision / latestRevision / updatedAt / lastUpdateUser untouched', () => {
    const current = makePage({ grant: PageGrantEnum.PUBLIC, grantedUsers: [] });
    const fetched = makePage({ grant: PageGrantEnum.RESTRICTED, grantedUsers: ['u1'], updatedAt: '2026-06-01T00:00:00.000Z' });

    const merged = mergePageLevelFields(current, fetched);

    expect(merged.grant).toBe(PageGrantEnum.RESTRICTED);
    expect(merged.grantedUsers).toEqual(['u1']);
    // Revision-correlated fields stay exactly as `current`'s — the body
    // did not change, so nothing here should move.
    expect(merged.revision).toBe(current.revision);
    expect(merged.updatedAt).toBe(current.updatedAt);
    expect(merged.lastUpdateUser).toBe(current.lastUpdateUser);
  });
});

describe('pageUserDisplayName', () => {
  it('prefers name over username', () => {
    expect(pageUserDisplayName({ _id: 'u1', username: 'alice', name: 'Alice', email: 'a@example.com', createdAt: '2026-01-01T00:00:00.000Z' })).toBe('Alice');
  });

  it('falls back to username when name is empty', () => {
    expect(pageUserDisplayName({ _id: 'u1', username: 'alice', name: '', email: 'a@example.com', createdAt: '2026-01-01T00:00:00.000Z' })).toBe('alice');
  });

  it('falls back to an empty string when the user is null/undefined', () => {
    expect(pageUserDisplayName(null)).toBe('');
    expect(pageUserDisplayName(undefined)).toBe('');
  });
});
