import type { CrowiPlugin } from '@crowi/plugin-api';
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
