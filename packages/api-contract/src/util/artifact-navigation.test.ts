/**
 * Unit test for the shared artifact page-path resolver / route classifier. Run with `node --test`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseArtifactPageLink } from './artifact-link';
import { classifyArtifactPagePath, isSafeArtifactPagePath, resolveArtifactNavigation, resolveArtifactPagePath } from './artifact-navigation';
import { decodePagePathFromUrl } from './page-path';

function itEach(rows: readonly (readonly string[] | string)[]) {
  return (name: string, fn: (...args: string[]) => void) => {
    for (const row of rows) {
      const args = typeof row === 'string' ? [row] : [...row];
      it(`${name.replace('%s', args[0])} [${args.join(' | ')}]`, () => fn(...args));
    }
  };
}

const resolve = (source: string, href: string) => resolveArtifactNavigation(source, href);

describe('resolveArtifactNavigation', () => {
  itEach([
    ['P-a sibling', '/team/artifact', 'guide', '/team/guide', '/team/guide'],
    ['P-a ./', '/team/artifact', './guide', '/team/guide', '/team/guide'],
    ['P-b parent with fragment', '/team/artifact', '../guide#overview', '/guide', '/guide#overview'],
    ['P-c trailing-slash base is still sibling-based', '/team/artifact/', 'guide', '/team/guide', '/team/guide'],
    ['P-d root base', '/', 'guide', '/guide', '/guide'],
    ['P-d ./ keeps the trailing slash', '/team/artifact', './', '/team/', '/team/'],
    ['dot-only final segment keeps the trailing slash', '/team/artifact', '.', '/team/', '/team/'],
    ['root link', '/team/artifact', '/', '/', '/'],
    ['absolute link ignores the base', '/a/b/c', '/team/guide', '/team/guide', '/team/guide'],
    ['P-f space', '/team/artifact', 'my page', '/team/my page', '/team/my+page'],
    ['P-f plus', '/team/artifact', 'my+page', '/team/my page', '/team/my+page'],
    ['P-f %20', '/team/artifact', 'my%20page', '/team/my page', '/team/my+page'],
    ['P-f %2B', '/team/artifact', 'my%2Bpage', '/team/my page', '/team/my+page'],
    ['P-g Unicode and fragment plus', '/team/artifact', '資料#章+1', '/team/資料', '/team/%E8%B3%87%E6%96%99#%E7%AB%A0%2B1'],
    ['P-k base with %', '/discount/100%off', './guide', '/discount/guide', '/discount/guide'],
    ['P-k base ending in a bare %', '/team/100%', 'guide', '/team/guide', '/team/guide'],
    ['P-k base with a colon, absolute link', '/RFC: design/demo', '/team/guide', '/team/guide', '/team/guide'],
    ['P-l escaped % in an absolute link', '/x/y', '/discount/100%25off', '/discount/100%off', '/discount/100%25off'],
    ['P-l escaped % in a relative link', '/team/artifact', '100%25done', '/team/100%done', '/team/100%25done'],
    ['P-l colon', '/x/y', '/team/section:1', '/team/section:1', '/team/section%3A1'],
    ['P-l encoded colon', '/x/y', '/team/section%3A1', '/team/section:1', '/team/section%3A1'],
    ['colon after ./', '/team/artifact', './section:1', '/team/section:1', '/team/section%3A1'],
    ['an encoded slash name survives as a literal', '/x/y', '/a/%252fb', '/a/%2fb', '/a/%252fb'],
    ['literal %2e%2e is a page name, not a dot segment', '/x/y', '/team/%252e%252e', '/team/%2e%2e', '/team/%252e%252e'],
    ['encoded dot segments resolve', '/team/artifact', '%2e%2e/guide', '/guide', '/guide'],
    ['a page name that looks like a Crowi path with -', '/x/y', '/-foo', '/-foo', '/-foo'],
  ])('%s', (_label, source, href, pagePath, outHref) => {
    assert.deepEqual(resolve(source, href), { pagePath, href: outHref });
  });

  it('round-trips every accepted target: href decodes back to the page path, no query, same origin', () => {
    const cases: [string, string][] = [
      ['/team/artifact', 'my page'],
      ['/team/artifact', '資料#章+1'],
      ['/x/y', '/discount/100%25off'],
      ['/x/y', '/team/section:1'],
      ['/x/y', '/a/%252fb'],
      ['/x/y', '/team/a%20b/c'],
    ];
    for (const [source, href] of cases) {
      const target = resolve(source, href);
      assert.notEqual(target, null);
      const url = new URL(target!.href, 'https://wiki.example');
      assert.equal(url.origin, 'https://wiki.example');
      assert.equal(url.search, '');
      assert.equal(decodePagePathFromUrl(url.pathname), target!.pagePath);
    }
  });

  itEach([
    ['P-e root overflow', '/team/artifact', '../../guide'],
    ['P-h dot segments reaching a reserved route', '/team/artifact', '/x/%2e%2e/admin'],
    ['P-i double slash', '/team/artifact', '/a//b'],
    ['P-i encoded slash', '/team/artifact', '/%2fadmin'],
    ['P-i encoded backslash', '/team/artifact', '/%5cadmin'],
    ['P-i invalid escape', '/team/artifact', '/%2G'],
    ['P-i overlong UTF-8', '/team/artifact', '/%C0%AF'],
    ['P-i bad escape', '/team/artifact', '/%ZZ'],
    ['P-i raw %', '/team/artifact', '/100%done'],
    ['P-i raw % at the end', '/team/artifact', '/100%'],
    ['raw % relative', '/team/artifact', '100%off'],
    ['P-j query', '/team/artifact', '/guide?edit=1'],
    ['P-j absolute URL', '/team/artifact', 'https://wiki.example/guide'],
    ['P-j protocol-relative', '/team/artifact', '//wiki.example/guide'],
    ['scheme-like relative', '/team/artifact', 'javascript:alert(1)'],
    ['fragment only', '/team/artifact', '#top'],
    ['reserved route', '/team/artifact', '/admin'],
    ['reserved after relative resolution', '/admin/x', 'users'],
  ])('rejects %s', (_label, source, href) => {
    assert.equal(resolve(source, href), null);
  });

  itEach([
    ['no leading slash', 'team/artifact'],
    ['double slash', '/team//artifact'],
    ['control char', '/team/a\nb'],
    ['backslash', '/team\\artifact'],
    ['query', '/team/a?b'],
    ['hash', '/team/a#b'],
    ['literal plus', '/team/a+b'],
    ['dot-only segment', '/team/../artifact'],
    ['lone surrogate', '/team/\uD800'],
    ['too long', `/${'a'.repeat(4096)}`],
    ['empty', ''],
  ])('rejects an unsafe source page path (%s)', (_label, source) => {
    assert.equal(resolve(source, '/team/guide'), null);
  });

  it('rejects a result longer than the limit', () => {
    assert.equal(resolve('/x/y', `/${'資'.repeat(1400)}`), null);
  });
});

describe('isSafeArtifactPagePath', () => {
  itEach([
    '/',
    '/team/guide',
    '/team/guide/',
    '/apiary',
    '/meeting',
    '/team/admin',
    '/team/section:1',
    '/discount/100%off',
    '/user/alice',
    '/user/alice/',
    '/user/alice/notes',
    '/docs/507f1f77bcf86cd799439011',
    '/-foo',
    '/team/-/foo',
    '/a.b/c',
    '/資料/日本語 ページ',
    '/notifications-guide',
    '/loginfo',
  ])('allows %s', (path) => {
    assert.equal(isSafeArtifactPagePath(path), true);
  });

  itEach([
    // R-2
    ...['installer', 'register', 'login', 'logout', 'admin', 'me', 'files', 'trash', 'paste', 'comments', 'api'].flatMap((name) => [
      `/${name}`,
      `/${name}/`,
      `/${name}/x`,
    ]),
    '/ADMIN',
    '/Admin/users',
    // R-3
    ...['activate', 'confirm-email', 'forgot-password', 'reset-password', 'invite', 'oauth'].flatMap((name) => [`/${name}`, `/${name}/x`]),
    // R-4
    '/_artifact-frame',
    '/_edit',
    '/_r/abc',
    '/_history',
    '/_search',
    '/_attachments',
    '/_notifications',
    '/_user',
    '/_next/static/x',
    '/.well-known/x',
    '/.hidden',
    '/-/foo',
    '/-',
    '/-/',
    // R-5
    ...['collab', 'presence', 'notifications', 'socket.io', 'logo', 'images'].flatMap((name) => [`/${name}`, `/${name}/x`]),
    '/favicon.ico',
    '/favicon.ico/x',
    // R-6
    '/user',
    '/user/',
    '/User',
    ...['bookmarks', 'comments', 'activities', 'pages', 'recent-create', 'recent-edit'].flatMap((tab) => [`/user/alice/${tab}`, `/user/alice/${tab}/x`]),
    '/user/alice/Bookmarks',
    // R-7
    '/507f1f77bcf86cd799439011',
    '/507f1f77bcf86cd799439011/',
    '/507F1F77BCF86CD799439011',
    // R-8
    '/a^b',
    '/a$b',
    '/a*b',
    '/a / b',
    '/a/edit',
    '/a/edit/',
    '/notes.md',
    '/notes.md/',
    // structure
    'team',
    '/a//b',
    '/a\\b',
    '/a?b',
    '/a#b',
    '/a+b',
    '/a/../b',
    '/a/./b',
  ])('rejects %s', (path) => {
    assert.equal(isSafeArtifactPagePath(path), false);
  });
});

describe('shared core and classifier', () => {
  const link = (href: string) => {
    const parsed = parseArtifactPageLink(href);
    assert.notEqual(parsed, null);
    return parsed!;
  };

  it('resolveArtifactPagePath needs no base for an absolute link', () => {
    assert.equal(resolveArtifactPagePath(link('/team/guide')), '/team/guide');
    assert.equal(resolveArtifactPagePath(link('/x/%2e%2e/admin')), '/admin');
    assert.equal(resolveArtifactPagePath(link('/a%20b/')), '/a b/');
  });

  it('resolveArtifactPagePath returns null for a relative link without a canonical base', () => {
    assert.equal(resolveArtifactPagePath(link('guide')), null);
    assert.equal(resolveArtifactPagePath(link('guide'), 'team/artifact'), null);
    assert.equal(resolveArtifactPagePath(link('../../guide'), '/team/artifact'), null);
    assert.equal(resolveArtifactPagePath(link('../admin'), '/team/artifact'), '/admin');
    assert.equal(resolveArtifactPagePath(link('../admin'), '/team/sub/artifact'), '/team/admin');
    assert.equal(resolveArtifactPagePath(link('..'), '/team/sub/artifact'), '/team/');
  });

  it('does not decode a second time', () => {
    assert.equal(resolveArtifactPagePath(link('/%252e%252e/admin')), '/%2e%2e/admin');
  });

  it('classifyArtifactPagePath separates page / reserved-route / invalid-path', () => {
    assert.equal(classifyArtifactPagePath('/team/guide'), 'page');
    assert.equal(classifyArtifactPagePath('/ADMIN'), 'reserved-route');
    assert.equal(classifyArtifactPagePath('/-'), 'reserved-route');
    assert.equal(classifyArtifactPagePath('/a/edit/'), 'reserved-route');
    assert.equal(classifyArtifactPagePath('/507f1f77bcf86cd799439011'), 'reserved-route');
    assert.equal(classifyArtifactPagePath('/a//b'), 'invalid-path');
    assert.equal(classifyArtifactPagePath('/a+b'), 'invalid-path');
    assert.equal(classifyArtifactPagePath(''), 'invalid-path');
  });
});
