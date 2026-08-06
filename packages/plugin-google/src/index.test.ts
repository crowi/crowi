import type { AuthDriver, AuthRegistry, OidcAuthDriver, PluginContext } from '@crowi/plugin-api';
import { GoogleConfigSchema, plugin } from './index';

/**
 * RFC-0014 phase 4 (AC-1) — the plugin is a declaration, so these are
 * assertions about what it declares. The OIDC protocol itself belongs to
 * the SDK factory (phase 0) and the federated routes (phase 1) and is
 * tested there; nothing here talks to Google.
 */

/** Captures what `registerAuth` registers, without a real registry. */
function registerAndCapture(config: Partial<Record<string, string>>): { name: string; driver: OidcAuthDriver } {
  const captured: { name?: string; driver?: AuthDriver } = {};
  const registry = {
    register(name: string, driver: AuthDriver) {
      captured.name = name;
      captured.driver = driver;
    },
  } as unknown as AuthRegistry;

  const ctx = { config: () => config } as unknown as PluginContext;
  plugin.registerAuth?.(registry, ctx);

  if (!captured.name || !captured.driver) throw new Error('registerAuth registered nothing');
  return { name: captured.name, driver: captured.driver as OidcAuthDriver };
}

describe('@crowi/plugin-google', () => {
  describe('plugin metadata', () => {
    it('declares the npm name it is loaded under, so its config namespace resolves', () => {
      expect(plugin.name).toBe('@crowi/plugin-google');
    });

    // NOT `'auth'` — which is what `deriveSectionFromHooks` infers from
    // `registerAuth`, and what this test used to assert. The admin
    // sidebar renders no heading for that section, so the entry was
    // dropped and the config page was reachable only by typing its URL.
    // Google is an external service integration, like Slack.
    it('places itself in the admin platform-services section, which the sidebar actually renders', () => {
      expect(plugin.adminPlacement?.section).toBe('platform');
    });

    // lucide has no Google logo and its `Chrome` icon names a different
    // product, so the web app ships the official mark under this name.
    it('asks for the Google brand mark by name', () => {
      expect(plugin.adminPlacement?.icon).toBe('google');
    });

    it('ships ja and en labels for both credential fields', () => {
      for (const locale of ['ja', 'en'] as const) {
        expect(plugin.configI18n?.[locale]?.clientId?.label).toBeTruthy();
        expect(plugin.configI18n?.[locale]?.clientSecret?.label).toBeTruthy();
      }
    });
  });

  describe('config schema', () => {
    it('defaults both credentials to empty, so an unconfigured install parses cleanly', () => {
      expect(GoogleConfigSchema.parse({})).toEqual({ clientId: '', clientSecret: '' });
    });

    it('trims surrounding whitespace — a pasted credential with a stray newline must not silently differ from the real one', () => {
      expect(GoogleConfigSchema.parse({ clientId: '  abc.apps.googleusercontent.com \n', clientSecret: ' s3cret ' })).toEqual({
        clientId: 'abc.apps.googleusercontent.com',
        clientSecret: 's3cret',
      });
    });

    it('rejects unknown fields rather than silently dropping them', () => {
      expect(GoogleConfigSchema.safeParse({ clientId: 'a', clientSecret: 'b', extra: 'x' }).success).toBe(false);
    });

    it('marks only the secret @sensitive', () => {
      expect(GoogleConfigSchema.shape.clientSecret.description).toContain('@sensitive');
      expect(GoogleConfigSchema.shape.clientId.description ?? '').not.toContain('@sensitive');
    });
  });

  describe('atomic credential group (AC-2)', () => {
    it('stores the id and secret together, encrypted, as one group', () => {
      expect(plugin.configAtomicGroups).toEqual([{ name: 'clientCredentials', keys: ['clientId', 'clientSecret'], sensitive: true }]);
    });

    it('covers exactly the schema fields — a credential left outside the group would still be writable on its own', () => {
      const grouped = (plugin.configAtomicGroups ?? []).flatMap((g) => g.keys).sort();
      expect(grouped).toEqual(Object.keys(GoogleConfigSchema.shape).sort());
    });
  });

  describe('driver registration (AC-1)', () => {
    it('registers an OIDC driver under the fixed `google` slug', () => {
      const { name, driver } = registerAndCapture({ clientId: 'id', clientSecret: 'secret' });
      // The slug is embedded in start URLs and stored in every
      // UserIdentity — it is not operator-configurable.
      expect(name).toBe('google');
      expect(driver.kind).toBe('oidc');
    });

    it("uses Google's discovery document and the scopes JIT provisioning needs", () => {
      const { driver } = registerAndCapture({ clientId: 'id', clientSecret: 'secret' });
      expect(driver.discoveryUrl).toBe('https://accounts.google.com/.well-known/openid-configuration');
      // `email` is not optional decoration: phase 2 refuses to provision
      // an account without a verified email.
      expect(driver.scopes).toEqual(['openid', 'email', 'profile']);
      expect(driver.buttonLabel).toBe('Google');
    });

    it('registers WITHOUT reading config or reaching the network — enablement is decided per request', () => {
      let configReads = 0;
      const registry = { register: () => undefined } as unknown as AuthRegistry;
      const ctx = {
        config: () => {
          configReads += 1;
          return {};
        },
      } as unknown as PluginContext;

      plugin.registerAuth?.(registry, ctx);

      // Reading config at registration would freeze enablement at boot, so
      // pasting credentials into the admin form would need a restart.
      expect(configReads).toBe(0);
    });
  });

  describe('lazy enablement (AC-1)', () => {
    it('is enabled only once BOTH credentials are present', () => {
      const { driver } = registerAndCapture({ clientId: 'id', clientSecret: 'secret' });
      expect(driver.getClientConfig()).toEqual({ clientId: 'id', clientSecret: 'secret' });
    });

    it.each([
      ['nothing configured', {}],
      ['id only', { clientId: 'id', clientSecret: '' }],
      ['secret only', { clientId: '', clientSecret: 'secret' }],
    ])('reports not-configured for %s, so no half-working button is offered', (_label, config) => {
      const { driver } = registerAndCapture(config);
      // `null` is what keeps the provider out of the public list entirely —
      // a Google button that could only ever fail is never rendered.
      expect(driver.getClientConfig()).toBeNull();
    });

    it('follows config changes without re-registration', () => {
      const mutable: Record<string, string> = { clientId: '', clientSecret: '' };
      const registry = {
        register: (_name: string, driver: AuthDriver) => {
          mutableDriver = driver as OidcAuthDriver;
        },
      } as unknown as AuthRegistry;
      let mutableDriver: OidcAuthDriver | undefined;
      plugin.registerAuth?.(registry, { config: () => mutable } as unknown as PluginContext);

      expect(mutableDriver?.getClientConfig()).toBeNull();
      mutable.clientId = 'id';
      mutable.clientSecret = 'secret';
      expect(mutableDriver?.getClientConfig()).toEqual({ clientId: 'id', clientSecret: 'secret' });
    });
  });
});
