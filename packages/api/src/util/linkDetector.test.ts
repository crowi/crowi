import LinkDetector from 'src/util/linkDetector';
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

  test('detects Markdown links whose href is a full CLIENT_URL', () => {
    // A user copies a page URL from the address bar — that origin is
    // `CLIENT_URL` (the web app), which can differ from the api's
    // `getBaseUrl()`. linkDetector must still classify it as internal.
    const prev = process.env.CLIENT_URL;
    process.env.CLIENT_URL = 'http://localhost:4302';
    try {
      const linkDetector = LinkDetector(crowi);
      let text = '[by id](http://localhost:4302/6a06a5c87bfd4a3cbb851ab5) ';
      text += '[by path](http://localhost:4302/crowi/rfc/0003-realtime) ';
      text += '[external](http://example.com/6a06a5c87bfd4a3cbb851ab5)';

      const results = linkDetector.search(text);

      expect(results.objectIds).toContain('6a06a5c87bfd4a3cbb851ab5');
      expect(results.paths).toContain('/crowi/rfc/0003-realtime');
      // A different origin is still external — not a backlink.
      expect(results.paths).not.toContain('/6a06a5c87bfd4a3cbb851ab5');
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
});
