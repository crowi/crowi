module.exports = function(crowi) {
  'use strict';

  const debug = require('debug')('crowi:lib:url');
  var linkDetector = {};

  linkDetector.search = function(text) {
    const appUrl = crowi.config.crowi['app:url'];

    var unique = function(array) {
      return array.filter(function (x, i, self) {
            return self.indexOf(x) === i;
      });
    };

    var objectIds = [];
    var paths = [];

    const linkRegexp = new RegExp(appUrl + '(/[^\\s"\?\)#]*)?', 'g');
    const objectIdRegexp = new RegExp('/([0-9a-fA-F]{24})');

    while (linkRegexp.exec(text)) {
      var path = decodeURIComponent(RegExp.$1);
      if (objectIdRegexp.test(path)) {
        objectIds.push(RegExp.$1);
      } else {
        paths.push(path);
      }
    }

    const pathRegexp = new RegExp('<(/[^>]+)>', 'g');
    while (pathRegexp.exec(text)) {
      paths.push(RegExp.$1);
    }

    return {
      objectIds: unique(objectIds),
      paths: unique(paths),
    };
  };

  return linkDetector;
};
