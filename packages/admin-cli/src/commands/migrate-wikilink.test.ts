import { KNOWN_HTML_ELEMENTS, detectWikilinks, rewriteWikilinks, shouldRewriteWikilink } from './migrate-wikilink';

describe('migrate-wikilink: detection rules', () => {
  describe('shouldRewriteWikilink — positive matches', () => {
    it.each([['/foo'], ['/foo/bar'], ['/foo/bar/baz'], ['/docs/api'], ['/setup-guide']])('accepts %s', (innerPath) => {
      expect(shouldRewriteWikilink(innerPath)).toBe(true);
    });

    it('accepts paths with anchor segments', () => {
      expect(shouldRewriteWikilink('/docs/api#auth')).toBe(true);
    });

    it('accepts deep paths even when an intermediate segment is HTML-like', () => {
      // HTML element rejection is ONLY against the first segment.
      // `/docs/section` is not the same shape as `</section>` and should
      // pass — the actual top-level page is `/docs`.
      expect(shouldRewriteWikilink('/docs/section')).toBe(true);
      expect(shouldRewriteWikilink('/foo/div')).toBe(true);
    });

    it('accepts paths whose first segment LOOKS like HTML but contains an uppercase letter', () => {
      // Plain Crowi pages are case-sensitive; v1 LinkDetector didn't
      // do case-folding either. Documenting the boundary: `Section`
      // !== `section` so `</Section>` SHOULD be treated as a link.
      expect(shouldRewriteWikilink('/Section')).toBe(true);
      expect(shouldRewriteWikilink('/Div/things')).toBe(true);
    });
  });

  describe('shouldRewriteWikilink — negative matches (HTML elements)', () => {
    it.each([
      ['/section'],
      ['/div'],
      ['/a'],
      ['/br'],
      ['/iframe'],
      ['/article'],
      ['/p'],
      ['/span'],
      ['/h1'],
      ['/h6'],
      ['/script'],
      ['/style'],
    ])('rejects %s (HTML element)', (innerPath) => {
      expect(shouldRewriteWikilink(innerPath)).toBe(false);
    });

    it('rejects HTML elements with trailing slashes or anchors', () => {
      expect(shouldRewriteWikilink('/section/foo')).toBe(false);
      expect(shouldRewriteWikilink('/div#anchor')).toBe(false);
    });

    it('rejects `/` alone (stray markup)', () => {
      expect(shouldRewriteWikilink('/')).toBe(false);
    });

    it('rejects inputs that do not start with `/`', () => {
      expect(shouldRewriteWikilink('foo')).toBe(false);
      expect(shouldRewriteWikilink('foo/bar')).toBe(false);
    });
  });

  describe('KNOWN_HTML_ELEMENTS coverage', () => {
    it('covers all common void elements', () => {
      for (const el of ['br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']) {
        expect(KNOWN_HTML_ELEMENTS.has(el)).toBe(true);
      }
    });

    it('covers heading tags h1 through h6', () => {
      for (const level of [1, 2, 3, 4, 5, 6]) {
        expect(KNOWN_HTML_ELEMENTS.has(`h${level}`)).toBe(true);
      }
    });

    it('does NOT include random non-HTML identifiers', () => {
      for (const word of ['docs', 'foo', 'bar', 'page', 'wiki', 'home']) {
        expect(KNOWN_HTML_ELEMENTS.has(word)).toBe(false);
      }
    });
  });
});

describe('migrate-wikilink: detectWikilinks', () => {
  it('returns an empty array when the body has no occurrences', () => {
    expect(detectWikilinks('plain markdown content')).toEqual([]);
    expect(detectWikilinks('')).toEqual([]);
    expect(detectWikilinks('with [[/already-wikilinked]] form')).toEqual([]);
  });

  it('detects a single </path> occurrence', () => {
    const result = detectWikilinks('see </docs/api> for details');
    expect(result).toEqual([{ raw: '</docs/api>', path: '/docs/api' }]);
  });

  it('detects multiple occurrences in the same body', () => {
    const body = 'first </docs/api>, then </guide/intro> and finally </faq>';
    const result = detectWikilinks(body);
    expect(result).toEqual([
      { raw: '</docs/api>', path: '/docs/api' },
      { raw: '</guide/intro>', path: '/guide/intro' },
      { raw: '</faq>', path: '/faq' },
    ]);
  });

  it('detects path-with-anchor', () => {
    const result = detectWikilinks('jump to </docs/api#auth>');
    expect(result).toEqual([{ raw: '</docs/api#auth>', path: '/docs/api#auth' }]);
  });

  it('detects path-with-alias', () => {
    const result = detectWikilinks('refer to </docs/api|API Reference>');
    expect(result).toEqual([{ raw: '</docs/api|API Reference>', path: '/docs/api', alias: 'API Reference' }]);
  });

  // alias with whitespace would actually NOT match because the regex
  // forbids whitespace inside the alias segment; document that
  // boundary explicitly via the positive `no-whitespace` test above
  // (`API` without the space-and-Reference would match).

  it('ignores HTML close tags (negative matches)', () => {
    const body = '<section>foo</section> and <div>bar</div> and </a href="..."> and </iframe>';
    const result = detectWikilinks(body);
    expect(result).toEqual([]);
  });

  it('mixes HTML and wikilink in the same body and only collects the wikilink', () => {
    const body = 'inside <section>see </docs/api> here</section>';
    const result = detectWikilinks(body);
    expect(result).toEqual([{ raw: '</docs/api>', path: '/docs/api' }]);
  });

  it('ignores `</a href="...">` (whitespace inside breaks the match)', () => {
    expect(detectWikilinks('<a href="x">text</a href="x">')).toEqual([]);
  });

  it('ignores `</br>` even when used as a self-closing-ish form', () => {
    expect(detectWikilinks('line1</br>line2')).toEqual([]);
  });

  it('ignores paths starting with the named anchor `#` (no leading `/`)', () => {
    expect(detectWikilinks('jump <#anchor>')).toEqual([]);
  });

  it('handles repeat scans deterministically (regex lastIndex reset)', () => {
    // Global regex state is reset internally so re-calling on a fresh
    // body returns the same result.
    const body = 'a </one> b </two> c';
    expect(detectWikilinks(body)).toHaveLength(2);
    expect(detectWikilinks(body)).toHaveLength(2);
  });
});

describe('migrate-wikilink: rewriteWikilinks', () => {
  it('returns the input unchanged when there are no occurrences', () => {
    const body = 'no v1 angle-bracket links here';
    expect(rewriteWikilinks(body)).toBe(body);
  });

  it('rewrites `</path>` to `[[/path]]`', () => {
    expect(rewriteWikilinks('see </docs/api> for details')).toBe('see [[/docs/api]] for details');
  });

  it('rewrites multiple occurrences in one body', () => {
    const body = 'first </docs/api>, then </guide/intro>, and </faq>';
    const expected = 'first [[/docs/api]], then [[/guide/intro]], and [[/faq]]';
    expect(rewriteWikilinks(body)).toBe(expected);
  });

  it('preserves anchor segments', () => {
    expect(rewriteWikilinks('jump </docs/api#auth>')).toBe('jump [[/docs/api#auth]]');
  });

  it('preserves alias segments', () => {
    expect(rewriteWikilinks('refer </docs/api|API Reference>')).toBe('refer [[/docs/api|API Reference]]');
  });

  it('leaves HTML close tags alone', () => {
    const body = '<section>foo</section> and <div>bar</div>';
    expect(rewriteWikilinks(body)).toBe(body);
  });

  it('rewrites wikilinks while leaving adjacent HTML close tags untouched', () => {
    const body = '<section>see </docs/api> here</section>';
    const expected = '<section>see [[/docs/api]] here</section>';
    expect(rewriteWikilinks(body)).toBe(expected);
  });

  it('is idempotent (running rewrite twice yields the same result)', () => {
    const body = 'see </docs/api> for details';
    const first = rewriteWikilinks(body);
    const second = rewriteWikilinks(first);
    expect(second).toBe(first);
  });

  it('handles wikilinks adjacent to each other without space', () => {
    expect(rewriteWikilinks('</a-real-page></another-page>')).toBe('[[/a-real-page]][[/another-page]]');
  });

  it('does NOT rewrite when only HTML close tags appear', () => {
    expect(rewriteWikilinks('</div></section></br></iframe>')).toBe('</div></section></br></iframe>');
  });
});
