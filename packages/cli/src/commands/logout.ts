import type { Command } from 'commander';

import { getGlobalOptions } from '../cli';
import { loadConfig, removeProfile } from '../lib/config';
import { CliError, EXIT } from '../lib/http';
import { revokeToken } from '../lib/oauth';
import { info } from '../lib/output';

/**
 * `crowi logout [--profile <alias>]` — revoke the stored refresh token
 * (best-effort, RFC 7009) then remove the profile from the local store. An
 * ad-hoc `--url`/`--token` target has nothing to remove, so this only acts
 * on a real named profile.
 */
export function registerLogout(program: Command): void {
  program
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
        await revokeToken(revokeEndpoint, refreshToken);
      }

      removeProfile(alias);
      info(`Logged out of "${alias}".`, globals);
    });
}
