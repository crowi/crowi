import type { CrowiPlugin, PluginContext } from '@crowi/plugin-api';
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
