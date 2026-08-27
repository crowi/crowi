import { createOAuth2Driver, createOidcDriver } from '@crowi/plugin-api';
import type { CrowiPlugin, PluginConfigVerificationResult } from '@crowi/plugin-api';
import { CrowiConfigFileSchema } from '@crowi/runner';
import { z } from 'zod/v3';
import { z as zV4 } from 'zod';
import { CREDENTIAL_VAULT_MODEL_NAMES } from './credential-vault-models';
import { PluginManager, type PluginRegistries } from './plugin-manager';
import { isPluginInstalled } from './plugin-install-tracker';

function makeFakeCrowi(): any {
  const fakeConfig = {
    onConfigChange: jest.fn(),
    crowi: {} as Record<string, unknown>,
  };
  return {
    getConfigService: () => fakeConfig,
    getConfig: () => ({ crowi: {} }),
    model: () => ({}),
    // `assertValidModelAccess()` reads `Object.keys(crowi.models)` as the
    // set of valid core model names (feature-plugin-capability-scoping) —
    // a subset of the real `packages/api/src/models/index.ts` registry is
    // enough for these tests.
    models: { Page: {}, User: {}, Revision: {}, Bookmark: {} },
    config: { crowi: {} },
    onConfigChangeMock: fakeConfig.onConfigChange,
  };
}

/**
 * Variant of `makeFakeCrowi()` with a real in-memory Config store
 * behind `getConfigService().saveConfigValue()` / `getConfig()`, so
 * writes made by one call are visible to reads made by a later call —
 * matching the real `ConfigService` (Mongo-backed, in-memory cache) it
 * stands in for. Needed only by the onInstall install-once tests
 * below: two `activate()` calls against the SAME fake crowi instance
 * simulate "boot N" then "boot N+1", with the store persisting across
 * them exactly like Mongo persists across real boots.
 */
function makeFakeCrowiWithConfigStore(): any {
  const store: Record<string, Record<string, unknown>> = {};
  const configService = {
    onConfigChange: jest.fn(),
    saveConfigValue: jest.fn(async (ns: string, key: string, value: unknown) => {
      store[ns] = { ...store[ns], [key]: value };
    }),
  };
  return {
    getConfigService: () => configService,
    getConfig: () => store,
    model: () => ({}),
  };
}

function stubPlugin(overrides: Partial<CrowiPlugin> & Pick<CrowiPlugin, 'name'>): CrowiPlugin {
  return {
    version: '0.0.0',
    ...overrides,
  } as CrowiPlugin;
}

/**
 * Variant of `makeFakeCrowi()` whose `getConfig()` returns a caller-supplied
 * `crowi` namespace object (feature-plugin-config-readiness). Used by the
 * `getReadinessIssues()` tests below, which read `plugin:<name>:<field>`
 * keys directly rather than going through `ConfigService.saveConfig`.
 */
function makeFakeCrowiWithNamespace(namespace: Record<string, unknown>): any {
  return {
    getConfigService: () => ({ onConfigChange: jest.fn() }),
    getConfig: () => ({ crowi: namespace }),
    model: () => ({}),
    models: { Page: {}, User: {}, Revision: {}, Bookmark: {} },
  };
}

/**
 * `selectedDrivers` is private and normally set by `bootstrap()` (which
 * reads a real `crowi.config.json`) — bypass it directly, same rationale
 * as `loadPluginsInto()` above. Unspecified registries default to the
 * real `CrowiConfigFileSchema` defaults so a test only has to name the
 * registry it cares about.
 */
function withSelectedDrivers(manager: PluginManager, drivers: Partial<Record<'storage' | 'search' | 'mail', string>>): void {
  // biome-ignore lint/suspicious/noExplicitAny: test access to private field
  (manager as any).selectedDrivers = { storage: 'local', search: 'mongo', mail: 'smtp', ...drivers };
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

// `resolveActiveDrivers()` is private — the step `bootstrap()` runs after
// `activateAll()` to build the `active.*` slots it returns. Invoke it
// directly (same rationale as `activate()` above) against the real
// `CrowiConfigFileSchema` defaults, since `feature-auth-google-phase0-sdk-identity`
// AC-7 only cares about the `auth` slot.
function resolveActiveDrivers(manager: PluginManager): PluginRegistries['active'] {
  // biome-ignore lint/suspicious/noExplicitAny: test access to private fields
  return (manager as any).resolveActiveDrivers(CrowiConfigFileSchema.parse({}));
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

/**
 * feature-config-reconciliation-safety §3 — `ConfigService.saveConfig`'s
 * failure-path reconciliation now notifies local listeners tagged
 * `'remote'`, not `'local'`, because nobody else is going to call
 * `reconfigureAffected` for a write that never returned successfully.
 * `handleConfigChange`'s own gate is unchanged; these pin the contract
 * between the two rather than any new branching here.
 */
describe('PluginManager.handleConfigChange (feature-config-reconciliation-safety)', () => {
  it("AC-8: reconfigures on a 'remote'-tagged notification — the shape ConfigService's failed-write recovery path now uses", async () => {
    const reconfigure = jest.fn();
    const plugin = stubPlugin({ name: 'a', reconfigure });
    const manager = new PluginManager(makeFakeCrowi());
    loadPluginsInto(manager, [plugin]);

    // biome-ignore lint/suspicious/noExplicitAny: test access to private method
    await (manager as any).handleConfigChange(['plugin:a'], 'remote');

    expect(reconfigure).toHaveBeenCalledTimes(1);
  });

  it("AC-10: does not reconfigure on a 'local'-tagged notification — the admin handler calls reconfigureAffected itself on that path, and firing here too would double-fire", async () => {
    const reconfigure = jest.fn();
    const plugin = stubPlugin({ name: 'a', reconfigure });
    const manager = new PluginManager(makeFakeCrowi());
    loadPluginsInto(manager, [plugin]);

    // biome-ignore lint/suspicious/noExplicitAny: test access to private method
    await (manager as any).handleConfigChange(['plugin:a'], 'local');

    expect(reconfigure).not.toHaveBeenCalled();
  });
});

describe('PluginManager.createVerificationPlan / verifyAffectedConfig (feature-plugin-config-live-verification)', () => {
  const AwsConfigSchema = z.object({ region: z.string().default('') }).strict();
  const S3ConfigSchema = z.object({ bucket: z.string().default('') }).strict();

  function makeAwsPlugin(overrides: Partial<CrowiPlugin> = {}): CrowiPlugin {
    return stubPlugin({ name: 'aws', configSchema: AwsConfigSchema, exposesConfigToDependents: true, ...overrides });
  }

  it('AC-1: a plugin with no verifyConfig produces no plan entry and no outcome', async () => {
    const noHook = stubPlugin({ name: 'no-hook' });
    const manager = new PluginManager(makeFakeCrowiWithNamespace({}));
    loadPluginsInto(manager, [noHook]);

    const plan = manager.createVerificationPlan(['plugin:no-hook'], {});
    expect(plan.entries).toHaveLength(0);

    const outcomes = await manager.verifyAffectedConfig(plan);
    expect(outcomes).toEqual([]);
  });

  it('AC-1: a hook-declaring plugin with no override reads its live-cache config through the snapshot', async () => {
    const verifyConfig = jest.fn(async (snapshot) => {
      expect(snapshot.config()).toEqual({ bucket: 'stored-bucket' });
      return { status: 'ok' } satisfies PluginConfigVerificationResult;
    });
    const plugin = stubPlugin({ name: 's3', configSchema: S3ConfigSchema, verifyConfig });
    const manager = new PluginManager(makeFakeCrowiWithNamespace({ 'plugin:s3:bucket': 'stored-bucket' }));
    loadPluginsInto(manager, [plugin]);

    const plan = manager.createVerificationPlan(['plugin:s3'], {});
    const outcomes = await manager.verifyAffectedConfig(plan);

    expect(verifyConfig).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual([{ pluginName: 's3', result: { status: 'ok' } }]);
  });

  it('AC-2: fan-out reaches the changed plugin and its transitive dependent, and results are ordered by loadedPlugins topo order regardless of hook resolution order', async () => {
    const order: string[] = [];
    let releaseSlow: (() => void) | undefined;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    // Loaded in topo order: `aws` (no requires) before `s3` (requires aws)
    // — `loadPluginsInto` sets `loadedPlugins` verbatim (no re-sort), so
    // this array order IS the order results must come back in.
    const aws = makeAwsPlugin({
      verifyConfig: async () => {
        await slowGate; // resolves LAST, deliberately
        order.push('aws');
        return { status: 'ok' };
      },
    });
    const s3 = stubPlugin({
      name: 's3',
      requires: ['aws'],
      configSchema: S3ConfigSchema,
      verifyConfig: async () => {
        order.push('s3'); // resolves FIRST
        return { status: 'ok' };
      },
    });
    const manager = new PluginManager(makeFakeCrowiWithNamespace({ 'plugin:aws:region': 'r1' }));
    loadPluginsInto(manager, [aws, s3]);

    const plan = manager.createVerificationPlan(['plugin:aws'], {});
    const outcomesPromise = manager.verifyAffectedConfig(plan);

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['s3']); // s3's hook already resolved; aws's is still gated

    releaseSlow?.();
    const outcomes = await outcomesPromise;

    expect(order).toEqual(['s3', 'aws']); // confirms s3 really did resolve first
    // ...yet the RESULTS are in loadedPlugins order (aws, s3), not resolution order.
    expect(outcomes.map((o) => o.pluginName)).toEqual(['aws', 's3']);
  });

  it("AC-2: a plan freezes both the changed plugin's override and its dependency values at creation time — a cache write made after the plan exists never leaks in", async () => {
    const seenBucket: unknown[] = [];
    const seenRegion: unknown[] = [];
    const s3 = stubPlugin({
      name: 's3',
      requires: ['aws'],
      configSchema: S3ConfigSchema,
      verifyConfig: async (snapshot) => {
        seenBucket.push(snapshot.config<{ bucket: string }>().bucket);
        seenRegion.push(snapshot.dependencyConfig<{ region: string }>('aws').region);
        return { status: 'ok' };
      },
    });
    const aws = makeAwsPlugin();
    const namespace: Record<string, unknown> = { 'plugin:aws:region': 'region-1' };
    const manager = new PluginManager(makeFakeCrowiWithNamespace(namespace));
    loadPluginsInto(manager, [aws, s3]);

    // Request A: s3 is being saved with bucket='bucket-A'.
    const planA = manager.createVerificationPlan(['plugin:s3'], { s3: { bucket: 'bucket-A' } });

    // A second, later admin save lands before A's plan is executed: aws's
    // region changes AND s3's stored bucket changes too (as if a request B
    // had already persisted bucket='bucket-B').
    namespace['plugin:aws:region'] = 'region-2';
    namespace['plugin:s3:bucket'] = 'bucket-B';

    await manager.verifyAffectedConfig(planA);

    expect(seenBucket).toEqual(['bucket-A']);
    expect(seenRegion).toEqual(['region-1']);
  });

  it('AC-2: snapshot.dependencyConfig() throws the same capability-check errors as PluginContext.dependencyConfig()', async () => {
    const closedDep = stubPlugin({ name: 'closed', configSchema: z.object({ secret: z.string().default('') }).strict() }); // no exposesConfigToDependents
    const caught: Record<string, unknown> = {};
    const main = stubPlugin({
      name: 'reader',
      requires: ['closed'],
      configSchema: S3ConfigSchema,
      verifyConfig: async (snapshot) => {
        try {
          snapshot.dependencyConfig('closed');
        } catch (err) {
          caught.notExposed = err;
        }
        try {
          snapshot.dependencyConfig('never-required');
        } catch (err) {
          caught.notRequired = err;
        }
        return { status: 'ok' };
      },
    });
    const manager = new PluginManager(makeFakeCrowiWithNamespace({}));
    loadPluginsInto(manager, [closedDep, main]);

    const plan = manager.createVerificationPlan(['plugin:reader'], {});
    await manager.verifyAffectedConfig(plan);

    expect((caught.notExposed as Error).message).toContain("did not declare 'exposesConfigToDependents'");
    expect((caught.notRequired as Error).message).toContain("did not list it in 'requires'");
  });

  it("AC-1/AC-4: a hook-declaring plugin whose OWN stored config fails schema parsing is skipped — hook never called, reported as 'unknown'", async () => {
    const verifyConfig = jest.fn(async () => ({ status: 'ok' }) satisfies PluginConfigVerificationResult);
    const plugin = stubPlugin({ name: 'broken-own', configSchema: z.object({ n: z.number() }).strict(), verifyConfig });
    // Stored value is the wrong type -> safeParse fails.
    const manager = new PluginManager(makeFakeCrowiWithNamespace({ 'plugin:broken-own:n': 'not-a-number' }));
    loadPluginsInto(manager, [plugin]);

    const plan = manager.createVerificationPlan(['plugin:broken-own'], {});
    const outcomes = await manager.verifyAffectedConfig(plan);

    expect(verifyConfig).not.toHaveBeenCalled();
    expect(outcomes).toEqual([{ pluginName: 'broken-own', result: { status: 'failed', reason: 'unknown' } }]);
  });

  it('AC-2/AC-4: a hook-declaring plugin whose DEPENDENCY config fails schema parsing is also skipped, even though its own config parses fine', async () => {
    const verifyConfig = jest.fn(async () => ({ status: 'ok' }) satisfies PluginConfigVerificationResult);
    const dep = makeAwsPlugin();
    const main = stubPlugin({ name: 'dependent', requires: ['aws'], configSchema: S3ConfigSchema, verifyConfig });
    // Wrong type for aws.region -> safeParse fails for the dependency.
    const manager = new PluginManager(makeFakeCrowiWithNamespace({ 'plugin:aws:region': 12345 }));
    loadPluginsInto(manager, [dep, main]);

    const plan = manager.createVerificationPlan(['plugin:dependent'], {});
    const outcomes = await manager.verifyAffectedConfig(plan);

    expect(verifyConfig).not.toHaveBeenCalled();
    expect(outcomes).toEqual([{ pluginName: 'dependent', result: { status: 'failed', reason: 'unknown' } }]);
  });

  it('AC-1/AC-4: a hook-declaring plugin whose OWN configSchema.safeParse THROWS (not just returns !success — a transform/refine callback is ordinary user code, not guaranteed to only ever return/reject cleanly) is skipped without escaping plan creation, never turning an optional feature into a 500 on the triggering save', async () => {
    const verifyConfig = jest.fn(async () => ({ status: 'ok' }) satisfies PluginConfigVerificationResult);
    const throwingSchema = {
      safeParse: () => {
        throw new Error('transform blew up');
      },
    } as unknown as CrowiPlugin['configSchema'];
    const plugin = stubPlugin({ name: 'throws-on-parse', configSchema: throwingSchema, verifyConfig });
    const manager = new PluginManager(makeFakeCrowiWithNamespace({ 'plugin:throws-on-parse:n': 1 }));
    loadPluginsInto(manager, [plugin]);

    let plan: ReturnType<typeof manager.createVerificationPlan> | undefined;
    expect(() => {
      plan = manager.createVerificationPlan(['plugin:throws-on-parse'], {});
    }).not.toThrow();
    const outcomes = await manager.verifyAffectedConfig(plan!);

    expect(verifyConfig).not.toHaveBeenCalled();
    expect(outcomes).toEqual([{ pluginName: 'throws-on-parse', result: { status: 'failed', reason: 'unknown' } }]);
  });

  it('AC-1/AC-4: an override value structuredClone cannot clone (e.g. a function) is also skipped rather than throwing out of plan creation — covers the override path, which bypasses safeParse entirely and hits deep-freeze-clone directly', async () => {
    const verifyConfig = jest.fn(async () => ({ status: 'ok' }) satisfies PluginConfigVerificationResult);
    const plugin = stubPlugin({ name: 'uncloneable', configSchema: S3ConfigSchema, verifyConfig });
    const manager = new PluginManager(makeFakeCrowiWithNamespace({}));
    loadPluginsInto(manager, [plugin]);

    let plan: ReturnType<typeof manager.createVerificationPlan> | undefined;
    expect(() => {
      plan = manager.createVerificationPlan(['plugin:uncloneable'], { uncloneable: { bucket: (() => 'not-cloneable') as unknown as string } });
    }).not.toThrow();
    const outcomes = await manager.verifyAffectedConfig(plan!);

    expect(verifyConfig).not.toHaveBeenCalled();
    expect(outcomes).toEqual([{ pluginName: 'uncloneable', result: { status: 'failed', reason: 'unknown' } }]);
  });

  it('AC-4: a hook that never resolves within the timeout normalizes to unreachable', async () => {
    const plugin = stubPlugin({
      name: 'slow',
      configSchema: z.object({}).strict(),
      verifyConfig: () => new Promise<PluginConfigVerificationResult>(() => {}),
    });
    const manager = new PluginManager(makeFakeCrowiWithNamespace({}));
    loadPluginsInto(manager, [plugin]);
    // biome-ignore lint/suspicious/noExplicitAny: test access to a private field, same pattern as `selectedDrivers` above
    (manager as any).verificationTimeoutMs = 10;

    const plan = manager.createVerificationPlan(['plugin:slow'], {});
    const outcomes = await manager.verifyAffectedConfig(plan);

    expect(outcomes).toEqual([{ pluginName: 'slow', result: { status: 'failed', reason: 'unreachable' } }]);
  });

  it('AC-4: a hook that throws synchronously normalizes to unknown', async () => {
    const plugin = stubPlugin({
      name: 'throws-sync',
      configSchema: z.object({}).strict(),
      verifyConfig: () => {
        throw new Error('boom');
      },
    });
    const manager = new PluginManager(makeFakeCrowiWithNamespace({}));
    loadPluginsInto(manager, [plugin]);

    const plan = manager.createVerificationPlan(['plugin:throws-sync'], {});
    const outcomes = await manager.verifyAffectedConfig(plan);

    expect(outcomes).toEqual([{ pluginName: 'throws-sync', result: { status: 'failed', reason: 'unknown' } }]);
  });

  it('AC-4: a rejected hook promise normalizes to unknown', async () => {
    const plugin = stubPlugin({
      name: 'rejects',
      configSchema: z.object({}).strict(),
      verifyConfig: async () => {
        throw new Error('boom');
      },
    });
    const manager = new PluginManager(makeFakeCrowiWithNamespace({}));
    loadPluginsInto(manager, [plugin]);

    const plan = manager.createVerificationPlan(['plugin:rejects'], {});
    const outcomes = await manager.verifyAffectedConfig(plan);

    expect(outcomes).toEqual([{ pluginName: 'rejects', result: { status: 'failed', reason: 'unknown' } }]);
  });

  it('AC-4: a malformed (non-object) result normalizes to unknown', async () => {
    const plugin = stubPlugin({
      name: 'malformed',
      configSchema: z.object({}).strict(),
      verifyConfig: async () => 'not-an-object' as unknown as PluginConfigVerificationResult,
    });
    const manager = new PluginManager(makeFakeCrowiWithNamespace({}));
    loadPluginsInto(manager, [plugin]);

    const plan = manager.createVerificationPlan(['plugin:malformed'], {});
    const outcomes = await manager.verifyAffectedConfig(plan);

    expect(outcomes).toEqual([{ pluginName: 'malformed', result: { status: 'failed', reason: 'unknown' } }]);
  });

  it("AC-4: an unrecognized `reason` on a failed result normalizes to 'unknown'", async () => {
    const plugin = stubPlugin({
      name: 'bogus-reason',
      configSchema: z.object({}).strict(),
      verifyConfig: async () => ({ status: 'failed', reason: 'totally-made-up' }) as unknown as PluginConfigVerificationResult,
    });
    const manager = new PluginManager(makeFakeCrowiWithNamespace({}));
    loadPluginsInto(manager, [plugin]);

    const plan = manager.createVerificationPlan(['plugin:bogus-reason'], {});
    const outcomes = await manager.verifyAffectedConfig(plan);

    expect(outcomes).toEqual([{ pluginName: 'bogus-reason', result: { status: 'failed', reason: 'unknown' } }]);
  });

  it('AC-4: a result whose `status` getter throws on access normalizes to unknown instead of rejecting verifyAffectedConfig', async () => {
    const throwingResult = new Proxy(
      {},
      {
        get() {
          throw new Error('getter exploded');
        },
      },
    );
    const plugin = stubPlugin({
      name: 'throwing-getter',
      configSchema: z.object({}).strict(),
      verifyConfig: async () => throwingResult as unknown as PluginConfigVerificationResult,
    });
    const manager = new PluginManager(makeFakeCrowiWithNamespace({}));
    loadPluginsInto(manager, [plugin]);

    const plan = manager.createVerificationPlan(['plugin:throwing-getter'], {});

    await expect(manager.verifyAffectedConfig(plan)).resolves.toEqual([{ pluginName: 'throwing-getter', result: { status: 'failed', reason: 'unknown' } }]);
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

describe('PluginManager.activate — modelAccess allow-list boot validation (feature-plugin-capability-scoping)', () => {
  it('activates normally when every declared modelAccess name is a registered core model', async () => {
    const plugin = stubPlugin({ name: '@crowi/plugin-model-ok', modelAccess: ['Page', 'Bookmark'] });
    const manager = new PluginManager(makeFakeCrowi());

    await expect(activate(manager, plugin)).resolves.toBeUndefined();
  });

  it("throws a descriptive error naming the plugin and the unknown model when modelAccess declares a name that isn't a registered core model", async () => {
    const plugin = stubPlugin({ name: '@crowi/plugin-model-typo', modelAccess: ['Page', 'Pages'] });
    const manager = new PluginManager(makeFakeCrowi());

    await expect(activate(manager, plugin)).rejects.toThrow(
      "Plugin '@crowi/plugin-model-typo' declares modelAccess including 'Pages', which is not a registered core model.",
    );
  });

  it('activates normally when the plugin declares no modelAccess at all', async () => {
    const plugin = stubPlugin({ name: '@crowi/plugin-no-model-access' });
    const manager = new PluginManager(makeFakeCrowi());

    await expect(activate(manager, plugin)).resolves.toBeUndefined();
  });

  it('activates normally when modelAccess is an empty array', async () => {
    const plugin = stubPlugin({ name: '@crowi/plugin-empty-model-access', modelAccess: [] });
    const manager = new PluginManager(makeFakeCrowi());

    await expect(activate(manager, plugin)).resolves.toBeUndefined();
  });

  it('a plugin whose modelAccess names an unknown model is isolated by activateAll() like a bad configSchema, without stopping other plugins', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const ok = stubPlugin({ name: '@crowi/plugin-model-ok-2', registerStorage: jest.fn() });
    const bad = stubPlugin({ name: '@crowi/plugin-model-bad', modelAccess: ['NotAModel'] });
    const manager = new PluginManager(makeFakeCrowi());

    await activateAll(manager, [ok, bad]);

    expect(manager.getLoadedPlugins().map((p) => p.name)).toEqual(['@crowi/plugin-model-ok-2']);
    expect(manager.getFailedPlugins()).toEqual([
      {
        plugin: bad,
        error:
          "Plugin '@crowi/plugin-model-bad' declares modelAccess including 'NotAModel', which is not a registered core model. Valid model names: Page, User, Revision, Bookmark.",
      },
    ]);
  });
});

describe('PluginManager.activate — credential-vault deny-list boot validation (feature-plugin-capability-hardening)', () => {
  it("throws a descriptive error naming the plugin and 'credential-bearing core models' when modelAccess declares a deny-listed model", async () => {
    const plugin = stubPlugin({ name: '@crowi/plugin-vault-grab', modelAccess: ['Config'] });
    const manager = new PluginManager(makeFakeCrowi());

    await expect(activate(manager, plugin)).rejects.toThrow(
      "Plugin '@crowi/plugin-vault-grab' declares modelAccess including 'Config', but credential-bearing core models cannot be granted to plugins.",
    );
  });

  it.each([...CREDENTIAL_VAULT_MODEL_NAMES])("rejects '%s' regardless of whatever else is declared alongside it", async (deniedModel) => {
    const plugin = stubPlugin({ name: '@crowi/plugin-vault-grab-2', modelAccess: ['Page', deniedModel] });
    const manager = new PluginManager(makeFakeCrowi());

    await expect(activate(manager, plugin)).rejects.toThrow('credential-bearing core models cannot be granted to plugins');
  });

  it('activates normally when modelAccess only declares non-denied models (e.g. Page)', async () => {
    const plugin = stubPlugin({ name: '@crowi/plugin-vault-safe', modelAccess: ['Page', 'Bookmark'] });
    const manager = new PluginManager(makeFakeCrowi());

    await expect(activate(manager, plugin)).resolves.toBeUndefined();
  });

  it('a plugin declaring a deny-listed model is isolated by activateAll() without stopping other plugins', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const ok = stubPlugin({ name: '@crowi/plugin-vault-ok', registerStorage: jest.fn() });
    const bad = stubPlugin({ name: '@crowi/plugin-vault-bad', modelAccess: ['PersonalAccessToken'] });
    const manager = new PluginManager(makeFakeCrowi());

    await activateAll(manager, [ok, bad]);

    expect(manager.getLoadedPlugins().map((p) => p.name)).toEqual(['@crowi/plugin-vault-ok']);
    expect(manager.getFailedPlugins()).toEqual([
      {
        plugin: bad,
        error:
          "Plugin '@crowi/plugin-vault-bad' declares modelAccess including 'PersonalAccessToken', but credential-bearing core models cannot be granted to plugins. Denied models: Config, OAuthAuthorizationCode, OAuthClient, OAuthDeviceCode, OAuthRefreshToken, PersonalAccessToken, Share, ShareAccess.",
      },
    ]);
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

describe('PluginManager.listSensitiveKeys (feature-storage-gcs AC-2 — shared marker traversal with schema-serializer.ts)', () => {
  it('registers the atomic GROUP physical key, not the flat field key, when the sensitive member is behind an intermediate ZodEffects @sensitive marker', () => {
    const plugin = stubPlugin({
      name: '@crowi/plugin-storage-gcs',
      configSchema: z
        .object({
          bucket: z.string().default(''),
          serviceAccountKey: z
            .string()
            .superRefine(() => undefined)
            .describe('@sensitive Google Cloud service-account key JSON')
            .default(''),
        })
        .strict(),
      configAtomicGroups: [{ name: 'gcsConnection', keys: ['bucket', 'serviceAccountKey'], sensitive: true }],
    });
    const manager = new PluginManager(makeFakeCrowi());
    loadPluginsInto(manager, [plugin]);

    const keys = manager.listSensitiveKeys();

    expect(keys).toContain('plugin:@crowi/plugin-storage-gcs:__atomic:gcsConnection');
    expect(keys).not.toContain('plugin:@crowi/plugin-storage-gcs:serviceAccountKey');
    expect(keys).not.toContain('plugin:@crowi/plugin-storage-gcs:bucket');
  });

  it('registers a flat (non-grouped) field key when its @sensitive marker sits on an intermediate ZodEffects wrapper', () => {
    const plugin = stubPlugin({
      name: '@crowi/plugin-x',
      configSchema: z
        .object({
          apiKey: z
            .string()
            .superRefine(() => undefined)
            .describe('@sensitive API key')
            .default(''),
        })
        .strict(),
    });
    const manager = new PluginManager(makeFakeCrowi());
    loadPluginsInto(manager, [plugin]);

    expect(manager.listSensitiveKeys()).toEqual(['plugin:@crowi/plugin-x:apiKey']);
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

describe('PluginManager.getOrCreateStateCell (feature-plugin-state-cell-primitive, AC-2)', () => {
  it('returns the same cell for repeated calls with the same plugin name', () => {
    const manager = new PluginManager(makeFakeCrowi());

    const first = manager.getOrCreateStateCell('@crowi/plugin-a', { n: 1 });
    const second = manager.getOrCreateStateCell('@crowi/plugin-a', { n: 999 });

    expect(second).toBe(first);
  });

  it('ignores `initial` on the second call — the cell still holds the value from the first call', () => {
    const manager = new PluginManager(makeFakeCrowi());

    const first = manager.getOrCreateStateCell('@crowi/plugin-a', { n: 1 });
    manager.getOrCreateStateCell('@crowi/plugin-a', { n: 999 });

    expect(first.get()).toEqual({ n: 1 });
  });

  it('gives different plugins independent cells', () => {
    const manager = new PluginManager(makeFakeCrowi());

    const a = manager.getOrCreateStateCell('@crowi/plugin-a', { n: 1 });
    const b = manager.getOrCreateStateCell('@crowi/plugin-b', { n: 2 });

    expect(a).not.toBe(b);
    expect(a.get()).toEqual({ n: 1 });
    expect(b.get()).toEqual({ n: 2 });
  });

  it('a value written via set() on one lookup is visible through a cell obtained from a later lookup call (activation ctx vs. reconfigure ctx)', () => {
    const manager = new PluginManager(makeFakeCrowi());

    const activationCell = manager.getOrCreateStateCell('@crowi/plugin-a', { n: 1 });
    activationCell.set({ n: 2 });

    const reconfigureCell = manager.getOrCreateStateCell('@crowi/plugin-a', { n: 1 });

    expect(reconfigureCell.get()).toEqual({ n: 2 });
  });
});

describe('PluginManager.activate — onInstall install-once idempotency (feature-plugin-oninstall-idempotency, AC-1–AC-4)', () => {
  it('calls onInstall on the first boot and persists an install record (AC-1, AC-2)', async () => {
    const onInstall = jest.fn().mockResolvedValue(undefined);
    const plugin = stubPlugin({ name: '@crowi/plugin-installable', onInstall });
    const fakeCrowi = makeFakeCrowiWithConfigStore();
    const manager = new PluginManager(fakeCrowi);

    await activate(manager, plugin);

    expect(onInstall).toHaveBeenCalledTimes(1);
    expect(fakeCrowi.getConfigService().saveConfigValue).toHaveBeenCalledWith('plugin-installed', '@crowi/plugin-installable', expect.any(String));
    expect(isPluginInstalled(fakeCrowi, '@crowi/plugin-installable')).toBe(true);
  });

  it('does not call onInstall again on a second boot simulation, given the record from the first (AC-1, AC-5)', async () => {
    const onInstall = jest.fn().mockResolvedValue(undefined);
    const plugin = stubPlugin({ name: '@crowi/plugin-installable', onInstall });
    const fakeCrowi = makeFakeCrowiWithConfigStore();
    const manager = new PluginManager(fakeCrowi);

    // "boot 1"
    await activate(manager, plugin);
    // "boot 2" — same fake crowi instance, so the install record from
    // boot 1 persists exactly like it would across a real Mongo-backed
    // restart (also covers AC-5: the record is keyed by plugin name,
    // not tied to any particular boot's `ordered` list membership).
    await activate(manager, plugin);

    expect(onInstall).toHaveBeenCalledTimes(1);
  });

  it('does not persist an install record when onInstall throws, and retries it on the next boot (AC-3)', async () => {
    const onInstall = jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined);
    const plugin = stubPlugin({ name: '@crowi/plugin-flaky-install', onInstall });
    const fakeCrowi = makeFakeCrowiWithConfigStore();
    const manager = new PluginManager(fakeCrowi);

    // "boot 1" — onInstall throws, so no record is written.
    await expect(activate(manager, plugin)).rejects.toThrow('boom');
    expect(isPluginInstalled(fakeCrowi, '@crowi/plugin-flaky-install')).toBe(false);

    // "boot 2" — onInstall is retried because no record exists yet.
    await activate(manager, plugin);

    expect(onInstall).toHaveBeenCalledTimes(2);
    expect(isPluginInstalled(fakeCrowi, '@crowi/plugin-flaky-install')).toBe(true);
  });

  it('never reads or writes the install-tracking record for a plugin with no onInstall (AC-4)', async () => {
    const plugin = stubPlugin({ name: '@crowi/plugin-no-install' });
    const fakeCrowi = makeFakeCrowiWithConfigStore();
    const getConfigSpy = jest.spyOn(fakeCrowi, 'getConfig');
    const manager = new PluginManager(fakeCrowi);

    await activate(manager, plugin);

    expect(fakeCrowi.getConfigService().saveConfigValue).not.toHaveBeenCalled();
    expect(getConfigSpy).not.toHaveBeenCalled();
  });
});

describe('PluginManager.getReadinessIssues (feature-plugin-config-readiness)', () => {
  it('AC-1: returns an issue only for the readiness-declaring plugin whose driver matches the selected one; unselected drivers, no-readiness plugins, and undeclared AWS credential fields are excluded', () => {
    const namespace: Record<string, unknown> = {
      'plugin:@crowi/plugin-storage-aws-s3:bucket': '',
      // AWS credentials have no readiness declaration at all (empty is a
      // legitimate "use the SDK default credential chain" config) — even
      // though they're empty here too, they must never surface as an issue.
      'plugin:@crowi/plugin-aws:accessKeyId': '',
      'plugin:@crowi/plugin-aws:secretAccessKey': '',
      // core mail:from is set here so this test stays scoped to the
      // plugin-only assertion — see the core-declaration describe block
      // below for `mail:from` coverage.
      'mail:from': 'noreply@example.com',
    };
    const s3 = stubPlugin({
      name: '@crowi/plugin-storage-aws-s3',
      readiness: { registry: 'storage', driver: 's3', requiredConfigFields: ['bucket'] },
    });
    const aws = stubPlugin({ name: '@crowi/plugin-aws' });
    const unselectedDriver = stubPlugin({
      name: '@crowi/plugin-storage-other',
      readiness: { registry: 'storage', driver: 'other', requiredConfigFields: ['token'] },
    });
    const noReadiness = stubPlugin({ name: '@crowi/plugin-no-readiness' });

    const manager = new PluginManager(makeFakeCrowiWithNamespace(namespace));
    loadPluginsInto(manager, [s3, aws, unselectedDriver, noReadiness]);
    withSelectedDrivers(manager, { storage: 's3' });

    expect(manager.getReadinessIssues()).toEqual([
      {
        source: 'plugin',
        id: 'plugin:@crowi/plugin-storage-aws-s3',
        pluginName: '@crowi/plugin-storage-aws-s3',
        fields: [{ name: 'bucket', configured: false }],
      },
    ]);
  });

  it('returns no issue once the required field has a non-empty value', () => {
    const namespace: Record<string, unknown> = { 'plugin:@crowi/plugin-storage-aws-s3:bucket': 'my-real-bucket', 'mail:from': 'noreply@example.com' };
    const s3 = stubPlugin({
      name: '@crowi/plugin-storage-aws-s3',
      readiness: { registry: 'storage', driver: 's3', requiredConfigFields: ['bucket'] },
    });
    const manager = new PluginManager(makeFakeCrowiWithNamespace(namespace));
    loadPluginsInto(manager, [s3]);
    withSelectedDrivers(manager, { storage: 's3' });

    expect(manager.getReadinessIssues()).toEqual([]);
  });

  it("AC-3: reports the selected search driver's unset url even though its own registerSearch skipped registry.register() at boot (empty url)", () => {
    const namespace: Record<string, unknown> = { 'plugin:@crowi/plugin-search-elasticsearch:url': '', 'mail:from': 'noreply@example.com' };
    // The real elasticsearch/opensearch plugins stay in `loadedPlugins`
    // (activate() succeeds) even when `registerSearch` returns early on an
    // empty url — only `registry.register()` is skipped. `loadPluginsInto`
    // mirrors that: the plugin is loaded regardless of registry state.
    const es = stubPlugin({
      name: '@crowi/plugin-search-elasticsearch',
      readiness: { registry: 'search', driver: 'elasticsearch', requiredConfigFields: ['url'] },
    });
    const manager = new PluginManager(makeFakeCrowiWithNamespace(namespace));
    loadPluginsInto(manager, [es]);
    withSelectedDrivers(manager, { search: 'elasticsearch' });

    expect(manager.getReadinessIssues()).toEqual([
      {
        source: 'plugin',
        id: 'plugin:@crowi/plugin-search-elasticsearch',
        pluginName: '@crowi/plugin-search-elasticsearch',
        fields: [{ name: 'url', configured: false }],
      },
    ]);
  });

  it('AC-3: excludes the issue when a different search driver is selected', () => {
    const namespace: Record<string, unknown> = { 'plugin:@crowi/plugin-search-elasticsearch:url': '', 'mail:from': 'noreply@example.com' };
    const es = stubPlugin({
      name: '@crowi/plugin-search-elasticsearch',
      readiness: { registry: 'search', driver: 'elasticsearch', requiredConfigFields: ['url'] },
    });
    const manager = new PluginManager(makeFakeCrowiWithNamespace(namespace));
    loadPluginsInto(manager, [es]);
    withSelectedDrivers(manager, { search: 'opensearch' });

    expect(manager.getReadinessIssues()).toEqual([]);
  });

  it('returns an empty array when no plugin is loaded and mail:from is set (no core issue either)', () => {
    const manager = new PluginManager(makeFakeCrowiWithNamespace({ 'mail:from': 'noreply@example.com' }));
    expect(manager.getReadinessIssues()).toEqual([]);
  });

  it('every field result carries only name + configured — never the actual value', () => {
    const namespace: Record<string, unknown> = { 'plugin:@crowi/plugin-search-elasticsearch:url': '', 'mail:from': 'noreply@example.com' };
    const es = stubPlugin({
      name: '@crowi/plugin-search-elasticsearch',
      readiness: { registry: 'search', driver: 'elasticsearch', requiredConfigFields: ['url'] },
    });
    const manager = new PluginManager(makeFakeCrowiWithNamespace(namespace));
    loadPluginsInto(manager, [es]);
    withSelectedDrivers(manager, { search: 'elasticsearch' });

    const [issue] = manager.getReadinessIssues();
    expect(Object.keys(issue.fields[0])).toEqual(['name', 'configured']);
    expect(issue.fields[0].configured).toBe(false);
  });
});

describe('PluginManager.resolveActiveDrivers — auth stays unfiltered by config (feature-auth-google-phase0-sdk-identity AC-7)', () => {
  it('keeps an unconfigured OAuth2 driver in active.auth and never calls getClientConfig() during bootstrap', async () => {
    const getClientConfig = jest.fn(() => null);
    const fetchProfile = jest.fn();
    const plugin = stubPlugin({
      name: '@crowi/plugin-example-oauth2',
      registerAuth: (registry) => {
        registry.register(
          'example-oauth2',
          createOAuth2Driver({
            buttonLabel: 'Example',
            authorizeUrl: 'https://idp.example.com/authorize',
            tokenUrl: 'https://idp.example.com/token',
            getClientConfig,
            fetchProfile,
          }),
        );
      },
    });
    const manager = new PluginManager(makeFakeCrowi());

    await activate(manager, plugin);
    const active = resolveActiveDrivers(manager);

    expect(active.auth).toHaveLength(1);
    expect(active.auth[0].kind).toBe('oauth2');
    expect(getClientConfig).not.toHaveBeenCalled();
    expect(fetchProfile).not.toHaveBeenCalled();
  });

  it('keeps an unconfigured OIDC driver in active.auth and never evaluates getClientConfig() or discovery during bootstrap', async () => {
    const getClientConfig = jest.fn(() => null);
    const plugin = stubPlugin({
      name: '@crowi/plugin-example-oidc',
      registerAuth: (registry) => {
        registry.register(
          'example-oidc',
          createOidcDriver({
            buttonLabel: 'Example',
            discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
            getClientConfig,
          }),
        );
      },
    });
    const manager = new PluginManager(makeFakeCrowi());

    await activate(manager, plugin);
    const active = resolveActiveDrivers(manager);

    expect(active.auth).toHaveLength(1);
    expect(active.auth[0].kind).toBe('oidc');
    expect(getClientConfig).not.toHaveBeenCalled();
  });

  it('does not re-resolve or filter drivers on reconfigureAffected() — only the changed plugin is notified', async () => {
    const getClientConfig = jest.fn(() => null);
    const reconfigure = jest.fn();
    const plugin = stubPlugin({
      name: '@crowi/plugin-example-oauth2-reconfigure',
      reconfigure,
      registerAuth: (registry) => {
        registry.register(
          'example-oauth2-reconfigure',
          createOAuth2Driver({
            buttonLabel: 'Example',
            authorizeUrl: 'https://idp.example.com/authorize',
            tokenUrl: 'https://idp.example.com/token',
            getClientConfig,
            fetchProfile: async () => ({ ok: false, reason: 'unused' }),
          }),
        );
      },
    });
    const manager = new PluginManager(makeFakeCrowi());
    await activate(manager, plugin);
    loadPluginsInto(manager, [plugin]);

    const result = await manager.reconfigureAffected([`plugin:${plugin.name}`]);

    expect(result).toEqual({ attempted: 1, succeeded: 1 });
    expect(reconfigure).toHaveBeenCalledTimes(1);
    expect(getClientConfig).not.toHaveBeenCalled();
    // The driver registered at activate() time is still the one active.auth
    // resolves to — reconfigureAffected() does not re-register or re-filter it.
    const active = resolveActiveDrivers(manager);
    expect(active.auth).toHaveLength(1);
  });
});

describe('PluginManager.getReadinessIssues — core declarations (feature-core-config-readiness-and-mail, AC-1/AC-2/AC-3)', () => {
  it('AC-1: reports the core:mail issue with only the field name (never the value) when mail:from is empty, independent of any loaded plugin', () => {
    const manager = new PluginManager(makeFakeCrowiWithNamespace({ 'mail:from': '' }));

    expect(manager.getReadinessIssues()).toEqual([
      { source: 'core', id: 'core:mail', label: 'Mail', href: '/admin/mail', fields: [{ name: 'from', configured: false }] },
    ]);
  });

  it('AC-1: omits the core:mail issue once mail:from has a non-empty value', () => {
    const manager = new PluginManager(makeFakeCrowiWithNamespace({ 'mail:from': 'noreply@example.com' }));
    expect(manager.getReadinessIssues()).toEqual([]);
  });

  it('treats an absent mail:from key the same as an empty string (unset)', () => {
    const manager = new PluginManager(makeFakeCrowiWithNamespace({}));
    expect(manager.getReadinessIssues()).toEqual([
      { source: 'core', id: 'core:mail', label: 'Mail', href: '/admin/mail', fields: [{ name: 'from', configured: false }] },
    ]);
  });

  it('AC-2/AC-3: the core mail:from issue and a selected-driver plugin mail issue (SMTP host) coexist as independent issues', () => {
    const smtp = stubPlugin({
      name: '@crowi/plugin-mail-smtp',
      readiness: { registry: 'mail', driver: 'smtp', requiredConfigFields: ['host'] },
    });
    const manager = new PluginManager(makeFakeCrowiWithNamespace({ 'mail:from': '', 'plugin:@crowi/plugin-mail-smtp:host': '' }));
    loadPluginsInto(manager, [smtp]);
    withSelectedDrivers(manager, { mail: 'smtp' });

    expect(manager.getReadinessIssues()).toEqual([
      { source: 'plugin', id: 'plugin:@crowi/plugin-mail-smtp', pluginName: '@crowi/plugin-mail-smtp', fields: [{ name: 'host', configured: false }] },
      { source: 'core', id: 'core:mail', label: 'Mail', href: '/admin/mail', fields: [{ name: 'from', configured: false }] },
    ]);
  });

  it('AC-3: mail issues disappear only once both mail:from and the selected driver field are set', () => {
    const smtp = stubPlugin({
      name: '@crowi/plugin-mail-smtp',
      readiness: { registry: 'mail', driver: 'smtp', requiredConfigFields: ['host'] },
    });

    // Only mail:from set — the plugin issue remains.
    const manager = new PluginManager(makeFakeCrowiWithNamespace({ 'mail:from': 'noreply@example.com', 'plugin:@crowi/plugin-mail-smtp:host': '' }));
    loadPluginsInto(manager, [smtp]);
    withSelectedDrivers(manager, { mail: 'smtp' });
    expect(manager.getReadinessIssues()).toEqual([
      { source: 'plugin', id: 'plugin:@crowi/plugin-mail-smtp', pluginName: '@crowi/plugin-mail-smtp', fields: [{ name: 'host', configured: false }] },
    ]);

    // Only host set — the core issue remains.
    const manager2 = new PluginManager(makeFakeCrowiWithNamespace({ 'mail:from': '', 'plugin:@crowi/plugin-mail-smtp:host': 'smtp.example.com' }));
    loadPluginsInto(manager2, [smtp]);
    withSelectedDrivers(manager2, { mail: 'smtp' });
    expect(manager2.getReadinessIssues()).toEqual([
      { source: 'core', id: 'core:mail', label: 'Mail', href: '/admin/mail', fields: [{ name: 'from', configured: false }] },
    ]);

    // Both set — no mail issue at all.
    const manager3 = new PluginManager(
      makeFakeCrowiWithNamespace({ 'mail:from': 'noreply@example.com', 'plugin:@crowi/plugin-mail-smtp:host': 'smtp.example.com' }),
    );
    loadPluginsInto(manager3, [smtp]);
    withSelectedDrivers(manager3, { mail: 'smtp' });
    expect(manager3.getReadinessIssues()).toEqual([]);
  });

  it('AC-2: Resend selected driver reports apiKey, and SES declares no readiness issue of its own (no requiredConfigFields to violate)', () => {
    const resend = stubPlugin({
      name: '@crowi/plugin-mail-resend',
      readiness: { registry: 'mail', driver: 'resend', requiredConfigFields: ['apiKey'] },
    });
    // SES has no `readiness` declaration at all — an AWS-credential-shaped
    // plugin with everything empty must never surface as an issue (mirrors
    // the AC-1 AWS-credentials-excluded assertion above).
    const ses = stubPlugin({ name: '@crowi/plugin-mail-aws-ses' });
    const manager = new PluginManager(makeFakeCrowiWithNamespace({ 'mail:from': 'noreply@example.com', 'plugin:@crowi/plugin-mail-resend:apiKey': '' }));
    loadPluginsInto(manager, [resend, ses]);
    withSelectedDrivers(manager, { mail: 'resend' });

    expect(manager.getReadinessIssues()).toEqual([
      { source: 'plugin', id: 'plugin:@crowi/plugin-mail-resend', pluginName: '@crowi/plugin-mail-resend', fields: [{ name: 'apiKey', configured: false }] },
    ]);
  });

  it('AC-2: SES genuinely selected as the active mail driver still declares no readiness issue of its own, even with an empty AWS-credential-shaped namespace', () => {
    // Unlike the Resend case above (SES loaded but NOT selected), this
    // test actually selects `mail: 'ses'` — the driver the AWS default
    // credential chain relies on — with region/accessKeyId/secretAccessKey
    // all empty, and asserts no SES-specific issue appears.
    const ses = stubPlugin({ name: '@crowi/plugin-mail-aws-ses' });
    const manager = new PluginManager(
      makeFakeCrowiWithNamespace({
        'mail:from': 'noreply@example.com',
        'plugin:@crowi/plugin-mail-aws-ses:region': '',
        'plugin:@crowi/plugin-mail-aws-ses:accessKeyId': '',
        'plugin:@crowi/plugin-mail-aws-ses:secretAccessKey': '',
      }),
    );
    loadPluginsInto(manager, [ses]);
    withSelectedDrivers(manager, { mail: 'ses' });

    expect(manager.getReadinessIssues()).toEqual([]);
  });

  it('AC-2: an unselected mail driver plugin issue is excluded even when its own required field is empty', () => {
    const smtp = stubPlugin({
      name: '@crowi/plugin-mail-smtp',
      readiness: { registry: 'mail', driver: 'smtp', requiredConfigFields: ['host'] },
    });
    const resend = stubPlugin({
      name: '@crowi/plugin-mail-resend',
      readiness: { registry: 'mail', driver: 'resend', requiredConfigFields: ['apiKey'] },
    });
    const manager = new PluginManager(
      makeFakeCrowiWithNamespace({
        'mail:from': 'noreply@example.com',
        'plugin:@crowi/plugin-mail-smtp:host': '',
        'plugin:@crowi/plugin-mail-resend:apiKey': '',
      }),
    );
    loadPluginsInto(manager, [smtp, resend]);
    withSelectedDrivers(manager, { mail: 'resend' });

    expect(manager.getReadinessIssues()).toEqual([
      { source: 'plugin', id: 'plugin:@crowi/plugin-mail-resend', pluginName: '@crowi/plugin-mail-resend', fields: [{ name: 'apiKey', configured: false }] },
    ]);
  });
});
