module.exports = function() {
  var versionParser = {};

  versionParser.parse = function(version) {
    var major = 0;
    var minor = 0;
    var revision = 0;

    if (version.match(/^(\d+)\.(\d+)\.(\d+)$/)) {
      major    = +(RegExp.$1);
      minor    = +(RegExp.$2);
      revision = +(RegExp.$3);
    }

    return {
      major: major,
      minor: minor,
      revision: revision,
    };
  };

  return versionParser;
}
