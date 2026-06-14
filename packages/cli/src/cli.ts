import { Command, type OptionValues } from 'commander';

import { registerLogin } from './commands/login';
import { registerLogout } from './commands/logout';
import { registerProfiles } from './commands/profiles';
import { registerWhoami } from './commands/whoami';
import { installRefreshHook } from './lib/refresh';

/**
 * Global options shared by every subcommand, parsed from the root program's
 * flags. Resolved once and handed to commands via
 * {@link getGlobalOptions}.
 */
export interface GlobalOptions {
  /** `--profile <alias>` — act on a stored profile by name. */
  profile?: string;
  /** `--url <baseUrl>` — talk to an ad-hoc server (no stored profile). */
  url?: string;
  /** `--token <accessToken>` — use a bearer token directly (e.g. a PAT). */
  token?: string;
  /** `--json` — emit machine-readable JSON instead of human output. */
  json?: boolean;
  /** `--quiet` — suppress progress chatter (stderr). */
  quiet?: boolean;
}

/**
 * Read the root program's global options from a subcommand's `Command`.
 * Commander stores parent options on the option-value chain via
 * `optsWithGlobals()`.
 */
export function getGlobalOptions(command: Command): GlobalOptions {
  const opts = command.optsWithGlobals() as OptionValues;
  return {
    profile: typeof opts.profile === 'string' ? opts.profile : undefined,
    url: typeof opts.url === 'string' ? opts.url : undefined,
    token: typeof opts.token === 'string' ? opts.token : undefined,
    json: opts.json === true,
    quiet: opts.quiet === true,
  };
}

/**
 * Build the root commander program. Exported so the bin entry point
 * (`bin.ts`) can call `parseAsync` on it, and so test harnesses can drive
 * the CLI without spawning a child process.
 *
 * Subcommands are registered via small per-command helpers
 * (`registerXxx(program)`) so each command keeps its own arg / option
 * declarations next to its implementation. Those land in later stages; this
 * scaffold wires only the program shell + global flags.
 */
export function createProgram(): Command {
  // Wire the 401→refresh→retry hook once before any command runs, so
  // authedFetch can transparently refresh an expired access token.
  installRefreshHook();

  const program = new Command();
  program
    .name('crowi')
    .description('End-user CLI for Crowi 2.0. Read, write, search, and edit your wiki from the terminal over HTTP (OAuth).')
    .version('0.1.0-dev')
    // Global flags. `--url` / `--token` let a command target an ad-hoc
    // server without a stored profile; `--profile` selects a stored one.
    .option('-p, --profile <alias>', 'use a stored profile by alias')
    .option('--url <baseUrl>', 'target a server ad-hoc (overrides the stored profile endpoint)')
    .option('--token <accessToken>', 'use a bearer token directly (e.g. a PAT)')
    .option('--json', 'emit machine-readable JSON instead of human output')
    .option('-q, --quiet', 'suppress progress output on stderr');

  // Authentication & token-lifecycle commands (Stage 3). Page / search /
  // comment / etc. commands register in later stages.
  registerLogin(program);
  registerLogout(program);
  registerWhoami(program);
  registerProfiles(program);

  return program;
}
