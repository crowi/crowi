import type { Command } from 'commander';

import { getGlobalOptions } from '../cli';
import { loadConfig, removeProfile } from '../lib/config';
import { CliError, EXIT } from '../lib/http';
import { revokeToken } from '../lib/oauth';
import { info, warn } from '../lib/output';
import { markNoSkewProbe } from '../lib/skew';

/**
 * `crowi logout [--profile <alias>]` — revoke the stored refresh token
 * (RFC 7009) then remove the profile from the local store. An ad-hoc
 * `--url`/`--token` target has nothing to remove, so this only acts on a
 * real named profile.
 *
 * Removing the local profile always proceeds even when server-side revoke
 * fails — a network-unreachable server must not strand the user's local
 * credentials — but a failed revoke is never reported as a silent success:
 * `revokeToken()` is status-aware (e.g. a profile whose cached endpoint
 * still targets a pre-`/api`-cutover path 404s), and this command warns the
 * user that the server-side token is still live so they know to `crowi
 * login` again or ask an admin to revoke it out-of-band.
 */
export function registerLogout(program: Command): void {
  const cmd = program
    .command('logout')
    .description('Revoke the stored credentials and remove the profile')
    .action(async (_options: unknown, command: Command) => {
      const globals = getGlobalOptions(command);
      const config = loadConfig();
      // Resolve a real profile by alias (not the ad-hoc --url/--token path):
      // logout only makes sense for a persisted profile.
      const alias = globals.profile ?? process.env.CROWI_PROFILE ?? config.currentProfile;
      if (!alias || !config.profiles[alias]) {
        throw new CliError('no profile to log out of — run `crowi profiles` to list profiles', { exitCode: EXIT.UNAUTHENTICATED });
      }
      const profile = config.profiles[alias];

      const refreshToken = profile.tokens?.refreshToken;
      const revokeEndpoint = profile.oauth?.revokeEndpoint;
      if (refreshToken && revokeEndpoint) {
        info(`Revoking credentials for "${alias}"…`, globals);
        const revoked = await revokeToken(revokeEndpoint, refreshToken);
        if (!revoked) {
          warn(
            `could not revoke the server-side token for "${alias}" — local credentials were removed, but the token may ` +
              'still be valid on the server. Run `crowi login` again to rotate it, or ask an administrator to revoke it.',
          );
        }
      }

      removeProfile(alias);
      info(`Logged out of "${alias}".`, globals);
    });
  // Pre-auth / local: no usable token to probe a server with.
  markNoSkewProbe(cmd);
}
