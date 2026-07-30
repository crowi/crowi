import { describe, expect, it } from 'vitest';
import {
  decodePagePathFromUrl,
  decodeRouteParamSegment,
  defaultDraftBody,
  isReservedPagePath,
  isUserHomePath,
  pageBasename,
  pageDefaultTitle,
  pageDirname,
  pageDisplayName,
  pageDisplayParent,
  pagePathToHref,
} from './page-path';

describe('pageBasename', () => {
  it('returns the last non-empty segment', () => {
    expect(pageBasename('/crowi/rfc/0001-plugin-architecture')).toBe('0001-plugin-architecture');
  });

  it('ignores a trailing slash (portal page)', () => {
    expect(pageBasename('/foo/bar/')).toBe('bar');
  });

  it('returns the segment for a single-level path', () => {
    expect(pageBasename('/foo')).toBe('foo');
  });

  it('returns an empty string for the top page', () => {
    expect(pageBasename('/')).toBe('');
  });
});

describe('pageDirname', () => {
  it('returns everything up to and including the final slash', () => {
    expect(pageDirname('/crowi/rfc/0001-plugin-architecture')).toBe('/crowi/rfc/');
  });

  it('ignores a trailing slash before computing the parent', () => {
    expect(pageDirname('/foo/bar/')).toBe('/foo/');
  });

  it('returns root for a single-level path', () => {
    expect(pageDirname('/foo')).toBe('/');
    expect(pageDirname('/foo/')).toBe('/');
  });

  it('returns root for the top page', () => {
    expect(pageDirname('/')).toBe('/');
  });

  it('pairs with pageBasename to reconstruct the path', () => {
    const path = '/Weall/dev/infra/v0';
    expect(pageDirname(path) + pageBasename(path)).toBe(path);
  });
});

describe('pageDisplayName', () => {
  it('collapses a trailing date hierarchy into one title', () => {
    expect(pageDisplayName('/user/foo/日報/2026/05/23')).toBe('2026/05/23');
  });

  it('collapses a partial date hierarchy on a portal path', () => {
    expect(pageDisplayName('/user/foo/日報/2026/05/')).toBe('2026/05');
  });

  it('returns the leaf as-is when only one numeric segment trails', () => {
    expect(pageDisplayName('/user/foo/日報/2026/')).toBe('2026');
  });

  it('stops collapsing as soon as a non-numeric segment appears', () => {
    expect(pageDisplayName('/foo/2026/05/notes')).toBe('notes');
  });

  it('matches pageBasename for non-numeric leaves', () => {
    expect(pageDisplayName('/crowi/rfc/0001-plugin-architecture')).toBe('0001-plugin-architecture');
    expect(pageDisplayName('/foo')).toBe('foo');
  });

  it('returns an empty string for the top page', () => {
    expect(pageDisplayName('/')).toBe('');
  });

  it('absorbs the whole path when every segment is numeric', () => {
    expect(pageDisplayName('/2026/05/23')).toBe('2026/05/23');
  });
});

describe('pageDisplayParent', () => {
  it('skips the entire date hierarchy', () => {
    expect(pageDisplayParent('/user/foo/日報/2026/05/23')).toBe('/user/foo/日報/');
    expect(pageDisplayParent('/user/foo/日報/2026/05/')).toBe('/user/foo/日報/');
    expect(pageDisplayParent('/user/foo/日報/2026/')).toBe('/user/foo/日報/');
  });

  it('falls back to pageDirname semantics for non-numeric leaves', () => {
    expect(pageDisplayParent('/foo/bar/page')).toBe('/foo/bar/');
    expect(pageDisplayParent('/foo')).toBe('/');
  });

  it('returns root when the path is entirely the date hierarchy', () => {
    expect(pageDisplayParent('/2026/05/23')).toBe('/');
  });

  it('returns root for the top page', () => {
    expect(pageDisplayParent('/')).toBe('/');
  });

  it('pairs with pageDisplayName to reconstruct the (trimmed) path', () => {
    const path = '/user/foo/日報/2026/05/23';
    expect(pageDisplayParent(path) + pageDisplayName(path)).toBe(path);
  });
});

describe('isUserHomePath', () => {
  it('matches a user home page with or without a trailing slash', () => {
    expect(isUserHomePath('/user/sotarok')).toBe(true);
    expect(isUserHomePath('/user/sotarok/')).toBe(true);
  });

  it('does not match deeper pages under the home, the member directory, or other paths', () => {
    expect(isUserHomePath('/user/sotarok/memo')).toBe(false);
    expect(isUserHomePath('/user/')).toBe(false);
    expect(isUserHomePath('/user')).toBe(false);
    expect(isUserHomePath('/crowi/rfc')).toBe(false);
    expect(isUserHomePath('/')).toBe(false);
  });
});

describe('isReservedPagePath', () => {
  it('matches the backend namespace, bare or nested', () => {
    expect(isReservedPagePath('/api')).toBe(true);
    expect(isReservedPagePath('/api/')).toBe(true);
    expect(isReservedPagePath('/api/mcp')).toBe(true);
    expect(isReservedPagePath('/api/anything')).toBe(true);
  });

  it('matches the other server-reserved top-level prefixes', () => {
    for (const seg of ['installer', 'register', 'login', 'logout', 'admin', 'me', 'files', 'trash', 'paste', 'comments']) {
      expect(isReservedPagePath(`/${seg}`)).toBe(true);
      expect(isReservedPagePath(`/${seg}/x`)).toBe(true);
    }
  });

  it('is segment-bounded — a word that merely starts with a reserved prefix is a normal page', () => {
    expect(isReservedPagePath('/apiary')).toBe(false);
    expect(isReservedPagePath('/meeting')).toBe(false);
    expect(isReservedPagePath('/comments-policy')).toBe(false);
    expect(isReservedPagePath('/crowi/api')).toBe(false);
    expect(isReservedPagePath('/')).toBe(false);
  });

  it('does not reserve `/user` — the catch-all renders the member directory there', () => {
    expect(isReservedPagePath('/user')).toBe(false);
    expect(isReservedPagePath('/user/')).toBe(false);
    expect(isReservedPagePath('/user/sotarok')).toBe(false);
  });
});

describe('pageDefaultTitle', () => {
  it('keeps the notebook segment in front of a trailing date run', () => {
    expect(pageDefaultTitle('/user/sotarok/memo/2026/06/08')).toBe('memo/2026/06/08');
    expect(pageDefaultTitle('/crowi/日報/2026/06/08')).toBe('日報/2026/06/08');
  });

  it('returns just the leaf when the path does not end in a date run', () => {
    expect(pageDefaultTitle('/user/sotarok/zyx/134/hoge-fuga-piyo')).toBe('hoge-fuga-piyo');
    expect(pageDefaultTitle('/crowi/qa/2026/06/08/rfc-0011-mcp-server')).toBe('rfc-0011-mcp-server');
    expect(pageDefaultTitle('/crowi/qa/rfc-0011-mcp-server')).toBe('rfc-0011-mcp-server');
  });

  it('keeps the segment before a bare trailing number', () => {
    expect(pageDefaultTitle('/crowi/issues/123')).toBe('issues/123');
  });

  it('absorbs the whole path when it is entirely the date run', () => {
    expect(pageDefaultTitle('/2026/06/08')).toBe('2026/06/08');
  });

  it('returns the leaf for a single-segment path', () => {
    expect(pageDefaultTitle('/readme')).toBe('readme');
  });

  it('returns an empty string for the top page', () => {
    expect(pageDefaultTitle('/')).toBe('');
  });
});

describe('defaultDraftBody', () => {
  it('wraps the default title in an H1 followed by a blank cursor line', () => {
    expect(defaultDraftBody('/user/sotarok/memo/2026/06/08')).toBe('# memo/2026/06/08\n\n');
    expect(defaultDraftBody('/crowi/qa/rfc-0011-mcp-server')).toBe('# rfc-0011-mcp-server\n\n');
  });

  it('falls back to a bare newline when no title can be derived', () => {
    expect(defaultDraftBody('/')).toBe('\n');
  });
});

describe('pagePathToHref / decodePagePathFromUrl', () => {
  it('renders spaces in a page path as + for the URL', () => {
    expect(pagePathToHref('/Weall/dev/infra/v0/mysql connect to production db')).toBe('/Weall/dev/infra/v0/mysql+connect+to+production+db');
  });

  it('reads + back as a space (the legacy URL form of a space)', () => {
    expect(decodePagePathFromUrl('/Weall/dev/infra/v0/mysql+connect+to+production+db')).toBe('/Weall/dev/infra/v0/mysql connect to production db');
  });

  it('also reads %20 as a space', () => {
    expect(decodePagePathFromUrl('/a%20b/c')).toBe('/a b/c');
  });

  it('round-trips a path with spaces', () => {
    const path = '/foo bar/baz qux';
    expect(decodePagePathFromUrl(pagePathToHref(path))).toBe(path);
  });

  it('leaves a space-free path untouched in both directions', () => {
    expect(pagePathToHref('/crowi/rfc/0001')).toBe('/crowi/rfc/0001');
    expect(decodePagePathFromUrl('/crowi/rfc/0001')).toBe('/crowi/rfc/0001');
  });

  it('decodes percent-encoded non-ASCII segments', () => {
    expect(decodePagePathFromUrl('/%E6%97%A5%E5%A0%B1/2026')).toBe('/日報/2026');
  });

  // feature-page-link-space-paths Phase 1 — pin the existing `+` contract
  // down explicitly: `+` always decodes to a space (this is a fixed
  // semantic this spec does NOT change), which is also why the API-side
  // create/rename `Page.isCreatableName` check rejects a literal '+' in a
  // path — under this contract, `%2B` (percent-encoded '+') can never
  // survive as a literal '+' either; it decodes to a space just like a bare
  // '+' does.
  it('resolves a literal "+" to a real space (unchanged contract)', () => {
    expect(decodePagePathFromUrl('/a+b')).toBe('/a b');
  });

  it('resolves %2B (percent-encoded "+") to a space too — literal "+" cannot survive this decode', () => {
    expect(decodePagePathFromUrl('/a%2Bb')).toBe('/a b');
  });
});

describe('decodeRouteParamSegment', () => {
  // feature-page-link-space-paths Phase 1 — Next.js catch-all route params
  // (`params.slug[]`) are already `decodeURIComponent`d by Next's own route
  // matcher before user code sees them, unlike `usePathname()` (which stays
  // percent-encoded). Running `decodePagePathFromUrl` a second time on an
  // already-decoded segment double-decodes it — this helper instead applies
  // only the `+`-as-space half of the contract, with NO percent-decoding.

  it('reads a literal "+" as a space, same as decodePagePathFromUrl', () => {
    expect(decodeRouteParamSegment('a+b')).toBe('a b');
  });

  it('does NOT percent-decode — a %20 segment (already decoded upstream, if it were encoded) stays a literal %20', () => {
    expect(decodeRouteParamSegment('a%20b')).toBe('a%20b');
  });

  it('leaves a plain segment untouched', () => {
    expect(decodeRouteParamSegment('foo')).toBe('foo');
  });
});
