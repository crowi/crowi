import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Command } from 'commander';

import { version as pkgVersion } from '../package.json';
import { createProgram, getGlobalOptions } from './cli';
import * as capabilityModule from './lib/capability';

/**
 * Profile-option discoverability + command-side precedence (RFC: CLI
 * profile discoverability). Built on the REAL `createProgram()` tree (not a
 * hand-rolled stand-in) so these tests fail if a future change to any
 * `registerXxx()` breaks the `-p, --profile <alias>` wiring or reintroduces
 * the "declared only at root, invisible in subcommand help" gap.
 */

function findCommand(parent: Command, name: string): Command {
  const found = parent.commands.find((c) => c.name() === name);
  if (!found) throw new Error(`command not registered: ${name} (under ${parent.name()})`);
  return found;
}

describe('createProgram — -p, --profile <alias> help visibility (AC-1)', () => {
  it('shows --profile on the root program', () => {
    const program = createProgram();
    expect(program.helpInformation()).toContain('-p, --profile <alias>');
  });

  it('shows --profile on a single (leaf, directly under root) command: login', () => {
    const program = createProgram();
    expect(findCommand(program, 'login').helpInformation()).toContain('-p, --profile <alias>');
  });

  it('shows --profile on a single (leaf, directly under root) command: search', () => {
    const program = createProgram();
    expect(findCommand(program, 'search').helpInformation()).toContain('-p, --profile <alias>');
  });

  it('shows --profile on a nested leaf command: comment add', () => {
    const program = createProgram();
    const comment = findCommand(program, 'comment');
    expect(findCommand(comment, 'add').helpInformation()).toContain('-p, --profile <alias>');
  });

  it('shows --profile on the group command itself: comment', () => {
    const program = createProgram();
    expect(findCommand(program, 'comment').helpInformation()).toContain('-p, --profile <alias>');
  });
});

describe('login accepts --profile on either side of the URL (AC-1)', () => {
  it.each([
    ['before the url', ['login', '--profile', 'alias1', 'https://wiki.example.test']],
    ['after the url', ['login', 'https://wiki.example.test', '--profile', 'alias1']],
  ])('parses --profile %s', async (_label, args) => {
    const program = createProgram();
    program.exitOverride();
    let capturedUrl: string | undefined;
    let capturedProfile: string | undefined;
    findCommand(program, 'login').action(async (url: string, _options: unknown, command: Command) => {
      capturedUrl = url;
      capturedProfile = getGlobalOptions(command).profile;
    });

    await program.parseAsync(args, { from: 'user' });

    expect(capturedUrl).toBe('https://wiki.example.test');
    expect(capturedProfile).toBe('alias1');
  });
});

describe('command-side --profile wins over root-side (AC-2)', () => {
  beforeEach(() => {
    // The version-skew probe is exercised separately below; keep it a no-op
    // here so these tests never depend on network / a real profile store.
    jest.spyOn(capabilityModule, 'maybeWarnVersionSkew').mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  type Case = { label: string; args: string[]; expected: string | undefined; nested?: boolean };
  const cases: Case[] = [
    { label: 'root-side only', args: ['--profile', 'root1', 'login', 'https://x.example'], expected: 'root1' },
    { label: 'command-side only (--profile value)', args: ['login', 'https://x.example', '--profile', 'child1'], expected: 'child1' },
    {
      label: 'root + command-side: command-side wins',
      args: ['--profile', 'root1', 'login', 'https://x.example', '--profile', 'child1'],
      expected: 'child1',
    },
    {
      label: 'command-side --profile=value wins over root-side',
      args: ['--profile', 'root1', 'login', 'https://x.example', '--profile=child2'],
      expected: 'child2',
    },
    {
      label: 'command-side -p value wins over root-side',
      args: ['--profile', 'root1', 'login', 'https://x.example', '-p', 'child3'],
      expected: 'child3',
    },
    {
      label: 'command-side -pvalue (combined) wins over root-side',
      args: ['--profile', 'root1', 'login', 'https://x.example', '-pchild4'],
      expected: 'child4',
    },
    {
      label: 'nested group command (comment add): command-side wins',
      args: ['--profile', 'root1', 'comment', 'add', 'p1', '--profile', 'child5'],
      expected: 'child5',
      nested: true,
    },
    {
      label: '-- boundary: a "--profile" after it is literal, not an option — falls back to root-side',
      args: ['--profile', 'root1', 'login', 'https://x.example', '--', '--profile', 'ignored'],
      expected: 'root1',
    },
    {
      label: 'neither side given: profile is undefined',
      args: ['login', 'https://x.example'],
      expected: undefined,
    },
  ];

  it.each(cases)('$label', async ({ args, expected, nested }) => {
    const program = createProgram();
    program.exitOverride();
    let actionProfile: string | undefined;

    const target = nested ? findCommand(findCommand(program, 'comment'), 'add') : findCommand(program, 'login');
    target.action(async (..._callArgs: unknown[]) => {
      const command = _callArgs[_callArgs.length - 1] as Command;
      actionProfile = getGlobalOptions(command).profile;
    });

    await program.parseAsync(args, { from: 'user' });

    expect(actionProfile).toBe(expected);
  });
});

describe('skew probe and command action agree on the resolved --profile (AC-2)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('passes the same command-side profile to both maybeWarnVersionSkew and the action', async () => {
    // `login` opts OUT of the skew probe (pre-auth, nothing to probe with —
    // see `registerLogin`); use `search`, which stays on the probed surface
    // (see `skew.test.ts`).
    const skewSpy = jest.spyOn(capabilityModule, 'maybeWarnVersionSkew').mockResolvedValue(undefined);
    const program = createProgram();
    program.exitOverride();
    let actionProfile: string | undefined;
    findCommand(program, 'search').action(async (_query: string, _options: unknown, command: Command) => {
      actionProfile = getGlobalOptions(command).profile;
    });

    await program.parseAsync(['--profile', 'root1', 'search', 'release notes', '--profile', 'child1'], { from: 'user' });

    expect(actionProfile).toBe('child1');
    expect(skewSpy).toHaveBeenCalledWith(expect.objectContaining({ profile: 'child1' }));
  });

  it('does not probe commands that opt out (e.g. profiles), even with a dual profile', async () => {
    const skewSpy = jest.spyOn(capabilityModule, 'maybeWarnVersionSkew').mockResolvedValue(undefined);
    const program = createProgram();
    program.exitOverride();
    // Replace the real action (would touch the config file / stdout) —
    // this test only cares about the skew-probe opt-out wiring.
    findCommand(program, 'profiles').action(() => {});

    await program.parseAsync(['--profile', 'root1', 'profiles'], { from: 'user' });

    expect(skewSpy).not.toHaveBeenCalled();
  });
});

describe('createProgram — --version reports the published package version', () => {
  // Regression: the version was a hardcoded `'0.1.0-dev'` literal, so
  // `crowi --version` kept printing the pre-release scaffold string long
  // after the package had been published (`1.0.0-alpha.2` at the time this
  // was found). A user reporting a bug could not tell us what they were
  // running. Read from package.json rather than asserting a fixed string,
  // so this keeps passing across releases and only fails if the wiring is
  // broken again.
  it('matches the version in package.json', () => {
    expect(createProgram().version()).toBe(pkgVersion);
  });

  it('does not report a hardcoded development placeholder', () => {
    expect(createProgram().version()).not.toMatch(/-dev$/);
  });

  // The two assertions above compare the running program to the same
  // package.json it reads, so they would still pass if someone replaced the
  // import with a literal that happens to equal today's version — which is
  // exactly the regression this block exists to prevent. Assert the wiring
  // itself, not just the value it currently produces.
  it('takes the version from package.json rather than a literal', () => {
    const source = readFileSync(join(__dirname, 'cli.ts'), 'utf8');
    expect(source).toMatch(/import \{ version as CLI_VERSION \} from '\.\.\/package\.json'/);
    expect(source).not.toMatch(/\.version\(\s*['"]/);
  });
});
