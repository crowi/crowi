import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type ConfigFile,
  configDir,
  configPath,
  loadConfig,
  type Profile,
  removeProfile,
  resolveProfile,
  saveConfig,
  setCurrentProfile,
  stripTrailingSlash,
  upsertProfile,
} from './config';

/**
 * The config store holds OAuth tokens, so the on-disk security properties
 * (0600 file mode, atomic write, drift-tightening on read) matter as much as
 * the data round-trip. These tests point `$XDG_CONFIG_HOME` at a throwaway
 * temp dir so they touch a real filesystem (to assert permissions) without
 * mutating the developer's `~/.config/crowi`.
 */

let tmpRoot: string;
const ORIGINAL_XDG = process.env.XDG_CONFIG_HOME;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'crowi-cli-config-'));
  process.env.XDG_CONFIG_HOME = tmpRoot;
  // Clear the profile-resolution env knobs so individual tests control them.
  delete process.env.CROWI_PROFILE;
  delete process.env.CROWI_URL;
  delete process.env.CROWI_TOKEN;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (ORIGINAL_XDG === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = ORIGINAL_XDG;
  }
});

const sampleProfile = (overrides: Partial<Profile> = {}): Profile => ({
  alias: 'work',
  endpoint: 'https://wiki.example.com',
  account: 'alice',
  tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: 123, scope: 'pages:read pages:write' },
  ...overrides,
});

describe('config paths', () => {
  it('places contexts.json under $XDG_CONFIG_HOME/crowi', () => {
    expect(configDir()).toBe(join(tmpRoot, 'crowi'));
    expect(configPath()).toBe(join(tmpRoot, 'crowi', 'contexts.json'));
  });

  it('falls back to ~/.config/crowi when XDG_CONFIG_HOME is blank', () => {
    process.env.XDG_CONFIG_HOME = '   ';
    expect(configDir().endsWith(join('.config', 'crowi'))).toBe(true);
  });
});

describe('loadConfig', () => {
  it('returns an empty config when the file does not exist', () => {
    expect(loadConfig()).toEqual({ currentProfile: undefined, profiles: {} });
  });

  it('returns an empty config for a blank file', () => {
    saveConfig({ profiles: {} });
    writeFileSync(configPath(), '   \n');
    expect(loadConfig().profiles).toEqual({});
  });

  it('throws a path-bearing error on malformed JSON', () => {
    saveConfig({ profiles: {} });
    writeFileSync(configPath(), '{not json');
    expect(() => loadConfig()).toThrow(/failed to parse config/);
  });

  it('throws when the JSON is a non-object primitive', () => {
    saveConfig({ profiles: {} });
    writeFileSync(configPath(), '42');
    expect(() => loadConfig()).toThrow(/not a JSON object/);
  });

  it('tightens a loose-permission file back to 0600 on read', () => {
    saveConfig({ profiles: { work: sampleProfile() } });
    // Loosen the perms as a hand-edit or a careless copy might.
    const path = configPath();
    writeFileSync(path, '{"profiles":{}}', { mode: 0o644 });
    loadConfig();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('saveConfig', () => {
  it('round-trips currentProfile + profiles', () => {
    const config: ConfigFile = { currentProfile: 'work', profiles: { work: sampleProfile() } };
    saveConfig(config);
    expect(loadConfig()).toEqual(config);
  });

  it('writes the file with mode 0600', () => {
    saveConfig({ profiles: { work: sampleProfile() } });
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
  });

  it('creates the directory with mode 0700', () => {
    saveConfig({ profiles: {} });
    expect(statSync(configDir()).mode & 0o777).toBe(0o700);
  });
});

describe('upsertProfile', () => {
  it('inserts a profile and makes it current when none was set', () => {
    upsertProfile(sampleProfile());
    const config = loadConfig();
    expect(config.profiles.work).toBeDefined();
    expect(config.currentProfile).toBe('work');
  });

  it('does not steal the current pointer from an existing profile', () => {
    upsertProfile(sampleProfile({ alias: 'work' }));
    upsertProfile(sampleProfile({ alias: 'home', endpoint: 'https://home.example' }));
    expect(loadConfig().currentProfile).toBe('work');
  });

  it('replaces an existing profile in place', () => {
    upsertProfile(sampleProfile());
    upsertProfile(sampleProfile({ account: 'bob' }));
    expect(loadConfig().profiles.work.account).toBe('bob');
  });
});

describe('removeProfile', () => {
  it('removes a profile and reports success', () => {
    upsertProfile(sampleProfile());
    expect(removeProfile('work')).toBe(true);
    expect(loadConfig().profiles.work).toBeUndefined();
  });

  it('returns false for an unknown profile', () => {
    expect(removeProfile('nope')).toBe(false);
  });

  it('re-points currentProfile to a survivor when the current one is removed', () => {
    upsertProfile(sampleProfile({ alias: 'work' }));
    upsertProfile(sampleProfile({ alias: 'home', endpoint: 'https://home.example' }));
    setCurrentProfile('work');
    removeProfile('work');
    expect(loadConfig().currentProfile).toBe('home');
  });

  it('clears currentProfile when the last profile is removed', () => {
    upsertProfile(sampleProfile());
    removeProfile('work');
    expect(loadConfig().currentProfile).toBeUndefined();
  });
});

describe('setCurrentProfile', () => {
  it('throws for an unknown profile', () => {
    expect(() => setCurrentProfile('ghost')).toThrow(/no such profile/);
  });
});

describe('resolveProfile', () => {
  it('returns undefined when nothing resolves', () => {
    expect(resolveProfile({ profiles: {} })).toBeUndefined();
  });

  it('prefers --url/--token as an ephemeral ad-hoc profile (never stored)', () => {
    const config: ConfigFile = { currentProfile: 'work', profiles: { work: sampleProfile() } };
    const resolved = resolveProfile(config, { url: 'https://adhoc.example/', token: 'pat123' });
    expect(resolved).toEqual({
      alias: '(ad-hoc)',
      endpoint: 'https://adhoc.example',
      tokens: { accessToken: 'pat123' },
    });
  });

  it('resolves --profile over the stored current pointer', () => {
    const config: ConfigFile = {
      currentProfile: 'work',
      profiles: { work: sampleProfile(), home: sampleProfile({ alias: 'home' }) },
    };
    expect(resolveProfile(config, { profile: 'home' })?.alias).toBe('home');
  });

  it('falls back to $CROWI_PROFILE then currentProfile', () => {
    const config: ConfigFile = {
      currentProfile: 'work',
      profiles: { work: sampleProfile(), home: sampleProfile({ alias: 'home' }) },
    };
    process.env.CROWI_PROFILE = 'home';
    expect(resolveProfile(config)?.alias).toBe('home');
    delete process.env.CROWI_PROFILE;
    expect(resolveProfile(config)?.alias).toBe('work');
  });
});

describe('stripTrailingSlash', () => {
  it('removes a single trailing slash and leaves a clean URL untouched', () => {
    expect(stripTrailingSlash('https://x.example/')).toBe('https://x.example');
    expect(stripTrailingSlash('https://x.example')).toBe('https://x.example');
  });
});
