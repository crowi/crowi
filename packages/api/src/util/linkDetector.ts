import Crowi from 'src/crowi';
import { decodeSpace } from './path';

export default (crowi: Crowi) => {
  // const debug = Debug('crowi:lib:url')
  const linkDetector: any = {};

  const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

  linkDetector.getLinkRegexp = () => {
    const origins = linkDetector.getAppOrigins();
    // No configured app origin — match nothing, rather than building
    // `RegExp('null(/…)?')` from a null base url (which would match the
    // literal text "null" in page bodies).
    if (origins.length === 0) {
      return /(?!)/g;
    }
    const alternation = origins.map(escapeRegExp).join('|');
    return new RegExp('(?:' + alternation + ')(/[^\\s"?)#]*)?', 'g');
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
      const path = decodeSpace(decodeURIComponent(RegExp.$1));
      if (objectIdRegexp.test(path)) {
        objectIds.push(RegExp.$1);
      } else {
        paths.push(path);
      }
    }

    const pathRegexps = linkDetector.getPathRegexps();
    for (const pathRegexp of pathRegexps) {
      while (pathRegexp.exec(text)) {
        paths.push(decodeSpace(decodeURIComponent(RegExp.$1)));
      }
    }

    return {
      objectIds: unique(objectIds),
      paths: unique(paths),
    };
  };

  return linkDetector;
};
