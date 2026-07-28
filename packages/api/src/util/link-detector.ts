import Crowi from 'src/crowi';
import { decodeSpace } from './path';
import { escapeRegExp } from './regex';

/**
 * Drop a trailing `#fragment` or `?query` suffix from a captured path-like
 * string. Only `getPathRegexps()[0]` (the `<...>` angle-bracket form) needs
 * this: its capture (`<(/[^>]+)>`) swallows everything up to the closing
 * `>`, so `</a b#frag>` / `</a b?x=1>` capture `/a b#frag` / `/a b?x=1`
 * whole — looking that up as a page path never finds the real
 * `/a b` page. Exported so `Backlink`/renderedAst-based extraction (Phase 2)
 * can reuse the same fragment/query contract instead of re-deriving it.
 */
export const stripFragmentAndQuery = (path: string): string => {
  const idx = path.search(/[?#]/);
  return idx === -1 ? path : path.slice(0, idx);
};

/**
 * `decodeSpace(decodeURIComponent(raw))`, returning `null` instead of
 * throwing on malformed percent-encoding (e.g. a stray `/a%`). Shared by
 * both extraction loops below so a single malformed link never aborts
 * extraction for the rest of the body — `Backlink.createBySavedPage`
 * relies on this to keep a page's other, well-formed backlinks alive.
 * Exported so the Phase 2 `renderedAst`-based extraction (raw-space
 * recovered links, `Backlink.createBySavedPage`) can decode with the
 * exact same semantics — including the same malformed-percent
 * tolerance — instead of duplicating this one-liner.
 */
export const decodeLinkPath = (raw: string): string | null => {
  try {
    return decodeSpace(decodeURIComponent(raw));
  } catch {
    return null;
  }
};

export default (crowi: Crowi) => {
  // const debug = Debug('crowi:lib:url')
  const linkDetector: any = {};

  /**
   * Origins that count as "this Crowi instance" when classifying an
   * absolute-URL link as internal. Both are included because they can
   * differ — `getBaseUrl()` is the api's `BASE_URL` / `app:url` config,
   * while `CLIENT_URL` is the web app's public origin, and a user
   * copies page URLs from the latter (e.g. `http://localhost:4302/...`).
   * Trailing slashes are trimmed and duplicates dropped.
   */
  linkDetector.getAppOrigins = (): string[] => {
    const raw = [crowi.getBaseUrl(), process.env.CLIENT_URL];
    const origins: string[] = [];
    const seen = new Set<string>();
    for (const candidate of raw) {
      if (!candidate || typeof candidate !== 'string') continue;
      const normalized = candidate.replace(/\/+$/, '');
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        origins.push(normalized);
      }
    }
    return origins;
  };

  /**
   * Loopback-origin pattern (`http(s)://localhost|127.0.0.1|[::1]` on any
   * port). In development the web app and the api both run on localhost
   * and `CLIENT_URL` is frequently left unset; without this a page URL
   * pasted from the dev address bar (`http://localhost:4302/…`) would
   * not register as a backlink. Restricted to non-production so a
   * production instance only trusts its configured origins.
   */
  const LOOPBACK_ORIGIN = 'https?://(?:localhost|127\\.0\\.0\\.1|\\[::1\\])(?::\\d+)?';

  linkDetector.getLinkRegexp = () => {
    const alternatives = linkDetector.getAppOrigins().map(escapeRegExp);
    if (process.env.NODE_ENV !== 'production') {
      alternatives.push(LOOPBACK_ORIGIN);
    }
    // No origin to match against — return a never-match regexp rather
    // than building `RegExp('null(/…)?')` from a null base url (which
    // would match the literal text "null" in page bodies).
    if (alternatives.length === 0) {
      return /(?!)/g;
    }
    return new RegExp('(?:' + alternatives.join('|') + ')(/[^\\s"?)#]*)?', 'g');
  };

  linkDetector.getObjectIdRegexp = () => new RegExp('/([0-9a-fA-F]{24})');

  // [0] `<...>`: angle-bracket wiki link
  // [1] `[/path]`: bare bracket form, only when NOT followed by `(` (= not a Markdown link)
  // [2] `[label](/path)`: Markdown link whose target is a same-host relative path.
  //     Markdown links pointing at full URLs (http://…) are handled by linkRegexp instead.
  linkDetector.getPathRegexps = () => [new RegExp('<(/[^>]+)>', 'g'), /\[(\/[^\]]+)\](?!\()/g, /\[[^\]]+\]\((\/[^)\s#]+)\)/g];

  linkDetector.search = function (text) {
    const unique = function (array) {
      return array.filter(function (x, i, self) {
        return self.indexOf(x) === i;
      });
    };

    const objectIds: any = [];
    const paths: any = [];

    const linkRegexp = linkDetector.getLinkRegexp();
    const objectIdRegexp = linkDetector.getObjectIdRegexp();

    while (linkRegexp.exec(text)) {
      // getLinkRegexp()'s capture (`[^\s"?)#]*`) already excludes `#`/`?`
      // from the character class, so no stripFragmentAndQuery is needed
      // on this path — see link-detector.test.ts for the regression that
      // pins this down.
      const path = decodeLinkPath(RegExp.$1);
      if (path === null) continue;
      if (objectIdRegexp.test(path)) {
        objectIds.push(RegExp.$1);
      } else {
        paths.push(path);
      }
    }

    const pathRegexps = linkDetector.getPathRegexps();
    pathRegexps.forEach((pathRegexp, index) => {
      while (pathRegexp.exec(text)) {
        // Only the angle-bracket pattern ([0]) swallows a trailing
        // `#fragment`/`?query` into its capture. The bare-bracket ([1])
        // and ordinary Markdown ([2]) patterns are deliberately left
        // alone: [2] already fails to match a `#`-suffixed destination at
        // all (pre-existing, not a bug this spec fixes), and widening its
        // capture class to swallow `#`/`?` would start matching link-like
        // text inside code fences/inline code that isn't a real link
        // today (rejected during design review — see spec §"設計の主な判断").
        const raw = index === 0 ? stripFragmentAndQuery(RegExp.$1) : RegExp.$1;
        const path = decodeLinkPath(raw);
        if (path !== null) paths.push(path);
      }
    });

    return {
      objectIds: unique(objectIds),
      paths: unique(paths),
    };
  };

  return linkDetector;
};
