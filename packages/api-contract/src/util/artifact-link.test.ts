/**
 * Unit test for `parseArtifactPageLink`. Run with `node --test` (built-in runner).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ARTIFACT_LINK_MAX_LENGTH, parseArtifactPageLink } from './artifact-link';

const ok = (href: string) => {
  const parsed = parseArtifactPageLink(href);
  assert.notEqual(parsed, null, `expected ${JSON.stringify(href)} to parse`);
  return parsed as NonNullable<typeof parsed>;
};
const rejected = (href: string) => assert.equal(parseArtifactPageLink(href), null, `expected ${JSON.stringify(href)} rejected`);

describe('util/artifact-link', () => {
  describe('parseArtifactPageLink', () => {
    it('accepts root, root-relative, ./, ../ and bare names', () => {
      assert.deepEqual(ok('/'), { absolute: true, segments: [], trailingSlash: true, fragment: null });
      assert.deepEqual(ok('/team/guide'), { absolute: true, segments: ['team', 'guide'], trailingSlash: false, fragment: null });
      assert.deepEqual(ok('./guide'), { absolute: false, segments: ['.', 'guide'], trailingSlash: false, fragment: null });
      assert.deepEqual(ok('../guide#overview'), {
        absolute: false,
        segments: ['..', 'guide'],
        trailingSlash: false,
        fragment: 'overview',
      });
      assert.deepEqual(ok('guide'), { absolute: false, segments: ['guide'], trailingSlash: false, fragment: null });
      assert.deepEqual(ok('./'), { absolute: false, segments: ['.'], trailingSlash: true, fragment: null });
      assert.equal(ok('/team/').trailingSlash, true);
    });

    it('keeps inner spaces, Unicode and + as written', () => {
      assert.deepEqual(ok('my page/資料').segments, ['my page', '資料']);
      assert.deepEqual(ok('my+page').segments, ['my+page']);
      assert.deepEqual(ok('資料#章+1').fragment, '章+1');
    });

    it('decodes each segment once and only once', () => {
      assert.deepEqual(ok('100%25done').segments, ['100%done']);
      assert.deepEqual(ok('/%252e%252e/admin').segments, ['%2e%2e', 'admin']);
      assert.deepEqual(ok('my%20page').segments, ['my page']);
      assert.deepEqual(ok('my%2Bpage').segments, ['my+page']);
      assert.deepEqual(ok('%E8%B3%87%E6%96%99').segments, ['資料']);
      assert.deepEqual(ok('x/%2e%2e/y').segments, ['x', '..', 'y']);
      assert.deepEqual(ok('/section%3A1').segments, ['section:1']);
    });

    it('rejects a raw % that does not form a valid escape', () => {
      for (const href of ['100%done', '100%off', '%ZZ', '%2G', '100%', '/100%', '/%2G', '/%ZZ', '/100%done']) rejected(href);
    });

    it('rejects invalid UTF-8 and encoded delimiters', () => {
      for (const href of ['/%C0%AF', '/%80', '/%ED%A0%80', '/%2fadmin', '/%2Fadmin', '/%5cadmin', 'a%3Fb', 'a%23b']) rejected(href);
    });

    it('treats : as a page-name character except in a scheme-like first segment', () => {
      assert.deepEqual(ok('/team/section:1').segments, ['team', 'section:1']);
      assert.deepEqual(ok('./section:1').segments, ['.', 'section:1']);
      assert.deepEqual(ok('../a:b').segments, ['..', 'a:b']);
      assert.deepEqual(ok('/RFC: design/demo').segments, ['RFC: design', 'demo']);
      for (const href of ['https://wiki.example/guide', 'javascript:alert(1)', 'mailto:a@b', 'section:1', 'a+b.c-d:x']) rejected(href);
    });

    it('rejects query, protocol-relative, query-only, fragment-only and empty segments', () => {
      for (const href of ['/guide?edit=1', '?a=1', '//wiki.example/guide', '#top', '/a//b', 'a//b', '']) rejected(href);
    });

    it('rejects control characters, backslash, surrounding whitespace and lone surrogates', () => {
      for (const href of ['/a\nb', '/a\u0000b', '/a\u007fb', '/a\u0085b', '/a\\b', ' /a', '/a ', '\t/a', '/a\uD800b', '/a\uDC00']) rejected(href);
    });

    it('rejects an empty or double fragment and a fragment with unsafe content', () => {
      for (const href of ['/a#', '/a#b#c', '/a#%', '/a#%ZZ', '/a#%25', '/a#a%5Cb', '/a#%0A', '/a#%C0%AF']) rejected(href);
      assert.equal(ok('/a#x?y/z').fragment, 'x?y/z');
      assert.equal(ok('/a#%E7%AB%A0').fragment, '章');
    });

    it('enforces the length bound before any other work', () => {
      const prefix = '/';
      assert.notEqual(parseArtifactPageLink(prefix + 'a'.repeat(ARTIFACT_LINK_MAX_LENGTH - 1)), null);
      assert.equal(parseArtifactPageLink(prefix + 'a'.repeat(ARTIFACT_LINK_MAX_LENGTH)), null);
    });
  });
});
