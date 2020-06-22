import Crowi from 'server/crowi'
import { decodeSpace } from './path'

export default (crowi: Crowi) => {
  // const debug = Debug('crowi:lib:url')
  const linkDetector: any = {}

  linkDetector.getLinkRegexp = () => {
    const appUrl = crowi.getBaseUrl()
    return new RegExp(appUrl + '(/[^\\s"?)#]*)?', 'g')
  }

  linkDetector.getObjectIdRegexp = () => new RegExp('/([0-9a-fA-F]{24})')

  linkDetector.getPathRegexps = () => [new RegExp('<(/[^>]+)>', 'g'), /\[(\/[^\]]+)\](?!\()/g]

  linkDetector.search = function(text) {
    const unique = function(array) {
      return array.filter(function(x, i, self) {
        return self.indexOf(x) === i
      })
    }

    const objectIds: any = []
    const paths: any = []

    const linkRegexp = linkDetector.getLinkRegexp()
    const objectIdRegexp = linkDetector.getObjectIdRegexp()

    while (linkRegexp.exec(text)) {
      const path = decodeSpace(decodeURIComponent(RegExp.$1))
      if (objectIdRegexp.test(path)) {
        objectIds.push(RegExp.$1)
      } else {
        paths.push(path)
      }
    }

    const pathRegexp = linkDetector.getPathRegexps()[0]
    while (pathRegexp.exec(text)) {
      paths.push(RegExp.$1)
    }

    const pathRegexp2 = linkDetector.getPathRegexps()[1]
    while (pathRegexp2.exec(text)) {
      paths.push(RegExp.$1)
    }

    return {
      objectIds: unique(objectIds),
      paths: unique(paths),
    }
  }

  return linkDetector
}
