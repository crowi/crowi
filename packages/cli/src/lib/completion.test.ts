import { Command } from 'commander';

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
  });
});
