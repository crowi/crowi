import type { Command } from 'commander';

import { getGlobalOptions } from '../cli';
import { loadConfig } from '../lib/config';
import { render } from '../lib/output';
import { markNoSkewProbe } from '../lib/skew';

/**
 * `crowi profiles` — list the locally-configured profiles (no network).
 * Marks the current/default profile and shows each endpoint + granted scope
 * so a user can see which servers they are signed in to.
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
    });
  // Local-only: no network, so nothing to skew-probe.
  markNoSkewProbe(cmd);
}
