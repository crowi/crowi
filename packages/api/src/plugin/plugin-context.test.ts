import type { CrowiPlugin, PluginContext } from '@crowi/plugin-api';
import { CREDENTIAL_VAULT_MODEL_NAMES } from './credential-vault-models';
import { createPluginContext, type PluginLookup } from './plugin-context';

/**
 * Minimal fake `Crowi` — only `model()` (keyed off the `models` map
 * passed in) is exercised by the tests below. Matches the `makeFakeCrowi(): any`
 * precedent in `plugin-manager.test.ts`.
 */
function makeFakeCrowi(models: Record<string, unknown> = {}): any {
  return {
    getConfig: () => ({ crowi: {} }),
    getConfigService: () => ({ saveConfigValue: jest.fn() }),
    getBaseUrl: () => null,
    model: (name: string) => models[name],
  };
}

function stubPlugin(overrides: Partial<CrowiPlugin> & Pick<CrowiPlugin, 'name'>): CrowiPlugin {
  return {
    version: '0.0.0',
    ...overrides,
  } as CrowiPlugin;
}

const noopLookup: PluginLookup = {
  getLoadedPlugin: () => undefined,
  getOrCreateStateCell: (_pluginName, initial) => {
    let current = initial;
    return {
      get: () => current,
      withValue: async (fn) => fn(current),
      set: (next) => {
        current = next;
      },
    };
  },
};

describe('createPluginContext — ctx.model() gated by plugin.modelAccess (feature-plugin-capability-scoping)', () => {
  it("throws \"did not declare it in 'modelAccess'\" when the requested model isn't declared", () => {
    const plugin = stubPlugin({ name: '@crowi/plugin-under-test', modelAccess: ['Page'] });
    const ctx = createPluginContext(plugin, makeFakeCrowi(), noopLookup);

    expect(() => ctx.model('User')).toThrow("Plugin '@crowi/plugin-under-test' called model('User') but did not declare it in 'modelAccess'.");
  });

  it('throws for any model name when the plugin declares no modelAccess at all', () => {
    const plugin = stubPlugin({ name: '@crowi/plugin-no-declare' });
    const ctx = createPluginContext(plugin, makeFakeCrowi(), noopLookup);

    expect(() => ctx.model('Page')).toThrow("Plugin '@crowi/plugin-no-declare' called model('Page') but did not declare it in 'modelAccess'.");
  });

  it('returns the underlying model with full access once it is declared in modelAccess', () => {
    const PageModel = { find: jest.fn(), updateOne: jest.fn() };
    const plugin = stubPlugin({ name: '@crowi/plugin-with-access', modelAccess: ['Page'] });
    const ctx = createPluginContext(plugin, makeFakeCrowi({ Page: PageModel }), noopLookup);

    expect(ctx.model('Page')).toBe(PageModel);
  });

  it('only grants the declared subset — a second, undeclared model still throws', () => {
    const PageModel = {};
    const UserModel = {};
    const plugin = stubPlugin({ name: '@crowi/plugin-partial-access', modelAccess: ['Page'] });
    const ctx = createPluginContext(plugin, makeFakeCrowi({ Page: PageModel, User: UserModel }), noopLookup);

    expect(ctx.model('Page')).toBe(PageModel);
    expect(() => ctx.model('User')).toThrow("did not declare it in 'modelAccess'");
  });
});

describe('createPluginContext — ctx.model() credential-vault deny-list call-time gate (feature-plugin-capability-hardening)', () => {
  it.each([
    ...CREDENTIAL_VAULT_MODEL_NAMES,
  ])("throws for '%s' even when the plugin declares it in modelAccess (defense-in-depth against a bypassed boot check)", (deniedModel) => {
    const plugin = stubPlugin({ name: '@crowi/plugin-vault-grab', modelAccess: [deniedModel] });
    const ctx = createPluginContext(plugin, makeFakeCrowi({ [deniedModel]: {} }), noopLookup);

    expect(() => ctx.model(deniedModel)).toThrow('credential-bearing core models cannot be granted to plugins');
  });

  it('does not affect access to a non-denied model declared in modelAccess', () => {
    const PageModel = { find: jest.fn() };
    const plugin = stubPlugin({ name: '@crowi/plugin-vault-safe', modelAccess: ['Page'] });
    const ctx = createPluginContext(plugin, makeFakeCrowi({ Page: PageModel }), noopLookup);

    expect(ctx.model('Page')).toBe(PageModel);
  });
});

describe('createPluginContext — ctx.dependencyConfig() opt-in gate (feature-plugin-capability-hardening)', () => {
  it('throws when the caller did not list the dependency in requires (existing contract preserved)', () => {
    const plugin = stubPlugin({ name: '@crowi/plugin-caller' });
    const ctx = createPluginContext(plugin, makeFakeCrowi(), noopLookup);

    expect(() => ctx.dependencyConfig('@crowi/plugin-aws')).toThrow(
      "Plugin '@crowi/plugin-caller' tried to read dependency config of '@crowi/plugin-aws', but did not list it in 'requires'.",
    );
  });

  it('throws when the dependency is listed in requires but did not opt in with exposesConfigToDependents', () => {
    const dep = stubPlugin({
      name: '@crowi/plugin-quiet',
      configSchema: { safeParse: () => ({ success: true, data: {} }) } as unknown as CrowiPlugin['configSchema'],
    });
    const plugin = stubPlugin({ name: '@crowi/plugin-caller', requires: ['@crowi/plugin-quiet'] });
    const lookup: PluginLookup = { ...noopLookup, getLoadedPlugin: (name) => (name === dep.name ? dep : undefined) };
    const ctx = createPluginContext(plugin, makeFakeCrowi(), lookup);

    expect(() => ctx.dependencyConfig('@crowi/plugin-quiet')).toThrow(
      "Plugin '@crowi/plugin-caller' tried to read dependency config of '@crowi/plugin-quiet', but the dependency did not declare 'exposesConfigToDependents'.",
    );
  });

  it('throws when the dependency sets exposesConfigToDependents to a truthy non-boolean value (strict === true gate, not truthiness)', () => {
    const dep = stubPlugin({
      name: '@crowi/plugin-loose',
      // Cast past the `boolean` type to simulate a misconfigured / JS
      // plugin export — the runtime gate must not be fooled by a
      // truthy-but-not-`true` value (feature-plugin-capability-hardening).
      exposesConfigToDependents: 'yes' as unknown as boolean,
      configSchema: { safeParse: () => ({ success: true, data: {} }) } as unknown as CrowiPlugin['configSchema'],
    });
    const plugin = stubPlugin({ name: '@crowi/plugin-caller', requires: ['@crowi/plugin-loose'] });
    const lookup: PluginLookup = { ...noopLookup, getLoadedPlugin: (name) => (name === dep.name ? dep : undefined) };
    const ctx = createPluginContext(plugin, makeFakeCrowi(), lookup);

    expect(() => ctx.dependencyConfig('@crowi/plugin-loose')).toThrow(
      "Plugin '@crowi/plugin-caller' tried to read dependency config of '@crowi/plugin-loose', but the dependency did not declare 'exposesConfigToDependents'.",
    );
  });

  it('returns the parsed (decrypted) config when the dependency opted in with exposesConfigToDependents: true', () => {
    const dep = stubPlugin({
      name: '@crowi/plugin-generous',
      exposesConfigToDependents: true,
      configSchema: { safeParse: (ns: unknown) => ({ success: true, data: ns }) } as unknown as CrowiPlugin['configSchema'],
    });
    const plugin = stubPlugin({ name: '@crowi/plugin-caller', requires: ['@crowi/plugin-generous'] });
    const lookup: PluginLookup = { ...noopLookup, getLoadedPlugin: (name) => (name === dep.name ? dep : undefined) };
    const crowi = makeFakeCrowi();
    crowi.getConfig = () => ({ crowi: { 'plugin:@crowi/plugin-generous:secretAccessKey': 'decrypted-value' } });
    const ctx = createPluginContext(plugin, crowi, lookup);

    expect(ctx.dependencyConfig<{ secretAccessKey: string }>('@crowi/plugin-generous')).toEqual({ secretAccessKey: 'decrypted-value' });
  });

  it('regression: the real @crowi/plugin-aws declares exposesConfigToDependents, so a storage/mail-style dependent can still read its config', async () => {
    const awsPlugin = (await import('@crowi/plugin-aws')).default;
    expect(awsPlugin.exposesConfigToDependents).toBe(true);

    const dependent = stubPlugin({ name: '@crowi/plugin-storage-aws-s3-like', requires: [awsPlugin.name] });
    const lookup: PluginLookup = { ...noopLookup, getLoadedPlugin: (name) => (name === awsPlugin.name ? awsPlugin : undefined) };
    const crowi = makeFakeCrowi();
    crowi.getConfig = () => ({
      crowi: {
        'plugin:@crowi/plugin-aws:region': 'ap-northeast-1',
        'plugin:@crowi/plugin-aws:accessKeyId': 'AKIAEXAMPLE',
        'plugin:@crowi/plugin-aws:secretAccessKey': 'decrypted-secret',
      },
    });
    const ctx = createPluginContext(dependent, crowi, lookup);

    expect(ctx.dependencyConfig('@crowi/plugin-aws')).toMatchObject({
      region: 'ap-northeast-1',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'decrypted-secret',
    });
  });
});

describe('createPluginContext — ctx.crypto removal regression (feature-plugin-capability-scoping)', () => {
  it('does not expose a crypto field on the returned PluginContext instance', () => {
    const plugin = stubPlugin({ name: '@crowi/plugin-no-crypto' });
    const ctx: PluginContext = createPluginContext(plugin, makeFakeCrowi(), noopLookup);

    // Runtime check: the object literal `createPluginContext()` builds no
    // longer includes a `crypto` key at all (not merely `undefined`).
    // The type-level half of this regression (no `crypto: PluginCrypto`
    // field on `PluginContext`, no `PluginCrypto` export from
    // `@crowi/plugin-api`) is enforced structurally: `ctx` above is typed
    // as `PluginContext`, and `createPluginContext`'s `return { ... }` is
    // excess-property-checked against that same interface by
    // `pnpm --filter @crowi/api type-check` — a stray `crypto` field in
    // the object literal would fail that check.
    expect(Object.hasOwn(ctx, 'crypto')).toBe(false);
  });
});
