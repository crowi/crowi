import { describe, expect, it } from 'vitest';
import { pageBasename, pageDirname, pageDisplayName, pageDisplayParent } from './page-path';

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
