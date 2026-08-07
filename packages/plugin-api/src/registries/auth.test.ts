import type { Configuration } from 'openid-client';
import type {
  AuthDriverKind as AuthDriverKindFromRoot,
  CredentialAuthDriver as CredentialAuthDriverFromRoot,
  OAuth2AuthDriver as OAuth2AuthDriverFromRoot,
  OAuthClientConfig as OAuthClientConfigFromRoot,
  OidcAuthDriver as OidcAuthDriverFromRoot,
} from '../index';
import { createOAuth2Driver as createOAuth2DriverFromRoot, createOidcDriver as createOidcDriverFromRoot } from '../index';
import type { AuthDriver, AuthDriverKind, AuthRegistry, CredentialAuthDriver, OAuth2AuthDriver, OAuthClientConfig, OidcAuthDriver } from './auth';
import { createOAuth2Driver, createOidcDriver } from './auth';

// `openid-client` is published ESM-only; `resolveOidcConfiguration()` in
// `auth.ts` loads it via a deferred `import()` so it is never touched
// unless `getConfiguration()` actually runs a discovery. Mocking it here
// keeps every test in this file from ever loading the real package.
jest.mock('openid-client', () => ({ discovery: jest.fn() }));

// biome-ignore lint/suspicious/noExplicitAny: jest.mock factory above returns an untyped module shape
const mockDiscovery: jest.Mock = jest.requireMock('openid-client').discovery;

// This package's jest config sets neither `clearMocks` nor `resetMocks`
// (unlike `packages/api`'s), so `mockDiscovery`'s call history and queued
// `mockResolvedValueOnce`/`mockImplementationOnce` results would otherwise
// leak across `it()` blocks in this file.
beforeEach(() => {
  mockDiscovery.mockReset();
});

/** Minimal in-memory `AuthRegistry`, mirroring what a plugin's `registerAuth(registry, ctx)` receives. */
function makeTestRegistry(): { registry: AuthRegistry; drivers: Map<string, AuthDriver> } {
  const drivers = new Map<string, AuthDriver>();
  return {
    registry: {
      register: (driverName, driver) => {
        drivers.set(driverName, driver);
      },
    },
    drivers,
  };
}

/** A fake `Configuration` — opaque to this module, only used for identity comparisons. */
function fakeConfiguration(tag: string): Configuration {
  return { tag } as unknown as Configuration;
}

let discoveryUrlCounter = 0;
/** A fresh discovery URL per call so cache entries never collide across tests. */
function uniqueDiscoveryUrl(): string {
  discoveryUrlCounter += 1;
  return `https://idp.example.com/${discoveryUrlCounter}/.well-known/openid-configuration`;
}

describe('AuthDriver discriminated union (AC-1)', () => {
  it('accepts a credential driver as an AuthDriver', () => {
    const credential: CredentialAuthDriver = {
      kind: 'credential',
      fields: [{ name: 'username', label: 'Username' }],
      verify: async () => ({ ok: false, reason: 'not implemented' }),
    };
    const driver: AuthDriver = credential;
    expect(driver.kind).toBe('credential');
  });

  it('accepts an oauth2 driver (from createOAuth2Driver) as an AuthDriver', () => {
    const driver: AuthDriver = createOAuth2Driver({
      buttonLabel: 'GitHub',
      authorizeUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      getClientConfig: () => null,
      fetchProfile: async () => ({ ok: false, reason: 'not implemented' }),
    });
    expect(driver.kind).toBe('oauth2');
  });

  it('accepts an oidc driver (from createOidcDriver) as an AuthDriver', () => {
    const driver: AuthDriver = createOidcDriver({
      buttonLabel: 'Google',
      discoveryUrl: uniqueDiscoveryUrl(),
      getClientConfig: () => null,
    });
    expect(driver.kind).toBe('oidc');
  });

  it("'saml' is a valid AuthDriverKind but is not an AuthDriver member (compile-time only)", () => {
    const kind: AuthDriverKind = 'saml';
    expect(kind).toBe('saml');
  });

  it('exposes both factories and the driver types from the package root entry point', () => {
    expect(createOAuth2DriverFromRoot).toBe(createOAuth2Driver);
    expect(createOidcDriverFromRoot).toBe(createOidcDriver);
  });

  it('root-exported types are usable in place of the internal ./registries/auth types (contract regression guard)', () => {
    // This test's value is at compile time: if `src/index.ts` ever drops or
    // renames one of these exports, `pnpm --filter @crowi/plugin-api
    // type-check` fails here instead of only inside a plugin author's own
    // build, months later.
    const credential: CredentialAuthDriverFromRoot = {
      kind: 'credential',
      fields: [{ name: 'username', label: 'Username' }],
      verify: async () => ({ ok: false, reason: 'not implemented' }),
    };
    const oauth2: OAuth2AuthDriverFromRoot = createOAuth2DriverFromRoot({
      buttonLabel: 'GitHub',
      authorizeUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      getClientConfig: () => null,
      fetchProfile: async () => ({ ok: false, reason: 'not implemented' }),
    });
    const oidc: OidcAuthDriverFromRoot = createOidcDriverFromRoot({
      buttonLabel: 'Google',
      discoveryUrl: uniqueDiscoveryUrl(),
      getClientConfig: () => null,
    });
    const config: OAuthClientConfigFromRoot = { clientId: 'client-x', clientSecret: 'secret-y' };
    const kind: AuthDriverKindFromRoot = 'saml';

    expect(credential.kind).toBe('credential');
    expect(oauth2.kind).toBe('oauth2');
    expect(oidc.kind).toBe('oidc');
    expect(config.clientId).toBe('client-x');
    expect(kind).toBe('saml');
  });
});

describe('createOAuth2Driver / createOidcDriver — synchronous, I/O-free factories (AC-1, AC-2)', () => {
  it('rejects an empty buttonLabel synchronously', () => {
    expect(() =>
      createOAuth2Driver({
        buttonLabel: '   ',
        authorizeUrl: 'https://idp.example.com/authorize',
        tokenUrl: 'https://idp.example.com/token',
        getClientConfig: () => null,
        fetchProfile: async () => ({ ok: false, reason: 'unused' }),
      }),
    ).toThrow(TypeError);
  });

  it('rejects an invalid authorizeUrl synchronously', () => {
    expect(() =>
      createOAuth2Driver({
        buttonLabel: 'Example',
        authorizeUrl: 'not-a-url',
        tokenUrl: 'https://idp.example.com/token',
        getClientConfig: () => null,
        fetchProfile: async () => ({ ok: false, reason: 'unused' }),
      }),
    ).toThrow(TypeError);
  });

  it('rejects an empty scope entry synchronously', () => {
    expect(() =>
      createOidcDriver({
        buttonLabel: 'Google',
        discoveryUrl: uniqueDiscoveryUrl(),
        scopes: ['openid', '  '],
        getClientConfig: () => null,
      }),
    ).toThrow(TypeError);
  });

  it('rejects an invalid discoveryUrl synchronously', () => {
    expect(() =>
      createOidcDriver({
        buttonLabel: 'Google',
        discoveryUrl: 'not-a-url',
        getClientConfig: () => null,
      }),
    ).toThrow(TypeError);
  });

  it('defaults oauth2 scopes to [] and preserves the pkce option as-is', () => {
    const driver = createOAuth2Driver({
      buttonLabel: 'Example',
      authorizeUrl: 'https://idp.example.com/authorize',
      tokenUrl: 'https://idp.example.com/token',
      pkce: true,
      getClientConfig: () => null,
      fetchProfile: async () => ({ ok: false, reason: 'unused' }),
    });
    expect(driver.scopes).toEqual([]);
    expect(driver.pkce).toBe(true);
  });

  it("defaults oidc scopes to ['openid', 'email', 'profile'] and always sets pkce: true", () => {
    const driver = createOidcDriver({
      buttonLabel: 'Google',
      discoveryUrl: uniqueDiscoveryUrl(),
      getClientConfig: () => null,
    });
    expect(driver.scopes).toEqual(['openid', 'email', 'profile']);
    expect(driver.pkce).toBe(true);
  });

  it('does not call getClientConfig() at creation time, and registering the driver does not call it either (AC-2)', () => {
    const getClientConfig = jest.fn<OAuthClientConfig | null, []>(() => null);
    const driver = createOidcDriver({
      buttonLabel: 'Google',
      discoveryUrl: uniqueDiscoveryUrl(),
      getClientConfig,
    });

    const { registry } = makeTestRegistry();
    registry.register('google', driver);

    expect(getClientConfig).not.toHaveBeenCalled();
    expect(mockDiscovery).not.toHaveBeenCalled();
  });

  it('does not call getClientConfig() at creation time for oauth2 either (AC-2)', () => {
    const getClientConfig = jest.fn<OAuthClientConfig | null, []>(() => null);
    const fetchProfile = jest.fn();
    const driver: OAuth2AuthDriver = createOAuth2Driver({
      buttonLabel: 'GitHub',
      authorizeUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      getClientConfig,
      fetchProfile,
    });

    const { registry } = makeTestRegistry();
    registry.register('github', driver);

    expect(getClientConfig).not.toHaveBeenCalled();
    expect(fetchProfile).not.toHaveBeenCalled();
  });
});

describe('OidcAuthDriver.getConfiguration() — discovery cache (AC-3, AC-4)', () => {
  it('returns null and performs no discovery while unconfigured', async () => {
    const driver: OidcAuthDriver = createOidcDriver({
      buttonLabel: 'Google',
      discoveryUrl: uniqueDiscoveryUrl(),
      getClientConfig: () => null,
    });

    await expect(driver.getConfiguration()).resolves.toBeNull();
    expect(mockDiscovery).not.toHaveBeenCalled();
  });

  it('coalesces concurrent calls into a single discovery and reuses the Configuration within TTL', async () => {
    const discoveryUrl = uniqueDiscoveryUrl();
    const configuration = fakeConfiguration('concurrent');
    let resolveDiscovery: (config: Configuration) => void = () => undefined;
    mockDiscovery.mockImplementationOnce(
      () =>
        new Promise<Configuration>((resolve) => {
          resolveDiscovery = resolve;
        }),
    );

    const driver = createOidcDriver({
      buttonLabel: 'Google',
      discoveryUrl,
      getClientConfig: () => ({ clientId: 'client-1', clientSecret: 'secret-1' }),
    });

    const pending = Promise.all([driver.getConfiguration(), driver.getConfiguration(), driver.getConfiguration()]);
    // Let the three calls above all reach the in-flight-Promise branch before resolving discovery.
    await Promise.resolve();
    await Promise.resolve();
    resolveDiscovery(configuration);
    const [a, b, c] = await pending;

    expect(mockDiscovery).toHaveBeenCalledTimes(1);
    expect(mockDiscovery).toHaveBeenCalledWith(new URL(discoveryUrl), 'client-1', 'secret-1');
    expect(a).toBe(configuration);
    expect(b).toBe(configuration);
    expect(c).toBe(configuration);

    // A subsequent, sequential call within TTL reuses the cached Configuration.
    const again = await driver.getConfiguration();
    expect(again).toBe(configuration);
    expect(mockDiscovery).toHaveBeenCalledTimes(1);
  });

  it('a failed discovery is not cached — the next call retries', async () => {
    const discoveryUrl = uniqueDiscoveryUrl();
    mockDiscovery.mockRejectedValueOnce(new Error('discovery unreachable'));
    const configuration = fakeConfiguration('retry-success');
    mockDiscovery.mockResolvedValueOnce(configuration);

    const driver = createOidcDriver({
      buttonLabel: 'Google',
      discoveryUrl,
      getClientConfig: () => ({ clientId: 'client-1', clientSecret: 'secret-1' }),
    });

    await expect(driver.getConfiguration()).rejects.toThrow('discovery unreachable');
    await expect(driver.getConfiguration()).resolves.toBe(configuration);
    expect(mockDiscovery).toHaveBeenCalledTimes(2);
  });

  it('rotating only the client secret busts the cache: a new discovery runs with the new secret, and no raw secret is logged (AC-4)', async () => {
    const discoveryUrl = uniqueDiscoveryUrl();
    const configurationBefore = fakeConfiguration('before-rotation');
    const configurationAfter = fakeConfiguration('after-rotation');
    mockDiscovery.mockResolvedValueOnce(configurationBefore).mockResolvedValueOnce(configurationAfter);

    const mutableClientConfig: OAuthClientConfig = { clientId: 'client-1', clientSecret: 'old-secret' };
    const driver = createOidcDriver({
      buttonLabel: 'Google',
      discoveryUrl,
      getClientConfig: () => ({ ...mutableClientConfig }),
    });

    // try/finally (not a trailing `.mockRestore()`) so a failed assertion
    // above still restores console spies — otherwise a failure here would
    // leave `console.log`/`warn`/`error` silently swallowed for every test
    // that runs afterward in this file.
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const first = await driver.getConfiguration();
      expect(first).toBe(configurationBefore);

      // Rotate the secret only — still within the 5-minute TTL.
      mutableClientConfig.clientSecret = 'new-secret';
      const second = await driver.getConfiguration();

      expect(second).toBe(configurationAfter);
      expect(second).not.toBe(first);
      expect(mockDiscovery).toHaveBeenCalledTimes(2);
      expect(mockDiscovery).toHaveBeenNthCalledWith(1, new URL(discoveryUrl), 'client-1', 'old-secret');
      expect(mockDiscovery).toHaveBeenNthCalledWith(2, new URL(discoveryUrl), 'client-1', 'new-secret');

      const allLoggedText = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls].flat().map(String).join('\n');
      expect(allLoggedText).not.toContain('old-secret');
      expect(allLoggedText).not.toContain('new-secret');
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('a client-secret mutation racing the deferred openid-client import cannot desync the cache key from the discovered secret (AC-4 regression)', async () => {
    // Regression test for a fixed bug: `resolveOidcConfiguration()` used to
    // read `clientConfig.clientSecret` a *second* time (for the `discovery()`
    // call) after `await import('openid-client')` — a real async boundary.
    // A `getClientConfig()` implementation that returns the *same* mutable
    // object reference on every call (e.g. reading off a plugin's live
    // in-memory config, rather than constructing a fresh object per call)
    // could have that object mutated during that await window. The cache
    // key is computed synchronously *before* the await, so a mutation
    // landing in that window would make discovery() run with a *different*
    // secret than the one the key was derived from — caching the new
    // secret's Configuration under the old secret's fingerprint. The fix
    // snapshots clientId/clientSecret into primitive locals synchronously,
    // before the await, and uses only those locals throughout.
    const discoveryUrl = uniqueDiscoveryUrl();
    const configuration = fakeConfiguration('race-safe');
    mockDiscovery.mockResolvedValueOnce(configuration);

    const sharedClientConfig: OAuthClientConfig = { clientId: 'client-1', clientSecret: 'secret-at-call-time' };
    const driver = createOidcDriver({
      buttonLabel: 'Google',
      discoveryUrl,
      // Same object reference every call — not a fresh copy.
      getClientConfig: () => sharedClientConfig,
    });

    const pending = driver.getConfiguration();
    // `getConfiguration()` above already ran synchronously through the
    // cache-key computation (and the primitive snapshot, post-fix) before
    // suspending at `await import('openid-client')` — the only await in the
    // call chain up to that point. So this mutation lands exactly in the
    // window between "key computed" and "discovery() invoked", the race the
    // fix closes.
    sharedClientConfig.clientSecret = 'secret-mutated-after-call-returns';

    await expect(pending).resolves.toBe(configuration);
    expect(mockDiscovery).toHaveBeenCalledTimes(1);
    // discovery() must run with the secret that was current when
    // getConfiguration() was called — the same value the cache key was
    // derived from — not the value it was mutated to afterward.
    expect(mockDiscovery).toHaveBeenCalledWith(new URL(discoveryUrl), 'client-1', 'secret-at-call-time');
  });

  it('a cached Configuration expires after the 5-minute TTL and the next call re-discovers (performance/resource-limit contract)', async () => {
    jest.useFakeTimers();
    try {
      const discoveryUrl = uniqueDiscoveryUrl();
      const before = fakeConfiguration('ttl-before');
      const after = fakeConfiguration('ttl-after');
      mockDiscovery.mockResolvedValueOnce(before).mockResolvedValueOnce(after);

      const driver = createOidcDriver({
        buttonLabel: 'Google',
        discoveryUrl,
        getClientConfig: () => ({ clientId: 'client-ttl', clientSecret: 'secret-ttl' }),
      });

      await expect(driver.getConfiguration()).resolves.toBe(before);
      expect(mockDiscovery).toHaveBeenCalledTimes(1);

      // One millisecond short of the 5-minute TTL: still a cache hit.
      jest.advanceTimersByTime(5 * 60 * 1000 - 1);
      await expect(driver.getConfiguration()).resolves.toBe(before);
      expect(mockDiscovery).toHaveBeenCalledTimes(1);

      // Past the TTL: cache miss, fresh discovery.
      jest.advanceTimersByTime(2);
      await expect(driver.getConfiguration()).resolves.toBe(after);
      expect(mockDiscovery).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('bounds the module-wide cache at 64 entries, evicting the earliest-expiring entry to make room (performance/resource-limit contract)', async () => {
    jest.useFakeTimers();
    try {
      const baseTime = Date.now();
      // Comfortably more than the 64-entry cap. Regardless of how many
      // entries earlier tests in this file left behind in the shared
      // module-wide cache, those all carry an *earlier* real-time expiry
      // than anything inserted below (whose `expiresAt` starts at
      // `baseTime`, itself >= any earlier test's real wall-clock time), so
      // they are always evicted first; this test only needs enough of its
      // own entries on top to force eviction past that pre-existing count.
      const ENTRY_COUNT = 80;
      const drivers: OidcAuthDriver[] = [];
      for (let i = 0; i < ENTRY_COUNT; i += 1) {
        // Strictly increasing `expiresAt` per entry (distinct ms tick) so
        // eviction order — "evict the earliest-expiring entry" — is
        // deterministic instead of tie-broken.
        jest.setSystemTime(baseTime + i);
        mockDiscovery.mockResolvedValueOnce(fakeConfiguration(`bounded-${i}`));
        const driver = createOidcDriver({
          buttonLabel: 'Google',
          discoveryUrl: uniqueDiscoveryUrl(),
          getClientConfig: () => ({ clientId: `client-bounded-${i}`, clientSecret: `secret-bounded-${i}` }),
        });
        drivers.push(driver);
        // Sequential by design: each iteration must populate the cache
        // before the next mutates system time and queues the next mock
        // resolution.
        await driver.getConfiguration();
      }
      expect(mockDiscovery).toHaveBeenCalledTimes(ENTRY_COUNT);

      // Still well within the 5-minute TTL for every entry above (only
      // `ENTRY_COUNT` ms of fake time elapsed) — so a re-query miss below
      // can only be explained by capacity eviction, not TTL expiry.

      // The earliest-inserted entry in this batch is guaranteed evicted:
      // with >64 entries ever inserted, eviction always removes the
      // globally-smallest `expiresAt` first, and this batch's index-0 entry
      // has the smallest `expiresAt` of anything this test created.
      mockDiscovery.mockResolvedValueOnce(fakeConfiguration('bounded-0-again'));
      await drivers[0].getConfiguration();
      expect(mockDiscovery).toHaveBeenCalledTimes(ENTRY_COUNT + 1);

      // The most-recently-inserted entry is never evicted: it always has
      // the largest `expiresAt` of anything present, so eviction (which
      // always removes the smallest) never selects it.
      await drivers[ENTRY_COUNT - 1].getConfiguration();
      expect(mockDiscovery).toHaveBeenCalledTimes(ENTRY_COUNT + 1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('two independent drivers for the same discoveryUrl/clientId/clientSecret share the module-wide cache', async () => {
    const discoveryUrl = uniqueDiscoveryUrl();
    const configuration = fakeConfiguration('shared-across-drivers');
    mockDiscovery.mockResolvedValueOnce(configuration);
    const getClientConfig = () => ({ clientId: 'client-shared', clientSecret: 'secret-shared' });

    const driverA = createOidcDriver({ buttonLabel: 'A', discoveryUrl, getClientConfig });
    const driverB = createOidcDriver({ buttonLabel: 'B', discoveryUrl, getClientConfig });

    await expect(driverA.getConfiguration()).resolves.toBe(configuration);
    await expect(driverB.getConfiguration()).resolves.toBe(configuration);
    expect(mockDiscovery).toHaveBeenCalledTimes(1);
  });
});
