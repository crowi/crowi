import Crowi from 'src/crowi';
import { decodeSpace } from './path';

export default (crowi: Crowi) => {
  // const debug = Debug('crowi:lib:url')
  const linkDetector: any = {};

  linkDetector.getLinkRegexp = () => {
    const appUrl = crowi.getBaseUrl();
    return new RegExp(appUrl + '(/[^\\s"?)#]*)?', 'g');
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
