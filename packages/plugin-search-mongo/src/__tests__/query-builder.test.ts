import type { SearchQueryViewer } from '@crowi/plugin-api';

import {
  buildPageFilter,
  clampLimit,
  DEFAULT_LIMIT,
  escapeRegex,
  GRANT_OWNER,
  GRANT_PUBLIC,
  GRANT_RESTRICTED,
  GRANT_SPECIFIED,
  grantFilter,
  keywordRegex,
  MAX_LIMIT,
  pageToSkip,
  pathPrefixFilter,
  typeFilter,
} from '../query-builder';

describe('clampLimit', () => {
  it('defaults when limit is missing / non-positive', () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(clampLimit(0)).toBe(DEFAULT_LIMIT);
    expect(clampLimit(-5)).toBe(DEFAULT_LIMIT);
  });

  it('passes through valid limits', () => {
    expect(clampLimit(10)).toBe(10);
  });

  it('caps at MAX_LIMIT (200)', () => {
    expect(clampLimit(1000)).toBe(MAX_LIMIT);
    expect(clampLimit(MAX_LIMIT)).toBe(MAX_LIMIT);
  });
});

describe('pageToSkip', () => {
  it('computes the zero-based skip from a 1-based page', () => {
    expect(pageToSkip(1, 50)).toBe(0);
    expect(pageToSkip(2, 50)).toBe(50);
    expect(pageToSkip(3, 20)).toBe(40);
  });

  it('treats missing / non-positive page as page 1', () => {
    expect(pageToSkip(undefined, 50)).toBe(0);
    expect(pageToSkip(0, 50)).toBe(0);
  });
});

describe('escapeRegex', () => {
  it('escapes regex metacharacters so the query matches literally', () => {
    expect(escapeRegex('a.b*c')).toBe('a\\.b\\*c');
    expect(escapeRegex('(x)[y]')).toBe('\\(x\\)\\[y\\]');
  });
});

describe('keywordRegex', () => {
  it('returns null for empty / whitespace queries', () => {
    expect(keywordRegex('')).toBeNull();
    expect(keywordRegex('   ')).toBeNull();
  });

  it('builds a case-insensitive substring regex', () => {
    const re = keywordRegex('Hello');
    expect(re).not.toBeNull();
    expect(re?.flags).toContain('i');
    expect(re?.test('say hello world')).toBe(true);
  });

  it('treats metacharacters literally', () => {
    const re = keywordRegex('a.b');
    expect(re?.test('a.b')).toBe(true);
    expect(re?.test('axb')).toBe(false);
  });
});

describe('grantFilter', () => {
  it('anonymous viewer: public only', () => {
    expect(grantFilter(undefined)).toEqual([{ grant: null }, { grant: GRANT_PUBLIC }]);
  });

  it('admin viewer: no grant constraint', () => {
    const admin: SearchQueryViewer = { id: 'u1', username: 'admin', isAdmin: true };
    expect(grantFilter(admin)).toBeNull();
  });

  it('non-admin viewer: public OR creator OR shared', () => {
    const viewer: SearchQueryViewer = { id: 'u1', username: 'alice' };
    const or = grantFilter(viewer);
    expect(or).toContainEqual({ grant: GRANT_PUBLIC });
    expect(or).toContainEqual({ grant: GRANT_RESTRICTED, grantedUsers: 'u1' });
    expect(or).toContainEqual({ grant: GRANT_SPECIFIED, grantedUsers: 'u1' });
    expect(or).toContainEqual({ grant: GRANT_OWNER, grantedUsers: 'u1' });
    expect(or).toContainEqual({ grant: { $ne: GRANT_PUBLIC }, creator: 'u1' });
  });
});

describe('typeFilter', () => {
  it('portal: ends with slash, excludes /user/', () => {
    const f = typeFilter('portal');
    expect(f).toHaveProperty('$nor');
    const pathRe = (f.path as { $regex: RegExp }).$regex;
    expect(pathRe.test('/team/')).toBe(true);
    expect(pathRe.test('/team/page')).toBe(false);
  });

  it('user: /user/ prefix', () => {
    const f = typeFilter('user');
    const re = (f.path as { $regex: RegExp }).$regex;
    expect(re.test('/user/alice/notes')).toBe(true);
    expect(re.test('/team/alice')).toBe(false);
  });
});

describe('pathPrefixFilter', () => {
  it('anchors on the normalised prefix', () => {
    const re = (pathPrefixFilter('/team/eng/').path as { $regex: RegExp }).$regex;
    expect(re.test('/team/eng/roadmap')).toBe(true);
    expect(re.test('/team/design/roadmap')).toBe(false);
  });

  it('normalises a missing trailing slash', () => {
    const re = (pathPrefixFilter('/team/eng').path as { $regex: RegExp }).$regex;
    expect(re.test('/team/eng/roadmap')).toBe(true);
  });
});

describe('buildPageFilter', () => {
  const keyword = keywordRegex('plan');

  it('always excludes drafts / deleted / redirects', () => {
    const filter = buildPageFilter({ keyword, matchPath: true });
    const and = (filter as { $and: Array<Record<string, unknown>> }).$and;
    expect(and).toContainEqual({ status: { $nin: ['draft', 'deleted'] } });
    expect(and).toContainEqual({ redirectTo: { $in: [null, ''] } });
  });

  it('applies the path keyword when matchPath is true', () => {
    const filter = buildPageFilter({ keyword, matchPath: true });
    const and = (filter as { $and: Array<Record<string, unknown>> }).$and;
    expect(and.some((c) => 'path' in c && (c.path as { $regex?: unknown }).$regex === keyword)).toBe(true);
  });

  it('omits the path keyword when matchPath is false', () => {
    const filter = buildPageFilter({ keyword, matchPath: false });
    const and = (filter as { $and: Array<Record<string, unknown>> }).$and;
    expect(and.some((c) => 'path' in c && (c.path as { $regex?: unknown }).$regex === keyword)).toBe(false);
  });

  it('adds the grant $or for an anonymous viewer', () => {
    const filter = buildPageFilter({ keyword, matchPath: true });
    const and = (filter as { $and: Array<Record<string, unknown>> }).$and;
    expect(and).toContainEqual({ $or: [{ grant: null }, { grant: GRANT_PUBLIC }] });
  });

  it('omits the grant $or for an admin viewer', () => {
    const filter = buildPageFilter({ keyword, matchPath: true, viewer: { id: 'u1', username: 'admin', isAdmin: true } });
    // No grant constraint at all for admins.
    expect(JSON.stringify(filter)).not.toContain('grant');
  });
});
