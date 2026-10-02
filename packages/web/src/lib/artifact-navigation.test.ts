import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import { decodePagePathFromUrl } from './page-path';
import { isSafeArtifactPagePath, resolveArtifactNavigation } from './artifact-navigation';

const resolve = (source: string, href: string) => resolveArtifactNavigation(source, href);

describe('resolveArtifactNavigation', () => {
  it.each([
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
    expect(resolve(source, href)).toEqual({ pagePath, href: outHref });
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
      expect(target).not.toBeNull();
      const url = new URL(target!.href, 'https://wiki.example');
      expect(url.origin).toBe('https://wiki.example');
      expect(url.search).toBe('');
      expect(decodePagePathFromUrl(url.pathname)).toBe(target!.pagePath);
    }
  });

  it.each([
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
    expect(resolve(source, href)).toBeNull();
  });

  it.each([
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
    expect(resolve(source, '/team/guide')).toBeNull();
  });

  it('rejects a result longer than the limit', () => {
    expect(resolve('/x/y', `/${'資'.repeat(1400)}`)).toBeNull();
  });
});

describe('isSafeArtifactPagePath', () => {
  it.each([
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
    expect(isSafeArtifactPagePath(path)).toBe(true);
  });

  it.each([
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
    expect(isSafeArtifactPagePath(path)).toBe(false);
  });
});

describe('route inventory: nothing but wiki page display is reachable', () => {
  const appDir = join(__dirname, '..', 'app');
  const publicDir = join(__dirname, '..', '..', 'public');

  function listFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? listFiles(full) : [full];
    });
  }

  // Next dynamic segments become concrete names; route groups vanish; `%5F` is a literal underscore in the URL.
  function concreteUrls(file: string): string[] {
    const segments = relative(appDir, file)
      .split('/')
      .slice(0, -1)
      .filter((segment) => !/^\(.*\)$/.test(segment))
      .map((segment) => decodeURIComponent(segment));
    const last = segments.at(-1);
    if (last && /^\[\[\.\.\..+\]\]$/.test(last)) {
      const base = segments.slice(0, -1);
      return [`/${base.join('/')}`, `/${[...base, 'sample'].join('/')}`];
    }
    return [`/${segments.map((segment) => (/^\[.+\]$/.test(segment) ? (segment === '[username]' ? 'alice' : 'sample') : segment)).join('/')}`];
  }

  const ROUTE_FILE = /^(page|route)\.tsx?$/;
  const METADATA_FILE = /^(favicon|icon|apple-icon|robots|sitemap|manifest|opengraph-image|twitter-image)(\d*)\.[a-z]+$/;
  const ALLOWED_TEMPLATES = new Set(['(auth)/[[...slug]]/page.tsx', '(auth)/user/[username]/page.tsx']);

  const appFiles = listFiles(appDir).filter((file) => !/\.test\.tsx?$/.test(file));

  it('refuses every app route except the wiki page and user profile templates', () => {
    const routes = appFiles.filter((file) => ROUTE_FILE.test(file.split('/').at(-1)!));
    expect(routes.length).toBeGreaterThan(10);
    for (const file of routes) {
      const rel = relative(appDir, file);
      if (ALLOWED_TEMPLATES.has(rel)) continue;
      for (const url of concreteUrls(file)) {
        expect(isSafeArtifactPagePath(url), `${rel} -> ${url}`).toBe(false);
      }
    }
  });

  it('keeps the allowed templates reachable', () => {
    expect(isSafeArtifactPagePath('/')).toBe(true);
    expect(isSafeArtifactPagePath('/sample')).toBe(true);
    expect(isSafeArtifactPagePath('/user/alice')).toBe(true);
    for (const rel of ALLOWED_TEMPLATES) expect(appFiles.map((file) => relative(appDir, file))).toContain(rel);
  });

  it('knows every metadata route file, so a new one must be classified here', () => {
    const found = appFiles.filter((file) => METADATA_FILE.test(file.split('/').at(-1)!)).map((file) => relative(appDir, file));
    expect(found).toEqual(['favicon.ico']);
    expect(isSafeArtifactPagePath('/favicon.ico')).toBe(false);
  });

  it('refuses every public file URL', () => {
    const files = listFiles(publicDir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const url = `/${relative(publicDir, file)}`;
      expect(isSafeArtifactPagePath(url), url).toBe(false);
    }
  });
});
