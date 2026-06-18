/**
 * The plugin's npm package name. Doubles as the config namespace
 * (`plugin:@crowi/plugin-slack:*`) and the `<name>` path segment in the
 * mounted route `/api/v2/plugins/@crowi/plugin-slack/<path>`. Single
 * source of truth so the manifest's `request_url`, the route mount, and
 * `package.json:name` cannot drift apart.
 */
export const PLUGIN_NAME = '@crowi/plugin-slack';
