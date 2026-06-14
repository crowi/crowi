import type { Command } from 'commander';

import { type GlobalOptions, getGlobalOptions } from '../cli';
import { loadConfig, type Profile, resolveProfile } from '../lib/config';
import { CliError, EXIT } from '../lib/http';

/**
 * Resolve the profile + global options a command should act on, requiring a
 * usable access token. Throws a {@link CliError} (exit 2) when no profile
 * resolves or it has no token — every authenticated command funnels through
 * here so the "run `crowi login` first" message is consistent.
 */
export function requireProfile(command: Command): { profile: Profile; globals: GlobalOptions } {
  const globals = getGlobalOptions(command);
  const config = loadConfig();
  const profile = resolveProfile(config, { profile: globals.profile, url: globals.url, token: globals.token });
  if (!profile) {
    throw new CliError('not signed in — run `crowi login <url>` first', { exitCode: EXIT.UNAUTHENTICATED });
  }
  if (!profile.tokens?.accessToken) {
    throw new CliError(`profile "${profile.alias}" has no access token — run \`crowi login\` first`, { exitCode: EXIT.UNAUTHENTICATED });
  }
  return { profile, globals };
}
