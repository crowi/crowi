import type { Command } from 'commander';

import { type GlobalOptions, getGlobalOptions } from '../cli';
import { loadConfig, type Profile, resolveProfile } from '../lib/config';
import { CliError, EXIT } from '../lib/http';

/**
 * Re-throw an error, but when it is an OAuth `INSUFFICIENT_SCOPE` / 403
 * failure (the Phase 2 commands need scopes outside the default login set —
 * `comments:*` / `attachments:*` / `bookmarks:*`), replace the raw API
 * message with an actionable "re-login with --scope" hint. `neededScope` is
 * the space-delimited scope(s) the command requires.
 */
export function rethrowScopeHint(err: unknown, neededScope: string): never {
  if (err instanceof CliError && (err.apiCode === 'INSUFFICIENT_SCOPE' || err.status === 403)) {
    throw new CliError(`your token lacks the required scope — re-login granting it: \`crowi login --scope "${neededScope}"\``, {
      exitCode: EXIT.FORBIDDEN,
      apiCode: err.apiCode,
      status: err.status,
    });
  }
  throw err;
}

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
