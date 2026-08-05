import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';

import { configPath, loadConfig, type Profile, resolveProfile, upsertProfile } from '../lib/config';
import { CliError, EXIT } from '../lib/http';
import { registerProfiles } from './profiles';

/**
 * `crowi profiles` / `crowi profiles use <alias>` — local-only config
 * mutation + listing (no network). Uses a temp `$XDG_CONFIG_HOME` so these
 * tests touch a real filesystem (matching `setCurrentProfile`'s atomic
 * read-then-write) without mutating the developer's `~/.config/crowi`.
 *
 * `node:fs`'s `renameSync` is mocked (call-through, via `jest.fn(actual)`)
 * rather than spied directly: Jest's node test environment exposes core
 * module exports as non-configurable properties, so `jest.spyOn(fs, ...)`
 * throws `Cannot redefine property`. Wrapping it in `jest.mock` instead
 * keeps every other `node:fs` export real while still making `renameSync`
 * (the atomic-write primitive `saveConfig` ultimately calls) observable.
 */
jest.mock('node:fs', () => {
  const actual = jest.requireActual('node:fs');
  return {
    ...actual,
    renameSync: jest.fn(actual.renameSync),
  };
});

let tmpRoot: string;
const ORIGINAL_XDG = process.env.XDG_CONFIG_HOME;
let stdout: jest.SpyInstance;
let stderr: jest.SpyInstance;

function build(): Command {
  const program = new Command();
  program.exitOverride();
  program.option('-p, --profile <alias>').option('--url <baseUrl>').option('--token <accessToken>').option('--json').option('-q, --quiet');
  registerProfiles(program);
  return program;
}

const sampleProfile = (overrides: Partial<Profile> = {}): Profile => ({
  alias: 'work',
  endpoint: 'https://wiki.example.com',
  account: 'alice',
  tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: 123, scope: 'pages:read pages:write' },
  ...overrides,
});

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'crowi-cli-profiles-'));
  process.env.XDG_CONFIG_HOME = tmpRoot;
  delete process.env.CROWI_PROFILE;
  delete process.env.CROWI_URL;
  delete process.env.CROWI_TOKEN;
  stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (ORIGINAL_XDG === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = ORIGINAL_XDG;
  }
  stdout.mockRestore();
  stderr.mockRestore();
});

function stdoutText(): string {
  return stdout.mock.calls.map((c) => String(c[0])).join('');
}

function stderrText(): string {
  return stderr.mock.calls.map((c) => String(c[0])).join('');
}

describe('crowi profiles use <alias> (AC-3)', () => {
  it('persists currentProfile for an existing alias, so a later profile-less resolution returns it', async () => {
    upsertProfile(sampleProfile({ alias: 'work' }));
    upsertProfile(sampleProfile({ alias: 'home', endpoint: 'https://home.example', account: 'bob' }));
    expect(loadConfig().currentProfile).toBe('work'); // set by the first upsertProfile

    const program = build();
    await program.parseAsync(['profiles', 'use', 'home'], { from: 'user' });

    const reloaded = loadConfig();
    expect(reloaded.currentProfile).toBe('home');
    // The AC-3 contract is about *resolution*, not just the raw field: a
    // subsequent profile-less command must resolve to "home" too.
    expect(resolveProfile(reloaded)?.alias).toBe('home');
  });

  it('rejects an unknown alias with CliError(EXIT.NOT_FOUND) and writes nothing', async () => {
    upsertProfile(sampleProfile({ alias: 'work' }));
    const before = loadConfig();
    // The above `upsertProfile` already invoked the mocked `renameSync`
    // (atomic-write primitive `saveConfig` ultimately calls) once; clear
    // that call so the assertion below is specific to the rejected `use`.
    (renameSync as jest.Mock).mockClear();

    const program = build();
    let caught: unknown;
    try {
      await program.parseAsync(['profiles', 'use', 'ghost'], { from: 'user' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).exitCode).toBe(EXIT.NOT_FOUND);
    expect((caught as CliError).message).toBe('no such profile: ghost');
    // No config mutation on failure, and — unlike a plain before/after
    // content comparison, which can't detect a write that happens to
    // reproduce identical bytes — the atomic-write path itself never ran.
    expect(loadConfig()).toEqual(before);
    expect(renameSync).not.toHaveBeenCalled();
  });

  it('rejects an alias that is only an inherited Object.prototype key (e.g. "toString")', async () => {
    upsertProfile(sampleProfile({ alias: 'work' }));
    const before = loadConfig();

    const program = build();
    let caught: unknown;
    try {
      await program.parseAsync(['profiles', 'use', 'toString'], { from: 'user' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).exitCode).toBe(EXIT.NOT_FOUND);
    expect(loadConfig()).toEqual(before);
  });

  it('lets a general config failure (e.g. unparsable JSON) surface as the CLI general error, not NOT_FOUND', async () => {
    upsertProfile(sampleProfile({ alias: 'work' }));
    // Corrupt the store after the profile was written, so `use` hits the
    // parse failure inside `loadConfig()` instead of the "unknown alias"
    // branch — this must NOT be reported as exit 4.
    writeFileSync(configPath(), '{ not valid json', 'utf8');

    const program = build();
    let caught: unknown;
    try {
      await program.parseAsync(['profiles', 'use', 'work'], { from: 'user' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(CliError);
    expect((caught as Error).message).toContain('failed to parse config');
  });

  it('reports success on stderr, not stdout', async () => {
    upsertProfile(sampleProfile({ alias: 'work' }));
    upsertProfile(sampleProfile({ alias: 'home', endpoint: 'https://home.example' }));

    const program = build();
    await program.parseAsync(['profiles', 'use', 'home'], { from: 'user' });

    expect(stdoutText()).toBe('');
    expect(stderrText()).toContain('home');
  });
});

describe('crowi profiles — switch hint on stderr only (AC-4)', () => {
  it('keeps the human table on stdout and puts the switch hint on stderr, not mixed in', async () => {
    upsertProfile(sampleProfile({ alias: 'work' }));

    const program = build();
    await program.parseAsync(['profiles'], { from: 'user' });

    expect(stdoutText()).toContain('work');
    expect(stdoutText()).not.toContain('profiles use');
    expect(stderrText()).toContain('crowi profiles use <alias>');
  });

  it('suppresses the hint under --quiet (same as any other info() line)', async () => {
    upsertProfile(sampleProfile({ alias: 'work' }));

    const program = build();
    await program.parseAsync(['profiles', '--quiet'], { from: 'user' });

    expect(stderrText()).toBe('');
  });

  it('--json stdout is exactly { currentProfile, profiles } — no hint, no extra fields', async () => {
    upsertProfile(sampleProfile({ alias: 'work' }));

    const program = build();
    await program.parseAsync(['profiles', '--json'], { from: 'user' });

    const parsed: unknown = JSON.parse(stdoutText());
    expect(parsed).toEqual({
      currentProfile: 'work',
      profiles: [
        {
          alias: 'work',
          endpoint: 'https://wiki.example.com',
          account: 'alice',
          scope: 'pages:read pages:write',
          current: true,
        },
      ],
    });
    // The hint still goes to stderr (independent of --json) but never stdout.
    expect(stderrText()).toContain('crowi profiles use <alias>');
  });

  it('marks the current profile with * in the human table', async () => {
    upsertProfile(sampleProfile({ alias: 'work' }));
    upsertProfile(sampleProfile({ alias: 'home', endpoint: 'https://home.example', account: 'bob' }));

    const program = build();
    await program.parseAsync(['profiles'], { from: 'user' });

    const text = stdoutText();
    expect(text).toMatch(/^\* work\b/m);
    expect(text).toMatch(/^ {2}home\b/m);
  });
});
