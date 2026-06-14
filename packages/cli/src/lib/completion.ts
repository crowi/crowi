/**
 * Shell-completion script generation. Rather than hand-maintaining a static
 * list of subcommands and flags (which drifts from the real program), we
 * introspect the live commander tree (`createProgram()`) and emit a static
 * completion script for the requested shell. The script needs no runtime call
 * back into `crowi`, so it is fast and works offline.
 *
 * Supported shells: bash, zsh, fish. Each script completes:
 *   - top-level subcommand names (and their aliases),
 *   - the long flags of the root program (global options),
 *   - the long flags of the matched subcommand.
 */
import type { Command, Option } from 'commander';

/** Shells we can emit a completion script for. */
export const SUPPORTED_SHELLS = ['bash', 'zsh', 'fish'] as const;
export type CompletionShell = (typeof SUPPORTED_SHELLS)[number];

/** A flattened view of one subcommand, used by every shell template. */
interface CommandSpec {
  /** Primary name, e.g. `search`. */
  name: string;
  /** Aliases, e.g. `cat` for `get` (commander stores them separately). */
  aliases: string[];
  /** One-line description for zsh/fish menus. */
  description: string;
  /** Long flags this subcommand accepts, e.g. `--json`, `--limit`. */
  flags: FlagSpec[];
}

/** A flattened view of one option (long form only — completion targets longs). */
interface FlagSpec {
  /** The `--long` form (always present for the options we register). */
  flag: string;
  /** Description for zsh/fish menus. */
  description: string;
}

/** Collect the long flags of a command, skipping the built-in `--help`. */
function collectFlags(command: Command): FlagSpec[] {
  return command.options
    .filter((opt: Option) => typeof opt.long === 'string' && opt.long.length > 0)
    .map((opt: Option) => ({ flag: opt.long as string, description: opt.description }));
}

/**
 * Walk the root program's immediate subcommands into a flat spec list. We
 * deliberately keep this one level deep: nested group subcommands (e.g.
 * `comment add`) are rare enough that completing the group name + its flags
 * covers the common case without bloating the script.
 */
export function describeProgram(program: Command): { globalFlags: FlagSpec[]; commands: CommandSpec[] } {
  const globalFlags = collectFlags(program);
  const commands: CommandSpec[] = program.commands
    // Hide commander's auto-added `help` command from the primary list; it is
    // still completable as a literal but does not need a flag menu.
    .filter((cmd) => cmd.name() !== 'help')
    .map((cmd) => ({
      name: cmd.name(),
      aliases: cmd.aliases(),
      description: cmd.description(),
      flags: collectFlags(cmd),
    }));
  return { globalFlags, commands };
}

/** Quote a string for safe single-line embedding in a shell script. */
function shEscape(value: string): string {
  return value.replace(/'/g, `'\\''`);
}

/** All completable top-level tokens: every command name plus its aliases. */
function allCommandTokens(commands: CommandSpec[]): string[] {
  return commands.flatMap((cmd) => [cmd.name, ...cmd.aliases]);
}

/** bash completion script. */
function renderBash(spec: { globalFlags: FlagSpec[]; commands: CommandSpec[] }): string {
  const topTokens = allCommandTokens(spec.commands).join(' ');
  const globalFlags = spec.globalFlags.map((f) => f.flag).join(' ');

  // Per-command flag case branches, keyed on the command (and its aliases).
  const caseBranches = spec.commands
    .map((cmd) => {
      const keys = [cmd.name, ...cmd.aliases].join('|');
      const flags = cmd.flags.map((f) => f.flag).join(' ');
      return `    ${keys})\n      opts='${flags} ${globalFlags}'\n      ;;`;
    })
    .join('\n');

  return `# bash completion for crowi — eval "$(crowi completion bash)" or save to a completions dir.
_crowi_completions() {
  local cur prev words cword
  _get_comp_words_by_ref -n : cur prev words cword 2>/dev/null || {
    cur="\${COMP_WORDS[COMP_CWORD]}"
    words=("\${COMP_WORDS[@]}")
    cword=$COMP_CWORD
  }

  local commands='${topTokens}'
  local global='${globalFlags}'

  # Find the first non-flag word after the program name = the subcommand.
  local i cmd=''
  for ((i=1; i<cword; i++)); do
    case "\${words[i]}" in
      -*) ;;
      *) cmd="\${words[i]}"; break ;;
    esac
  done

  if [[ -z "$cmd" ]]; then
    COMPREPLY=( $(compgen -W "$commands $global" -- "$cur") )
    return 0
  fi

  local opts=''
  case "$cmd" in
${caseBranches}
    *)
      opts="$global"
      ;;
  esac
  COMPREPLY=( $(compgen -W "$opts" -- "$cur") )
  return 0
}
complete -F _crowi_completions crowi
`;
}

/** zsh completion script (uses _describe for a rich menu). */
function renderZsh(spec: { globalFlags: FlagSpec[]; commands: CommandSpec[] }): string {
  const commandLines = spec.commands.map((cmd) => `    '${shEscape(cmd.name)}:${shEscape(cmd.description)}'`).join('\n');

  const caseBranches = spec.commands
    .map((cmd) => {
      const keys = [cmd.name, ...cmd.aliases].join('|');
      const flagLines = cmd.flags.map((f) => `        '${shEscape(f.flag)}[${shEscape(f.description)}]'`).join(' \\\n');
      const body = flagLines ? `_arguments \\\n${flagLines}` : ':';
      return `      ${keys})\n        ${body}\n        ;;`;
    })
    .join('\n');

  const globalFlagLines = spec.globalFlags.map((f) => `      '${shEscape(f.flag)}[${shEscape(f.description)}]'`).join(' \\\n');

  return `#compdef crowi
# zsh completion for crowi — eval "$(crowi completion zsh)" or place in $fpath.
_crowi() {
  local -a commands
  commands=(
${commandLines}
  )

  local global_opts
  _arguments -C \\
${globalFlagLines} \\
    '1: :->command' \\
    '*:: :->args' && return 0

  case $state in
    command)
      _describe -t commands 'crowi command' commands
      ;;
    args)
      case $line[1] in
${caseBranches}
      esac
      ;;
  esac
}
_crowi "$@"
`;
}

/** fish completion script (one `complete` line per command/flag). */
function renderFish(spec: { globalFlags: FlagSpec[]; commands: CommandSpec[] }): string {
  const lines: string[] = ['# fish completion for crowi — crowi completion fish | source, or save to ~/.config/fish/completions/crowi.fish'];

  // Helper: only offer subcommands when none has been typed yet.
  lines.push('function __crowi_no_subcommand');
  lines.push('  set -l cmd (commandline -opc)');
  lines.push('  set -e cmd[1]');
  lines.push('  for c in $cmd');
  lines.push('    switch $c');
  lines.push("      case '-*'");
  lines.push('      case "*"');
  lines.push('        return 1');
  lines.push('    end');
  lines.push('  end');
  lines.push('  return 0');
  lines.push('end');
  lines.push('');

  // Top-level subcommands.
  for (const cmd of spec.commands) {
    lines.push(`complete -c crowi -n '__crowi_no_subcommand' -f -a '${shEscape(cmd.name)}' -d '${shEscape(cmd.description)}'`);
  }

  // Global flags (available everywhere).
  for (const f of spec.globalFlags) {
    lines.push(`complete -c crowi -l '${shEscape(f.flag.replace(/^--/, ''))}' -d '${shEscape(f.description)}'`);
  }

  // Per-command flags, gated on the seen subcommand (and aliases).
  for (const cmd of spec.commands) {
    const names = [cmd.name, ...cmd.aliases];
    const condition = names.map((n) => `__fish_seen_subcommand_from ${n}`).join('; or ');
    for (const f of cmd.flags) {
      lines.push(`complete -c crowi -n '${condition}' -l '${shEscape(f.flag.replace(/^--/, ''))}' -d '${shEscape(f.description)}'`);
    }
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Render a completion script for the given shell by introspecting the live
 * commander program. Throws for an unsupported shell name.
 */
export function renderCompletion(program: Command, shell: CompletionShell): string {
  const spec = describeProgram(program);
  switch (shell) {
    case 'bash':
      return renderBash(spec);
    case 'zsh':
      return renderZsh(spec);
    case 'fish':
      return renderFish(spec);
  }
}
