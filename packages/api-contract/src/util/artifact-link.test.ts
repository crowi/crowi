/**
 * Unit test for `parseArtifactPageLink`. Run with `node --test` (built-in runner).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ARTIFACT_LINK_MAX_LENGTH, parseArtifactPageLink, parseArtifactPageLinkDetailed } from './artifact-link';

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
  describe('parseArtifactPageLinkDetailed (AC-AAG-2)', () => {
    const code = (href: string) => {
      const result = parseArtifactPageLinkDetailed(href);
      assert.equal(result.ok, false, `expected ${JSON.stringify(href)} rejected`);
      return result.ok ? null : result.diagnosticCode;
    };

    it('classifies a refusal in the fixed priority order', () => {
      assert.equal(code('/guide?edit=1'), 'PAGE_LINK_QUERY');
      assert.equal(code('guide?x'), 'PAGE_LINK_QUERY');
      assert.equal(code('/100%off'), 'PAGE_LINK_PERCENT_ENCODING');
      assert.equal(code('/100%done'), 'PAGE_LINK_PERCENT_ENCODING');
      assert.equal(code('/%2G'), 'PAGE_LINK_PERCENT_ENCODING');
      assert.equal(code('/100%'), 'PAGE_LINK_PERCENT_ENCODING');
      assert.equal(code('/%C0%AF'), 'PAGE_LINK_PERCENT_ENCODING');
      assert.equal(code('/%2fadmin'), 'PAGE_LINK_INVALID');
      assert.equal(code('https://example.com'), 'PAGE_LINK_INVALID');
      assert.equal(code('mailto:a@b.com'), 'PAGE_LINK_INVALID');
      assert.equal(code('//example.com/guide'), 'PAGE_LINK_INVALID');
      assert.equal(code('#'), 'PAGE_LINK_INVALID');
      assert.equal(code('#a?b'), 'PAGE_LINK_INVALID');
      assert.equal(code(''), 'PAGE_LINK_INVALID');
      assert.equal(code('/a\\b'), 'PAGE_LINK_INVALID');
      assert.equal(code('/a#'), 'PAGE_LINK_INVALID');
      assert.equal(code('/a#b#c'), 'PAGE_LINK_INVALID');
      assert.equal(code('/a#%'), 'PAGE_LINK_INVALID');
    });

    it('lets structure win over query, and query over escapes', () => {
      assert.equal(code('https://x/y?z=%'), 'PAGE_LINK_INVALID');
      assert.equal(code('//x/y?z'), 'PAGE_LINK_INVALID');
      assert.equal(code('/a?b=%'), 'PAGE_LINK_QUERY');
      assert.equal(code('/%ZZ#a%'), 'PAGE_LINK_PERCENT_ENCODING');
    });

    it('does not read a ? inside a fragment as a query', () => {
      const result = parseArtifactPageLinkDetailed('/guide#what?next');
      assert.equal(result.ok, true);
    });

    it('accepts the documented literal-percent spelling and never re-decodes', () => {
      const ok25 = parseArtifactPageLinkDetailed('/100%25off');
      assert.equal(ok25.ok && ok25.link.segments[0], '100%off');
      const nested = parseArtifactPageLinkDetailed('/%252e%252e/admin');
      assert.equal(nested.ok && nested.link.segments[0], '%2e%2e');
    });

    it('rejects over-long input before any other work', () => {
      assert.equal(code('/' + 'a'.repeat(ARTIFACT_LINK_MAX_LENGTH)), 'PAGE_LINK_INVALID');
    });

    it('agrees with the null-returning wrapper on every input', () => {
      const inputs = [
        '/',
        '/team/guide',
        './guide',
        '../guide#overview',
        'guide',
        '',
        '#',
        '#top',
        '/a#',
        '/a?b',
        '/a//b',
        '/100%off',
        '/100%25off',
        '/%2G',
        'https://x',
        'mailto:a@b',
        'my page/資料',
        '資料#章+1',
        '/a\\b',
        ' /a',
        '/a#%25',
        '/a#x?y/z',
        '/%252e%252e/x',
        './section:1',
        'section:1',
        '/' + 'a'.repeat(ARTIFACT_LINK_MAX_LENGTH),
        '/' + 'a'.repeat(ARTIFACT_LINK_MAX_LENGTH - 1),
      ];
      for (const href of inputs) {
        const detailed = parseArtifactPageLinkDetailed(href);
        assert.deepEqual(parseArtifactPageLink(href), detailed.ok ? detailed.link : null, JSON.stringify(href));
      }
    });
  });
});
