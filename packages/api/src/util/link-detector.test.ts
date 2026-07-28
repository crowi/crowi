import LinkDetector, { stripFragmentAndQuery } from 'src/util/link-detector';
import { crowi } from 'src/test/setup';

describe('Url test', () => {
  test('detectInternalLink', () => {
    const linkDetector = LinkDetector(crowi);

    let text = 'aaaaaaaa ';
    text += '[/user/suzuki/memo/2017/01/22/aaa](http://localhost:13001/58842b9ccf3556baedce2762)';
    text += ' bbbbb ';
    text += '[/user/suzuki/memo/2017/01/22/bbb](http://localhost:13001/58842b9ccf3556baedce2763)';
    text += 'ccccc';
    text += '</user/suzuki/memo/2017/01/22/ccc>';
    text += 'ddd';
    text += '[/user/suzuki/memo/2017/01/22/aaa](http://localhost:13001/58842b9ccf3556baedce2762)';
    text += ' bbbbb ';
    text += 'http://localhost:13001/user/suzuki/%E3%83%A1%E3%83%A2/2017/01/31/ddd#aaa';
    text += ' bbbbb ';
    text += 'http://localhost:13001/user/suzuki/メモ/2017/02/01/ddd?a=1';
    text += 'ee ';
    text += '[/user/suzuki/memo/2017/05/06/eee]';

    const results = linkDetector.search(text);

    expect(results).toHaveProperty('objectIds');
    expect(results.objectIds).toHaveLength(2);
    expect(results.objectIds).toEqual(expect.arrayContaining(['58842b9ccf3556baedce2762', '58842b9ccf3556baedce2763']));

    expect(results).toHaveProperty('paths');
    expect(results.paths).toHaveLength(4);
    expect(results.paths).toEqual(
      expect.arrayContaining([
        '/user/suzuki/memo/2017/01/22/ccc',
        '/user/suzuki/メモ/2017/01/31/ddd',
        '/user/suzuki/メモ/2017/02/01/ddd',
        '/user/suzuki/memo/2017/05/06/eee',
      ]),
    );
  });

  test('detects full-URL Markdown links to localhost in development (CLIENT_URL unset)', () => {
    // The dev reality: web app + api on localhost, `CLIENT_URL` left
    // unset. A page URL pasted from the address bar must still register.
    const prev = process.env.CLIENT_URL;
    process.env.CLIENT_URL = undefined;
    try {
      const linkDetector = LinkDetector(crowi);
      let text = '[by id](http://localhost:4302/6a06a5c87bfd4a3cbb851ab5) ';
      text += '[by path](http://localhost:4302/crowi/rfc/0003-realtime) ';
      text += '[external](http://example.com/6a06a5c87bfd4a3cbb851ab5)';

      const results = linkDetector.search(text);

      expect(results.objectIds).toContain('6a06a5c87bfd4a3cbb851ab5');
      expect(results.paths).toContain('/crowi/rfc/0003-realtime');
      // A non-loopback origin stays external — not a backlink.
      expect(results.paths).not.toContain('/6a06a5c87bfd4a3cbb851ab5');
    } finally {
      process.env.CLIENT_URL = prev;
    }
  });

  test('detects full-URL Markdown links whose origin matches CLIENT_URL', () => {
    const prev = process.env.CLIENT_URL;
    process.env.CLIENT_URL = 'https://wiki.example.com';
    try {
      const linkDetector = LinkDetector(crowi);
      let text = '[same host](https://wiki.example.com/crowi/rfc/0003-realtime) ';
      text += '[other host](https://other.example.com/foo/bar)';

      const results = linkDetector.search(text);

      expect(results.paths).toContain('/crowi/rfc/0003-realtime');
      expect(results.paths).not.toContain('/foo/bar');
    } finally {
      process.env.CLIENT_URL = prev;
    }
  });

  test('detects Markdown links with relative paths as backlinks', () => {
    const linkDetector = LinkDetector(crowi);

    let text = 'see [backlink for xyz2](/xyz2) and [other one](/foo/bar). ';
    // Markdown link whose href is a full URL is intentionally not picked up as a relative path —
    // linkRegexp handles that case.
    text += '[external](http://example.com/baz). ';
    // Angle-bracket and bare-bracket forms remain detected.
    text += '</wiki/style/path>';

    const results = linkDetector.search(text);

    expect(results.paths).toEqual(expect.arrayContaining(['/xyz2', '/foo/bar', '/wiki/style/path']));
    expect(results.paths).not.toContain('/baz');
  });

  // --- feature-page-link-space-paths Phase 1 -------------------------------

  describe('stripFragmentAndQuery', () => {
    it('drops a trailing #fragment', () => {
      expect(stripFragmentAndQuery('/a b#frag')).toBe('/a b');
    });

    it('drops a trailing ?query', () => {
      expect(stripFragmentAndQuery('/a b?x=1')).toBe('/a b');
    });

    it('leaves a plain path untouched', () => {
      expect(stripFragmentAndQuery('/a/b')).toBe('/a/b');
    });
  });

  describe('fragment/query contract, split by notation (fix scoped to angle-bracket only)', () => {
    test('(a) angle-bracket links strip a #fragment or ?query before lookup — real-space path is detected (fix)', () => {
      // getPathRegexps()[0] (`<(/[^>]+)>`) swallows everything up to the
      // closing `>`, so </a b#frag> / </a b?x=1> used to capture
      // '/a b#frag' / '/a b?x=1' whole and never find the real `/a b`
      // page. stripFragmentAndQuery now runs before decode for this
      // pattern only — see link-detector.ts's getPathRegexps()[0] comment.
      const linkDetector = LinkDetector(crowi);
      const results = linkDetector.search('[a](</a b#frag>) and [b](</a b?x=1>)');

      expect(results.paths).toContain('/a b');
      expect(results.paths).not.toContain('/a b#frag');
      expect(results.paths).not.toContain('/a b?x=1');
    });

    test('(b) ordinary Markdown links with a #fragment do not match at all — pre-existing, unchanged, no new detection added', () => {
      // pattern [2] (`\[[^\]]+\]\((\/[^)\s#]+)\)`) forbids `#` inside the
      // capture, so a destination with `#frag` fails to match the whole
      // link at all (not merely truncated) — no backlink is produced.
      // This is intentionally NOT fixed: widening [2]'s capture class was
      // considered and rejected during design review because it would
      // start matching link-like text inside code fences/inline code that
      // isn't a real link today (a new false-positive class this spec must
      // not introduce). Both %20 and + notations hit this same pre-existing
      // non-detection.
      const linkDetector = LinkDetector(crowi);
      const results = linkDetector.search('[a](/a%20b#frag) and [b](/a+b#frag)');

      expect(results.paths).not.toContain('/a b');
      expect(results.paths).not.toContain('/a%20b#frag');
      expect(results.paths).not.toContain('/a+b#frag');
    });

    test('(c) ordinary Markdown links with a ?query capture the query as part of a broken path candidate — pre-existing, unchanged', () => {
      // `?` is not excluded from pattern [2]'s capture class, so the match
      // succeeds but swallows `?x=1` into the captured path. The decoded
      // candidate ('/a b?x=1') never equals a real page path, so no
      // backlink to the real path is created either — this is a negative
      // test pinning down the broken candidate, not a claim that a
      // backlink to the real path appears.
      const linkDetector = LinkDetector(crowi);
      const results = linkDetector.search('[a](/a%20b?x=1) and [b](/a+b?x=1)');

      expect(results.paths).toContain('/a b?x=1');
      expect(results.paths).not.toContain('/a b');
    });
  });

  test('same-origin absolute URL links already exclude fragment/query from the capture — no fix needed (getLinkRegexp)', () => {
    // getLinkRegexp()'s capture (`[^\s"?)#]*`) excludes `#`/`?` from the
    // character class from the start, so this path was never broken:
    // neither a total match failure (like ordinary-link `#`, above) nor a
    // swallowed suffix (like angle-bracket, above) occurs here.
    const linkDetector = LinkDetector(crowi);
    const appUrl = crowi.baseUrl as string;
    const results = linkDetector.search(`[a](${appUrl}/a%20b#frag)`);

    expect(results.paths).toContain('/a b');
    expect(results.paths).not.toContain('/a b#frag');
  });

  describe('malformed percent-encoding hardening', () => {
    it('skips a malformed %-encoded link without throwing, other links in the same body survive', () => {
      const linkDetector = LinkDetector(crowi);
      const text = '[bad](/a%) and [good](/b)';

      let results: { paths: string[]; objectIds: string[] } | undefined;
      expect(() => {
        results = linkDetector.search(text);
      }).not.toThrow();
      expect(results?.paths).toEqual(['/b']);
    });

    it('skips a malformed %-encoded angle-bracket link too (stripFragmentAndQuery runs before the throwing decode)', () => {
      const linkDetector = LinkDetector(crowi);
      const text = '</a%> and [good](/b)';

      let results: { paths: string[]; objectIds: string[] } | undefined;
      expect(() => {
        results = linkDetector.search(text);
      }).not.toThrow();
      expect(results?.paths).toEqual(['/b']);
    });
  });

  test('a raw-space absolute path destination is not detected as a backlink via the regex-based `linkDetector.search` path (unchanged by Phase 2)', () => {
    // `getPathRegexps()[2]` deliberately never grows a raw-space-tolerant
    // pattern (see this file's/backlink.ts's Phase 2 comments) — a regex
    // can't distinguish a code-fenced raw-space token from a real one,
    // so widening the class here would create false backlinks the
    // renderer itself never turns into links. Phase 2's raw-space
    // recovery (`renderer/core/raw-space-links.ts`) still gets its
    // links backlinked, but via a SEPARATE, AST-based extraction step
    // in `Backlink.createBySavedPage` (walking `revision.renderedAst`
    // for `data.rawSpaceRecovered === true` marker nodes) — see
    // `backlink.test.ts`'s "raw-space recovered links" coverage.
    const linkDetector = LinkDetector(crowi);
    const results = linkDetector.search('[a](/a b)');

    expect(results.paths).not.toContain('/a b');
  });
});
