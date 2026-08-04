import type { Command } from 'commander';

import { getGlobalOptions } from '../cli';
import { loadConfig, ProfileNotFoundError, setCurrentProfile } from '../lib/config';
import { CliError, EXIT } from '../lib/http';
import { info, render } from '../lib/output';
import { markNoSkewProbe } from '../lib/skew';

/**
 * Switch the persisted current/default profile. Delegates entirely to
 * `setCurrentProfile` (same read-then-atomic-write as every other config
 * mutation) — the only local responsibility is turning its `ProfileNotFoundError`
 * into a `CliError` carrying the CLI's not-found exit code, so an unknown
 * alias gets the `crowi: <message>` / exit 4 treatment. Any OTHER failure
 * (config parse error, atomic-write I/O failure, ...) is rethrown as-is and
 * falls through to the CLI's general error handling (exit 1) — it is not a
 * "no such profile" condition. `setCurrentProfile` itself never touches the
 * file when the alias doesn't exist, so a failed `use` is a true no-op.
 */
function runUse(alias: string): void {
  try {
    setCurrentProfile(alias);
  } catch (err) {
    if (err instanceof ProfileNotFoundError) {
      throw new CliError(err.message, { exitCode: EXIT.NOT_FOUND });
    }
    throw err;
  }
}

/**
 * `crowi profiles` — list the locally-configured profiles (no network).
 * Marks the current/default profile and shows each endpoint + granted scope
 * so a user can see which servers they are signed in to. `crowi profiles
 * use <alias>` is registered as a child command below to switch it.
 */
export function registerProfiles(program: Command): void {
  const cmd = program
    .command('profiles')
    .description('List configured profiles (local; no network)')
    .action((_options: unknown, command: Command) => {
      const globals = getGlobalOptions(command);
      const config = loadConfig();
      const entries = Object.values(config.profiles);

      render(
        {
          currentProfile: config.currentProfile,
          profiles: entries.map((p) => ({
            alias: p.alias,
            endpoint: p.endpoint,
            account: p.account,
            scope: p.tokens?.scope,
            current: p.alias === config.currentProfile,
          })),
        },
        () => {
          if (entries.length === 0) {
            return 'No profiles configured. Run `crowi login <url>` to add one.';
          }
          return entries
            .map((p) => {
              const marker = p.alias === config.currentProfile ? '*' : ' ';
              const account = p.account ? ` (${p.account})` : '';
              const scope = p.tokens?.scope ? `  [${p.tokens.scope}]` : '';
              return `${marker} ${p.alias}\t${p.endpoint}${account}${scope}`;
            })
            .join('\n');
        },
        globals,
      );
      // The switch hint is stderr-only chatter: it never touches stdout, so
      // it can't change the human table or the --json payload above.
      info('Run `crowi profiles use <alias>` to change the current profile.', globals);
    });
  // Local-only: no network, so nothing to skew-probe. Covers `use` below too
  // — the version-skew hook only ever sees the root-direct `profiles` node,
  // never its child commands (see `createProgram`'s `preSubcommand` hook).
  markNoSkewProbe(cmd);

  cmd
    .command('use <alias>')
    .description('Switch the current/default profile')
    .action((alias: string, _options: unknown, command: Command) => {
      const globals = getGlobalOptions(command);
      runUse(alias);
      info(`Switched current profile to "${alias}".`, globals);
    });
}
