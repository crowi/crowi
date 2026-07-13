import { describe, expect, it } from 'vitest';
import type { Page, PageUser, PageWithRevision, Revision } from '@crowi/api-contract';
import { resolveDisplayUser } from './page-display-user';

const ALICE: PageUser = { _id: 'u-alice', username: 'alice', name: 'Alice', email: 'alice@example.com', createdAt: '2026-01-01T00:00:00.000Z' };
const BOB: PageUser = { _id: 'u-bob', username: 'bob', name: 'Bob', email: 'bob@example.com', createdAt: '2026-01-01T00:00:00.000Z' };
const CAROL: PageUser = { _id: 'u-carol', username: 'carol', name: 'Carol', email: 'carol@example.com', createdAt: '2026-01-01T00:00:00.000Z' };

function makeRevision(overrides: Partial<Revision> = {}): Revision {
  return {
    _id: 'rev-1',
    path: '/docs/example',
    body: '# hi',
    format: 'markdown',
    createdAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

function makePage(overrides: Partial<Page> = {}): Page {
  return {
    _id: 'page-1',
    path: '/docs/example',
    commentCount: 0,
    createdAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('resolveDisplayUser', () => {
  it('prefers lastUpdateUser over creator and the revision author', () => {
    const page = makePage({ lastUpdateUser: BOB, creator: ALICE, revision: makeRevision({ author: CAROL }) });
    expect(resolveDisplayUser(page)).toEqual(BOB);
  });

  it('falls back to creator when lastUpdateUser is an unpopulated bare id string', () => {
    const page = makePage({ lastUpdateUser: 'u-bob', creator: ALICE, revision: makeRevision({ author: CAROL }) });
    expect(resolveDisplayUser(page)).toEqual(ALICE);
  });

  it('falls back to the revision author when neither lastUpdateUser nor creator are populated (regression: the drifted duplicates in PageListItem/SearchHitItem dropped this fallback)', () => {
    const page = makePage({ lastUpdateUser: 'u-bob', creator: null, revision: makeRevision({ author: CAROL }) });
    expect(resolveDisplayUser(page)).toEqual(CAROL);
  });

  it('returns null when nothing is populated, including an unpopulated revision id string', () => {
    const page = makePage({ lastUpdateUser: null, creator: null, revision: 'rev-1' });
    expect(resolveDisplayUser(page)).toBeNull();
  });

  it('returns null when the revision is populated but its author is null', () => {
    const page = makePage({ lastUpdateUser: null, creator: null, revision: makeRevision({ author: null }) });
    expect(resolveDisplayUser(page)).toBeNull();
  });

  it('returns null when creator/lastUpdateUser are unpopulated and revision itself is absent', () => {
    const page = makePage({ lastUpdateUser: 'u-bob', creator: 'u-alice' });
    expect(resolveDisplayUser(page)).toBeNull();
  });

  it('accepts the PageWithRevision shape (revision always a populated object) unchanged', () => {
    const page: PageWithRevision = {
      _id: 'page-1',
      path: '/docs/example',
      commentCount: 0,
      createdAt: '2026-05-01T00:00:00.000Z',
      creator: null,
      lastUpdateUser: null,
      revision: makeRevision({ author: CAROL }),
    };
    expect(resolveDisplayUser(page)).toEqual(CAROL);
  });
});
