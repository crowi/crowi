import { Command, type OptionValues } from 'commander';

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
 * Commander records the exact argv it was given (`argv.slice()`, unfiltered)
 * on `rawArgs` when `parse`/`parseAsync` runs — but only on the `Command`
 * those were called on (the root program), and the field isn't part of the
 * published `.d.ts` even though it's a real, stable property of the JS
 * class. Narrowly typed here instead of reaching for `any`.
 */
interface CommandWithRawArgs {
  rawArgs: string[];
}

/** Walk `.parent` up to the root `Command` (the one `parseAsync` was called on). */
function rootCommand(command: Command): Command {
  let node = command;
  while (node.parent) {
    node = node.parent;
  }
  return node;
}

/** `rootCommand(command).rawArgs`, typed through {@link CommandWithRawArgs}. */
function rootRawArgs(command: Command): string[] {
  return (rootCommand(command) as unknown as CommandWithRawArgs).rawArgs;
}

/** A `-p`/`--profile` occurrence recognized in a raw argv token. */
interface ProfileTokenMatch {
  value: string;
  /** how many additional tokens (beyond the flag token itself) this form consumes */
  extraTokens: 0 | 1;
}

/**
 * Recognize a `-p`/`--profile` flag token in the same 4 forms Commander
 * itself accepts: `--profile value`, `--profile=value`, `-p value`,
 * `-pvalue`. `next` is the token immediately following `token` (used for the
 * two "value in the next token" forms).
 */
function matchProfileToken(token: string, next: string | undefined): ProfileTokenMatch | undefined {
  if (token === '-p' || token === '--profile') {
    return next === undefined ? undefined : { value: next, extraTokens: 1 };
  }
  if (token.startsWith('--profile=')) {
    return { value: token.slice('--profile='.length), extraTokens: 0 };
  }
  if (token.startsWith('-p') && token.length > 2) {
    return { value: token.slice(2), extraTokens: 0 };
  }
  return undefined;
}

/** Root-level flags that take a value, other than `-p`/`--profile` itself. */
const ROOT_VALUE_FLAGS = new Set(['--url', '--token']);
/** Root-level boolean flags (no value token to skip). */
const ROOT_BOOLEAN_FLAGS = new Set(['--json', '-q', '--quiet']);

/**
 * Scan raw argv for a `-p`/`--profile` value given on the COMMAND side, i.e.
 * after the root-level (top-level) subcommand name — so
 * `crowi login <url> --profile x` and `crowi comment add <path> --profile x`
 * both count, regardless of how deep `add`/`list`/etc. are nested. Returns
 * the LAST such value (command-side repeats behave like Commander itself:
 * later wins), or `undefined` when none was given on the command side.
 *
 * This does not need to know whether `rawArgs` still carries a leading
 * node/script-path prefix (`parseAsync(process.argv)`, prefix present) or
 * not (`parseAsync(args, { from: 'user' })`, no prefix, as in tests): any
 * leading token that isn't a recognized root flag/value and isn't a
 * registered top-level command name is simply skipped while hunting for the
 * boundary, so a stray prefix can only push the detected boundary EARLIER
 * than the true one, never later. A too-early boundary just makes this
 * degrade to "last `-p`/`--profile` occurrence anywhere", which is exactly
 * what Commander's own `optsWithGlobals()` already returns in that case — so
 * the result is never wrong, only occasionally computed via the fallback
 * path it would have taken anyway.
 */
function findCommandSideProfile(rawArgs: string[]): string | undefined {
  let optionsEnabled = true;
  let boundaryFound = false;
  let lastValue: string | undefined;
  let i = 0;
  while (i < rawArgs.length) {
    const token = rawArgs[i];

    if (optionsEnabled && token === '--') {
      optionsEnabled = false;
      i += 1;
      continue;
    }

    if (optionsEnabled) {
      const match = matchProfileToken(token, rawArgs[i + 1]);
      if (match) {
        if (boundaryFound) {
          lastValue = match.value;
        }
        i += 1 + match.extraTokens;
        continue;
      }
      if (ROOT_VALUE_FLAGS.has(token)) {
        // Skip the flag AND its value so a URL/token can never be
        // mistaken for the top-level command name.
        i += 2;
        continue;
      }
      if (ROOT_BOOLEAN_FLAGS.has(token)) {
        i += 1;
        continue;
      }
    }

    // First plain token is the root-level command-name boundary; anything
    // else (subcommand args / options we don't otherwise recognize) just
    // advances the scan.
    boundaryFound = true;
    i += 1;
  }
  return lastValue;
}

/**
 * Read the root program's global options from a subcommand's `Command`.
 * `url`/`token`/`json`/`quiet` come from Commander's own
 * `optsWithGlobals()` (parent options merged over child options); `profile`
 * does not, because once the same `-p, --profile <alias>` flag is declared
 * at multiple levels of the command tree (see {@link createProgram}) for
 * help visibility, `optsWithGlobals()` can no longer tell which level a
 * given value came from — it always attributes the final value to the
 * ancestor closest to root. `profile` is instead resolved by
 * {@link findCommandSideProfile}, which walks the root program's raw argv
 * directly: a value given after the top-level command name (the "command
 * side") always wins over a root-side value, matching the documented
 * `crowi --profile old login <url> --profile new` precedence. Falls back to
 * Commander's own aggregation when nothing was found on the command side.
 */
export function getGlobalOptions(command: Command): GlobalOptions {
  const opts = command.optsWithGlobals() as OptionValues;
  const commandSideProfile = findCommandSideProfile(rootRawArgs(command));
  return {
    profile: commandSideProfile ?? (typeof opts.profile === 'string' ? opts.profile : undefined),
    url: typeof opts.url === 'string' ? opts.url : undefined,
    token: typeof opts.token === 'string' ? opts.token : undefined,
    json: opts.json === true,
    quiet: opts.quiet === true,
  };
}

/**
 * Depth-first walk of the registered command tree, declaring
 * `-p, --profile <alias>` on every DESCENDANT of `root` (root keeps its
 * original declaration). Commander's `--help` only lists a command's own
 * options, not ones inherited from an ancestor, so without this a
 * subcommand's help never mentions `--profile` even though the flag works
 * there (see {@link getGlobalOptions}). Applied once, after every
 * `registerXxx()` call in {@link createProgram}, so group commands
 * (`comment`, `attach`, `bookmark`, `watch`) and their leaves are covered
 * without each `registerXxx()` repeating the declaration, and any nested
 * command added later is covered automatically.
 */
function addProfileOptionToDescendants(root: Command): void {
  for (const sub of root.commands) {
    sub.option('-p, --profile <alias>', 'use a stored profile by alias (overrides a root-level --profile)');
    addProfileOptionToDescendants(sub);
  }
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

  // Give every descendant its own `-p, --profile <alias>` declaration (help
  // visibility only — see `getGlobalOptions` / `addProfileOptionToDescendants`
  // for why parsing doesn't actually depend on it). Runs last, once the full
  // tree is registered, so nested commands never need to repeat this.
  addProfileOptionToDescendants(program);

  return program;
}
