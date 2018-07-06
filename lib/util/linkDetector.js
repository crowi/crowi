module.exports = function(crowi) {
  'use strict'

  // const debug = require('debug')('crowi:lib:url')
  var linkDetector = {}

  linkDetector.getLinkRegexp = () => {
    const appUrl = crowi.config.crowi['app:url']
    return new RegExp(appUrl + '(/[^\\s"?)#]*)?', 'g')
  }

  linkDetector.getObjectIdRegexp = () => new RegExp('/([0-9a-fA-F]{24})')

  linkDetector.getPathRegexps = () => [new RegExp('<(/[^>]+)>', 'g'), /\[(\/[^\]]+)\](?!\()/g]

  linkDetector.search = function(text) {
    var unique = function(array) {
      return array.filter(function(x, i, self) {
        return self.indexOf(x) === i
      })
    }

    var objectIds = []
    var paths = []

    const linkRegexp = linkDetector.getLinkRegexp()
    const objectIdRegexp = linkDetector.getObjectIdRegexp()

    while (linkRegexp.exec(text)) {
      var path = decodeURIComponent(RegExp.$1)
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
