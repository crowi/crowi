import type { CrowiPlugin } from '@crowi/plugin-api';
import { z } from 'zod/v3';
import { z as zV4 } from 'zod';
import { PluginManager } from './plugin-manager';

function makeFakeCrowi(): any {
  const fakeConfig = {
    onConfigChange: jest.fn(),
    crowi: {} as Record<string, unknown>,
  };
  return {
    getConfigService: () => fakeConfig,
    getConfig: () => ({ crowi: {} }),
    model: () => ({}),
    config: { crowi: {} },
    onConfigChangeMock: fakeConfig.onConfigChange,
  };
}

function stubPlugin(overrides: Partial<CrowiPlugin> & Pick<CrowiPlugin, 'name'>): CrowiPlugin {
  return {
    version: '0.0.0',
    ...overrides,
  } as CrowiPlugin;
}

function loadPluginsInto(manager: PluginManager, plugins: CrowiPlugin[]): void {
  // Bypass `bootstrap()` by populating internals directly. The
  // manager's reconfigure / dependents code paths only depend on
  // `loadedPlugins` + `dependents`, so we exercise them in isolation.
  // biome-ignore lint/suspicious/noExplicitAny: test access to private fields
  (manager as any).loadedPlugins = plugins;
  // biome-ignore lint/suspicious/noExplicitAny: test access to private fields
  (manager as any).buildDependentsMap();
}

// `activate()` is private; the manager's `bootstrap()` entry point pulls in
// `@crowi/runner` + a real Hono/DB boot, which is heavier than these
// pure-function checks need. Invoke it directly, matching the
// `buildDependentsMap()` precedent above. Shared by the malformed-@action
// and zod v3/v4 configSchema guard describe blocks below.
function activate(manager: PluginManager, plugin: CrowiPlugin): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: test access to private fields
  return (manager as any).activate(plugin);
}

// `activateAll()` is private — the loop `bootstrap()` calls to isolate each
// plugin's `activate()` in its own try/catch (feature-plugin-registration-isolation).
// Invoke it directly, same rationale as `activate()`/`assertAllConfigSchemas()` above.
function activateAll(manager: PluginManager, plugins: CrowiPlugin[]): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: test access to private fields
  return (manager as any).activateAll(plugins);
}

// `assertAllConfigSchemas()` is private and is what `bootstrap()` calls
// immediately after topo-sort, before `listSensitiveKeys()` — i.e. before
// any per-plugin `activate()` runs. Invoke it directly (same pattern as
// `activate()` above) to prove the "validate every plugin up front" boot
// order independently of `activate()`'s own per-plugin guard.
function assertAllConfigSchemas(manager: PluginManager, plugins: CrowiPlugin[]): void {
  // biome-ignore lint/suspicious/noExplicitAny: test access to private fields
  (manager as any).assertAllConfigSchemas(plugins);
}

// Exact guard message for a plugin named '@crowi/plugin-v4-mistake' —
// asserted from both the per-plugin `activate()` guard and the
// up-front `assertAllConfigSchemas()` pass below; kept as one constant
// so the two assertions can't drift apart.
const V4_MISTAKE_GUARD_ERROR =
  "Plugin '@crowi/plugin-v4-mistake' declares configSchema built with the top-level 'zod' (v4) API. Import from 'zod/v3' instead — @crowi/plugin-api's config-schema introspection requires the zod v3 compat shape (see @crowi/plugin-api README).";

describe('PluginManager.reconfigureAffected', () => {
  it('calls reconfigure on the changed plugin', async () => {
    const fakeCrowi = makeFakeCrowi();
    const reconfigure = jest.fn();
    const plugin = stubPlugin({ name: 'a', reconfigure });
    const manager = new PluginManager(fakeCrowi);
    loadPluginsInto(manager, [plugin]);

    const result = await manager.reconfigureAffected(['plugin:a']);

    expect(reconfigure).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ attempted: 1, succeeded: 1 });
  });

  it('fans out to dependents when a base plugin changes', async () => {
    const baseReconfigure = jest.fn();
    const dependentReconfigure = jest.fn();
    const base = stubPlugin({ name: 'base', reconfigure: baseReconfigure });
    const dependent = stubPlugin({ name: 'dep', requires: ['base'], reconfigure: dependentReconfigure });
    const manager = new PluginManager(makeFakeCrowi());
    loadPluginsInto(manager, [base, dependent]);

    const result = await manager.reconfigureAffected(['plugin:base']);

    expect(baseReconfigure).toHaveBeenCalledTimes(1);
    expect(dependentReconfigure).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ attempted: 2, succeeded: 2 });
  });

  it('fans out transitively (A requires B, B requires C; change to C reaches A)', async () => {
    const aReconfigure = jest.fn();
    const bReconfigure = jest.fn();
    const cReconfigure = jest.fn();
    const a = stubPlugin({ name: 'a', requires: ['b'], reconfigure: aReconfigure });
    const b = stubPlugin({ name: 'b', requires: ['c'], reconfigure: bReconfigure });
    const c = stubPlugin({ name: 'c', reconfigure: cReconfigure });
    const manager = new PluginManager(makeFakeCrowi());
    loadPluginsInto(manager, [a, b, c]);

    const result = await manager.reconfigureAffected(['plugin:c']);

    expect(cReconfigure).toHaveBeenCalledTimes(1);
    expect(bReconfigure).toHaveBeenCalledTimes(1);
    expect(aReconfigure).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ attempted: 3, succeeded: 3 });
  });

  it('handles a `requires` cycle without looping', async () => {
    const xReconfigure = jest.fn();
    const yReconfigure = jest.fn();
    // X and Y require each other (shouldn't happen in practice; the BFS
    // visited-guard makes it safe regardless).
    const x = stubPlugin({ name: 'x', requires: ['y'], reconfigure: xReconfigure });
    const y = stubPlugin({ name: 'y', requires: ['x'], reconfigure: yReconfigure });
    const manager = new PluginManager(makeFakeCrowi());
    loadPluginsInto(manager, [x, y]);

    const result = await manager.reconfigureAffected(['plugin:x']);

    expect(xReconfigure).toHaveBeenCalledTimes(1);
    expect(yReconfigure).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ attempted: 2, succeeded: 2 });
  });

  it('skips plugins without reconfigure (config-only base)', async () => {
    const dependentReconfigure = jest.fn();
    const base = stubPlugin({ name: 'aws' });
    const dependent = stubPlugin({ name: 's3', requires: ['aws'], reconfigure: dependentReconfigure });
    const manager = new PluginManager(makeFakeCrowi());
    loadPluginsInto(manager, [base, dependent]);

    const result = await manager.reconfigureAffected(['plugin:aws']);

    expect(dependentReconfigure).toHaveBeenCalledTimes(1);
    // Only `s3` was attempted; base has no reconfigure.
    expect(result).toEqual({ attempted: 1, succeeded: 1 });
  });

  it('returns succeeded < attempted when reconfigure throws', async () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failing = jest.fn(() => {
      throw new Error('boom');
    });
    const ok = jest.fn();
    const a = stubPlugin({ name: 'a', reconfigure: failing });
    const b = stubPlugin({ name: 'b', requires: ['a'], reconfigure: ok });
    const manager = new PluginManager(makeFakeCrowi());
    loadPluginsInto(manager, [a, b]);

    const result = await manager.reconfigureAffected(['plugin:a']);

    expect(failing).toHaveBeenCalled();
    expect(ok).toHaveBeenCalled();
    expect(result).toEqual({ attempted: 2, succeeded: 1 });
    consoleSpy.mockRestore();
  });

  it('ignores non-plugin namespaces', async () => {
    const reconfigure = jest.fn();
    const plugin = stubPlugin({ name: 'a', reconfigure });
    const manager = new PluginManager(makeFakeCrowi());
    loadPluginsInto(manager, [plugin]);

    const result = await manager.reconfigureAffected(['notification', 'security']);

    expect(reconfigure).not.toHaveBeenCalled();
    expect(result).toEqual({ attempted: 0, succeeded: 0 });
  });

  it("'*' fans out to all loaded plugins (used by remote pubsub fallback)", async () => {
    const aReconfigure = jest.fn();
    const bReconfigure = jest.fn();
    const a = stubPlugin({ name: 'a', reconfigure: aReconfigure });
    const b = stubPlugin({ name: 'b', reconfigure: bReconfigure });
    const manager = new PluginManager(makeFakeCrowi());
    loadPluginsInto(manager, [a, b]);

    const result = await manager.reconfigureAffected(['*']);

    expect(aReconfigure).toHaveBeenCalled();
    expect(bReconfigure).toHaveBeenCalled();
    expect(result).toEqual({ attempted: 2, succeeded: 2 });
  });
});

describe('PluginManager.activate — malformed @action boot warning (AC-6)', () => {
  afterEach(jest.restoreAllMocks);

  it('warns once when an @action field declares an unsupported verb (PUT)', async () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const configSchema = z
      .object({
        broken: z.string().describe('@action "Update resource" PUT /resource').default(''),
      })
      .strict();
    const plugin = stubPlugin({ name: '@crowi/plugin-broken-action', configSchema });
    const manager = new PluginManager(makeFakeCrowi());

    await activate(manager, plugin);

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const [message] = consoleSpy.mock.calls[0];
    expect(message).toContain('@crowi/plugin-broken-action');
    expect(message).toContain('broken');
    expect(message).toContain('@action annotation looks malformed');
  });

  it('does not warn for a well-formed @action field (GET/POST)', async () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const configSchema = z
      .object({
        manifest: z.string().describe('@action "Generate Slack App manifest" POST /manifest').default(''),
      })
      .strict();
    const plugin = stubPlugin({ name: '@crowi/plugin-ok-action', configSchema });
    const manager = new PluginManager(makeFakeCrowi());

    await activate(manager, plugin);

    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('does not warn for a plugin with no configSchema at all', async () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const plugin = stubPlugin({ name: '@crowi/plugin-no-schema' });
    const manager = new PluginManager(makeFakeCrowi());

    await activate(manager, plugin);

    expect(consoleSpy).not.toHaveBeenCalled();
  });
});

describe('PluginManager.activate — zod/v3 vs top-level zod (v4) configSchema guard', () => {
  it('activates normally when configSchema is built with zod/v3', async () => {
    const configSchema = z
      .object({
        apiKey: z.string().describe('@sensitive API key').default(''),
      })
      .strict();
    const plugin = stubPlugin({ name: '@crowi/plugin-v3-ok', configSchema });
    const manager = new PluginManager(makeFakeCrowi());

    await expect(activate(manager, plugin)).resolves.toBeUndefined();
  });

  it("throws a descriptive error when configSchema is built with the top-level 'zod' (v4) API", async () => {
    const configSchema = zV4.object({
      apiKey: zV4.string().describe('@sensitive API key').default(''),
    });
    // `CrowiPlugin.configSchema` is typed against zod/v3's `z.ZodObject`;
    // a v4 schema doesn't satisfy that type, matching the real-world
    // misuse this guard targets (a plugin author importing from the
    // wrong entry point). Cast through `unknown` to construct the fixture.
    const plugin = stubPlugin({ name: '@crowi/plugin-v4-mistake', configSchema: configSchema as unknown as CrowiPlugin['configSchema'] });
    const manager = new PluginManager(makeFakeCrowi());

    await expect(activate(manager, plugin)).rejects.toThrow(V4_MISTAKE_GUARD_ERROR);
  });

  it('activates normally when the plugin declares no configSchema', async () => {
    const plugin = stubPlugin({ name: '@crowi/plugin-no-schema-guard' });
    const manager = new PluginManager(makeFakeCrowi());

    await expect(activate(manager, plugin)).resolves.toBeUndefined();
  });
});

describe('PluginManager.bootstrap — configSchema guard runs before listSensitiveKeys() (boot order)', () => {
  // `bootstrap()` itself pulls in `@crowi/runner`'s real config/plugin
  // resolution, too heavy for these pure-function checks (same rationale
  // as the `activate()` helper above). `assertAllConfigSchemas()` is the
  // extracted step `bootstrap()` calls right after topo-sort and before
  // `registerSensitiveConfigKeys(this.listSensitiveKeys()...)` — these
  // tests exercise that step directly to prove every plugin's
  // `configSchema` is validated as a single up-front pass, not
  // interleaved with (or preceded by) any zod/v3-dependent introspection.
  it('does not throw when every plugin in the ordered list uses a zod/v3 configSchema', () => {
    const a = stubPlugin({
      name: '@crowi/plugin-a',
      configSchema: z.object({ apiKey: z.string().describe('@sensitive API key').default('') }).strict(),
    });
    const b = stubPlugin({ name: '@crowi/plugin-b', configSchema: z.object({ port: z.number().default(80) }).strict() });
    const manager = new PluginManager(makeFakeCrowi());

    expect(() => assertAllConfigSchemas(manager, [a, b])).not.toThrow();
  });

  it('throws for a v4-mistake plugin even when it is not first in the ordered list', () => {
    const ok = stubPlugin({ name: '@crowi/plugin-ok', configSchema: z.object({ port: z.number().default(80) }).strict() });
    const v4Schema = zV4.object({ apiKey: zV4.string().describe('@sensitive API key').default('') });
    const mistake = stubPlugin({ name: '@crowi/plugin-v4-mistake', configSchema: v4Schema as unknown as CrowiPlugin['configSchema'] });
    const manager = new PluginManager(makeFakeCrowi());

    // This is the boot-order regression this describe block guards: the
    // guard must catch the offending plugin here, in the up-front pass
    // `bootstrap()` runs before `listSensitiveKeys()`/`activate()` ever
    // see it — not only later, inside that plugin's own `activate()` call.
    expect(() => assertAllConfigSchemas(manager, [ok, mistake])).toThrow(V4_MISTAKE_GUARD_ERROR);
  });

  it('skips plugins without a configSchema', () => {
    const noSchema = stubPlugin({ name: '@crowi/plugin-no-schema' });
    const manager = new PluginManager(makeFakeCrowi());

    expect(() => assertAllConfigSchemas(manager, [noSchema])).not.toThrow();
  });
});

describe('PluginManager.activateAll — per-plugin activation isolation (feature-plugin-registration-isolation, AC-1–AC-4)', () => {
  afterEach(jest.restoreAllMocks);

  // Shared by AC-1/AC-2/AC-3 below, which each exercise a different facet
  // (side effects / getLoadedPlugins() / getFailedPlugins()) of the same
  // one-throws-in-the-middle scenario.
  function makeThreeWithSecondFailing(): { first: CrowiPlugin; second: CrowiPlugin; third: CrowiPlugin; manager: PluginManager } {
    const first = stubPlugin({ name: '@crowi/plugin-first', registerStorage: jest.fn() });
    const second = stubPlugin({
      name: '@crowi/plugin-second',
      registerStorage: () => {
        throw new Error('registerStorage exploded');
      },
    });
    const third = stubPlugin({ name: '@crowi/plugin-third', registerStorage: jest.fn() });
    return { first, second, third, manager: new PluginManager(makeFakeCrowi()) };
  }

  it('a throwing 2nd-of-3 activate() does not stop the other two from loading (AC-1)', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { first, second, third, manager } = makeThreeWithSecondFailing();

    await activateAll(manager, [first, second, third]);

    expect(first.registerStorage).toHaveBeenCalledTimes(1);
    expect(third.registerStorage).toHaveBeenCalledTimes(1);
  });

  it('excludes only the failed plugin from getLoadedPlugins()/getLoadedPlugin(), keeping the other two loaded (AC-2)', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { first, second, third, manager } = makeThreeWithSecondFailing();

    await activateAll(manager, [first, second, third]);

    expect(manager.getLoadedPlugins().map((p) => p.name)).toEqual(['@crowi/plugin-first', '@crowi/plugin-third']);
    expect(manager.getLoadedPlugin('@crowi/plugin-first')).toBe(first);
    expect(manager.getLoadedPlugin('@crowi/plugin-third')).toBe(third);
    expect(manager.getLoadedPlugin('@crowi/plugin-second')).toBeUndefined();
  });

  it('surfaces the failed plugin + its error message via getFailedPlugins() and excludes it from getLoadedPlugins() (AC-3)', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { first, second, third, manager } = makeThreeWithSecondFailing();

    await activateAll(manager, [first, second, third]);

    expect(manager.getFailedPlugins()).toEqual([{ plugin: second, error: 'registerStorage exploded' }]);
    expect(manager.getLoadedPlugins()).not.toContain(second);
  });

  it("logs '[crowi:plugin:<name>] activation failed; plugin disabled: <message>' on console.error (AC-4)", async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing = stubPlugin({
      name: '@crowi/plugin-boom',
      registerStorage: () => {
        throw new Error('kaboom');
      },
    });
    const manager = new PluginManager(makeFakeCrowi());

    await activateAll(manager, [failing]);

    expect(consoleSpy).toHaveBeenCalledWith('[crowi:plugin:@crowi/plugin-boom] activation failed; plugin disabled: kaboom');
  });

  it('stringifies a non-Error throw for the log message and getFailedPlugins() entry', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing = stubPlugin({
      name: '@crowi/plugin-string-throw',
      registerStorage: () => {
        // biome-ignore lint/style/useThrowOnlyError: exercising the `String(err)` fallback branch
        throw 'raw string boom';
      },
    });
    const manager = new PluginManager(makeFakeCrowi());

    await activateAll(manager, [failing]);

    expect(manager.getFailedPlugins()).toEqual([{ plugin: failing, error: 'raw string boom' }]);
    expect(consoleSpy).toHaveBeenCalledWith('[crowi:plugin:@crowi/plugin-string-throw] activation failed; plugin disabled: raw string boom');
  });

  it('activates every plugin normally when none throw (no false positives)', async () => {
    const a = stubPlugin({ name: '@crowi/plugin-a' });
    const b = stubPlugin({ name: '@crowi/plugin-b' });
    const manager = new PluginManager(makeFakeCrowi());

    await activateAll(manager, [a, b]);

    expect(manager.getLoadedPlugins().map((p) => p.name)).toEqual(['@crowi/plugin-a', '@crowi/plugin-b']);
    expect(manager.getFailedPlugins()).toEqual([]);
  });
});
