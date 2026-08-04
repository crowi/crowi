import { Command } from 'commander';

import { createProgram } from '../cli';
import { describeProgram, renderCompletion, SUPPORTED_SHELLS } from './completion';

/**
 * Build a tiny stand-in program with a couple of subcommands + an alias so the
 * completion generator can be exercised without the full CLI tree.
 */
function buildProgram(): Command {
  const program = new Command();
  program.name('crowi').option('--json', 'json output').option('-q, --quiet', 'quiet');
  program.command('search <query>').description('search pages').option('--limit <n>', 'max results');
  program.command('get <path>').alias('cat').description('print a page').option('--revision <id>', 'a revision');
  return program;
}

describe('completion', () => {
  describe('describeProgram', () => {
    it('flattens global flags and one-level subcommands incl. aliases', () => {
      const spec = describeProgram(buildProgram());
      expect(spec.globalFlags.map((f) => f.flag)).toEqual(['--json', '--quiet']);
      const search = spec.commands.find((c) => c.name === 'search');
      expect(search?.flags.map((f) => f.flag)).toEqual(['--limit']);
      const get = spec.commands.find((c) => c.name === 'get');
      expect(get?.aliases).toEqual(['cat']);
    });

    it("omits commander's implicit help command", () => {
      const spec = describeProgram(buildProgram());
      expect(spec.commands.some((c) => c.name === 'help')).toBe(false);
    });
  });

  describe('renderCompletion', () => {
    it.each(SUPPORTED_SHELLS)('emits a non-empty %s script mentioning the commands', (shell) => {
      const script = renderCompletion(buildProgram(), shell);
      expect(script.length).toBeGreaterThan(0);
      expect(script).toContain('search');
      expect(script).toContain('get');
      // The alias is completable in every shell template.
      expect(script).toContain('cat');
    });

    it('references the --limit flag of search in the bash script', () => {
      const script = renderCompletion(buildProgram(), 'bash');
      expect(script).toContain('--limit');
    });

    /**
     * Regression guard: a ROOT-declared global must not also be declared on
     * subcommands. `renderBash` unions a command's own flags with the global
     * ones, so a flag present at both levels lands in the same `opts='...'`
     * list twice and the shell offers it as a duplicate candidate. (An
     * earlier attempt at making globals visible in subcommand `--help` did
     * exactly that by walking the tree and re-declaring `--profile` on every
     * descendant; `configureHelp({ showGlobalOptions: true })` achieves the
     * same help visibility without touching `command.options`.)
     *
     * Driven off the REAL program, not `buildProgram()`'s stand-in, because
     * only the full tree exhibits it.
     *
     * `--token` on `login` is a KNOWN, pre-existing overlap and is allowed
     * here: `login` declares its own `--token <pat>` (store a pre-issued PAT)
     * which is a genuinely different option that merely shares a name with
     * the root's `--token <accessToken>`. Both predate this guard
     * (`bd4eb0fa` / `6e2ecc4e`). Listing it explicitly rather than relaxing
     * the assertion keeps any NEW duplicate failing.
     */
    it('does not duplicate root globals into a command’s own option list (real program)', () => {
      const script = renderCompletion(createProgram(), 'bash');
      const duplicated: string[] = [];
      for (const line of script.split('\n')) {
        const match = line.match(/opts='([^']*)'/);
        if (!match) continue;
        const flags = match[1].split(/\s+/).filter(Boolean);
        const seen = new Set<string>();
        for (const flag of flags) {
          if (seen.has(flag)) duplicated.push(flag);
          seen.add(flag);
        }
      }
      // `login`'s own `--token` is the only tolerated overlap (see doc above).
      expect(duplicated).toEqual(['--token']);
    });
  });
});
