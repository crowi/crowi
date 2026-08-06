import { Command, type OptionValues } from 'commander';

// A NAMED import, not a default/`require` of the whole manifest: esbuild
// tree-shakes JSON named imports, so only this string reaches `dist/` —
// a whole-manifest import inlines `scripts` and `devDependencies` into the
// published bundle.
import { version as CLI_VERSION } from '../package.json';

import { registerAttach } from './commands/attach';
import { registerBookmark } from './commands/bookmark';
import { registerComment } from './commands/comment';
import { registerCompletion } from './commands/completion';
import { registerCreate } from './commands/create';
import { registerEdit } from './commands/edit';
import { registerCat, registerGet } from './commands/get';
import { registerLogin } from './commands/login';
import { registerLogout } from './commands/logout';
import { registerLs } from './commands/ls';
import { registerMv } from './commands/mv';
import { registerOpen } from './commands/open';
import { registerProfiles } from './commands/profiles';
import { registerRm } from './commands/rm';
import { registerSearch } from './commands/search';
import { registerUpdate } from './commands/update';
import { registerWatch } from './commands/watch';
import { registerWhoami } from './commands/whoami';
import { maybeWarnVersionSkew } from './lib/capability';
import { installRefreshHook } from './lib/refresh';
import { isNoSkewProbe } from './lib/skew';

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
 *
 * Every global is declared ONCE, on the root program. Commander's default
 * (non-positional) parsing already accepts a root-declared option anywhere
 * in argv — before or after the command name, at any nesting depth — and a
 * later occurrence overwrites an earlier one, which is exactly the
 * documented `crowi --profile old login <url> --profile new` precedence.
 * `optsWithGlobals()` therefore needs no help: no raw-argv rescan, no
 * per-command re-declaration.
 *
 * Do not re-declare a global on subcommands to make it show in their help —
 * `createProgram` uses `configureHelp({ showGlobalOptions: true })` for
 * that. Re-declaring puts the flag in the subcommand's own `options`, which
 * both duplicates it in the generated shell completion and inverts the
 * precedence above (commander's `optsWithGlobals` lets globals overwrite
 * locals).
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
    // Read from package.json rather than a literal: a hardcoded string goes
    // stale the moment changesets bumps the package, and `crowi --version`
    // is the first thing anyone reports when something misbehaves. Both
    // `src/cli.ts` (tests) and `dist/cli.js` (published) sit one level below
    // the package root, so this one path resolves for both.
    .version(CLI_VERSION)
    // Global flags. `--url` / `--token` let a command target an ad-hoc
    // server without a stored profile; `--profile` selects a stored one.
    .option('-p, --profile <alias>', 'use a stored profile by alias')
    .option('--url <baseUrl>', 'target a server ad-hoc (overrides the stored profile endpoint)')
    .option('--token <accessToken>', 'use a bearer token directly (e.g. a PAT)')
    .option('--json', 'emit machine-readable JSON instead of human output')
    .option('-q, --quiet', 'suppress progress output on stderr');

  // Commander's help only lists a command's OWN options, so a root-declared
  // global (`--profile` / `--url` / `--token` / `--json` / `--quiet`) would
  // never appear in `crowi login --help` even though it parses there.
  // `showGlobalOptions` makes commander render them under a "Global Options"
  // section instead. Set before any `.command()` call so it propagates to
  // every subcommand via commander's `copyInheritedSettings`.
  //
  // Deliberately NOT done by re-declaring the flags on each subcommand: that
  // puts them in the subcommand's own `options`, which (a) makes
  // `lib/completion.ts` emit each one twice (it unions a command's own flags
  // with the globals) and (b) makes `optsWithGlobals()` resolve the ROOT
  // value over the command-side one, inverting the documented precedence.
  program.configureHelp({ showGlobalOptions: true });

  // Per-invocation version-skew probe for the authenticated command surface.
  // Runs once, before the chosen subcommand's action, so the skew warning is
  // live for the whole authenticated surface (search / get / cat / ls /
  // create / edit / update / mv / rm / watch / whoami / comment / attach /
  // bookmark). It is TTL-cached + best-effort (never throws), so it adds no
  // round-trip on a cache hit and never blocks a command.
  //
  // The opt-out is tied to the COMMAND OBJECT via a typed WeakSet
  // (`markNoSkewProbe`) rather than a hand-maintained name set, so a newly
  // added command can't silently inherit the wrong behavior: local-only /
  // pre-auth commands (login / logout / profiles / open / completion) opt out
  // at registration. The Phase 2 commands (comment / attach / bookmark) no
  // longer suppress the probe — their ensureCapability() pre-flight (which
  // also emitted the skew note) was removed, so the hook is now their single
  // source of the skew warning.
  program.hook('preSubcommand', async (_thisCommand, subcommand) => {
    if (isNoSkewProbe(subcommand)) {
      return;
    }
    // Read globals from the invoked `subcommand`, not the root — so the
    // profile the skew probe checks is the SAME one `getGlobalOptions()`
    // resolves for the command's own action (command-side `--profile`
    // takes precedence over a root-side one; see `getGlobalOptions`).
    const globals = getGlobalOptions(subcommand);
    await maybeWarnVersionSkew({ profile: globals.profile, url: globals.url, token: globals.token });
  });

  // Authentication & token-lifecycle commands (Stage 3). Page / search /
  // comment / etc. commands register in later stages.
  registerLogin(program);
  registerLogout(program);
  registerWhoami(program);
  registerProfiles(program);

  // Read commands (Stage 4): search / get / cat / ls.
  registerSearch(program);
  registerGet(program);
  registerCat(program);
  registerLs(program);

  // Write commands (Stage 5): create / edit / update / mv / rm.
  registerCreate(program);
  registerEdit(program);
  registerUpdate(program);
  registerMv(program);
  registerRm(program);

  // Phase 2 commands (Stage 6): gated behind their OAuth scopes / server
  // capabilities. comment / attach / bookmark need scopes outside the default
  // login set; watch rides pages:*; open is local-only (no API call).
  registerComment(program);
  registerAttach(program);
  registerBookmark(program);
  registerWatch(program);
  registerOpen(program);

  // Phase 3 polish: shell-completion script generator (introspects the tree
  // above, so it must register after every other command).
  registerCompletion(program);

  return program;
}
