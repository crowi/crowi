const path = require('path');
const fs = require('graceful-fs');

const PluginUtilsV2 = require('./plugin-utils-v2');

const pluginUtilsV2 = new PluginUtilsV2();

class PluginUtils {

  /**
   * return a definition objects that has following structure:
   *
   * {
   *   name: 'crowi-plugin-X',
   *   meta: require('crowi-plugin-X'),
   *   entries: [
   *     'crowi-plugin-X/lib/client-entry'
   *   ]
   * }
   *
   * @param {string} pluginName
   * @return
   * @memberOf PluginService
   */
  generatePluginDefinition(name, isForClient = false) {
    const meta = require(name);
    let definition;

    switch (meta.pluginSchemaVersion) {
      // v1 is deprecated
      case 1:
        console.log('pluginSchemaVersion 1 is deprecated');
        debug('pluginSchemaVersion 1 is deprecated');
        break;
      // v2 or above
      case 2:
      default:
        definition = pluginUtilsV2.generatePluginDefinition(name, isForClient);
    }

    return definition;
  }

  /**
   * list plugin module objects that starts with 'crowi-plugin-'
   * borrowing from: https://github.com/hexojs/hexo/blob/d1db459c92a4765620343b95789361cbbc6414c5/lib/hexo/load_plugins.js#L17
   *
   * @returns array of objects
   *   [
   *     { name: 'crowi-plugin-...', version: '1.0.0' },
   *     { name: 'crowi-plugin-...', version: '1.0.0' },
   *     ...
   *   ]
   *
   * @memberOf PluginService
   */
  listPlugins(rootDir) {
    var packagePath = path.join(rootDir, 'package.json');

    // Make sure package.json exists
    if (!fs.existsSync(packagePath)) {
      return [];
    }

    // Read package.json and find dependencies
    const content = fs.readFileSync(packagePath);
    const json = JSON.parse(content);
    const deps = json.dependencies || {};

    let objs = {};
    Object.keys(deps).forEach((name) => {
      if (/^crowi-plugin-/.test(name)) {
        objs[name] = deps[name];
      }
    });

    return objs;
  }

  /**
   * list plugin module names that starts with 'crowi-plugin-'
   *
   * @returns array of plugin names
   *
   * @memberOf PluginService
   */
  listPluginNames(rootDir) {
    const plugins = this.listPlugins(rootDir);
    return Object.keys(plugins);
  }
}

module.exports = PluginUtils
