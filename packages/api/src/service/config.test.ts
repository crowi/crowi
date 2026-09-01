import ConfigService, { type ConfigChangeListener, deriveChangedNamespaces } from './config';
import type Crowi from 'src/crowi';

// Only `setupPubSub listener wiring` below exercises this; every other
// describe block in this file passes `redisOpts: null` so `setupPubSub`'s
// `createClient` branch never runs.
//
// `jest.mock('redis', factory)` alone is not enough here: `setup.ts`
// (`setupFilesAfterEnv`, evaluated before this file) imports `src/crowi`,
// which transitively requires `./config` — so by the time this file's own
// `jest.mock('redis', ...)` registers, `config.ts`'s module-scope
// `createClient` binding has ALREADY been resolved to the real `redis`
// export and stays that way (a later mock registration cannot change an
// already-evaluated closure). `jest.isolateModules` + a fresh `require`
// forces `config.ts` to re-evaluate against the now-registered mock.
jest.mock('redis', () => ({
  createClient: jest.fn(),
}));

/**
 * Re-requires `./config` (and, from the SAME isolated registry, `redis`)
 * fresh so the returned `ConfigService` class and `createClient` mock are
 * the pair that actually reference each other — see the module-doc comment
 * above for why the module-level `ConfigService` import can't be reused for
 * this.
 */
function freshConfigModule(): { FreshConfigService: typeof ConfigService; createClientMock: jest.Mock } {
  let FreshConfigService!: typeof ConfigService;
  let createClientMock!: jest.Mock;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    FreshConfigService = require('./config').default;
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    createClientMock = require('redis').createClient;
  });
  return { FreshConfigService, createClientMock };
}

/** Yields to the macrotask queue — lets an in-flight promise chain (e.g. a queued write's turn) advance past its next `await` before the caller continues. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Shared by `ConfigService listener API` + the `saveConfig(Value)` describe blocks below. */
function makeService(
  overrides: {
    updateByParams?: jest.Mock;
    updateAtomicConfigGroup?: jest.Mock;
    updateConfig?: jest.Mock;
    updateConfigByNamespace?: jest.Mock;
    loadAllConfig?: jest.Mock;
  } = {},
): ConfigService {
  const writes: Array<{ ns: string; config: Record<string, unknown> }> = [];
  const updateConfigByNamespace =
    overrides.updateConfigByNamespace ??
    jest.fn(async (ns: string, config: Record<string, unknown>) => {
      writes.push({ ns, config });
    });
  const updateConfig = overrides.updateConfig ?? jest.fn(async (_ns: string, _key: string, _value: unknown) => undefined);
  const updateByParams = overrides.updateByParams ?? jest.fn(async (_ns: string, _key: string, _value: unknown) => undefined);
  const updateAtomicConfigGroup =
    overrides.updateAtomicConfigGroup ?? jest.fn(async (_ns: string, _plugin: string, _group: string, _values: Record<string, string>) => undefined);
  const deleteConfig = jest.fn(async (_ns: string, _key: string) => undefined);
  const loadAllConfig = overrides.loadAllConfig ?? jest.fn(async () => ({}));
  const fakeCrowi = {
    model: () => ({ updateConfigByNamespace, updateConfig, updateByParams, updateAtomicConfigGroup, deleteConfig, loadAllConfig }),
    event: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const e: any = {
        on: jest.fn(),
        emit: jest.fn(),
      };
      return e;
    },
    setupMailer: jest.fn(async () => undefined),
    redisOpts: null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return new ConfigService(fakeCrowi);
}

describe('deriveChangedNamespaces', () => {
  it('maps plugin keys to plugin:<name> namespaces', () => {
    expect(deriveChangedNamespaces('crowi', ['plugin:@crowi/plugin-aws:region', 'plugin:@crowi/plugin-aws:accessKeyId'])).toEqual(['plugin:@crowi/plugin-aws']);
  });

  it('keeps non-plugin keys mapped to the mongo namespace', () => {
    expect(deriveChangedNamespaces('notification', ['slack:token']).sort()).toEqual(['notification']);
  });

  it('mixes plugin and non-plugin keys', () => {
    expect(deriveChangedNamespaces('crowi', ['plugin:foo:bar', 'security:passwordSeed']).sort()).toEqual(['crowi', 'plugin:foo'].sort());
  });

  it('emits multiple plugin namespaces when keys span plugins', () => {
    const result = deriveChangedNamespaces('crowi', ['plugin:a:x', 'plugin:b:y']).sort();
    expect(result).toEqual(['plugin:a', 'plugin:b']);
  });

  it('falls back to the mongo namespace on empty input', () => {
    expect(deriveChangedNamespaces('crowi', [])).toEqual(['crowi']);
  });
});

describe('ConfigService listener API', () => {
  it('calls onConfigChange listener after saveConfig with derived plugin namespaces', async () => {
    const svc = makeService();
    const calls: Array<{ ns: string[]; source: string }> = [];
    const listener: ConfigChangeListener = (ns, source) => {
      calls.push({ ns, source });
    };
    svc.onConfigChange(listener);

    await svc.saveConfig('crowi', { 'plugin:@crowi/plugin-aws:region': 'ap-northeast-1' });

    expect(calls).toHaveLength(1);
    expect(calls[0].ns).toEqual(['plugin:@crowi/plugin-aws']);
    expect(calls[0].source).toBe('local');
  });

  it('calls listener after saveConfigValue with the right namespace', async () => {
    const svc = makeService();
    const calls: string[][] = [];
    svc.onConfigChange((ns) => {
      calls.push(ns);
    });

    await svc.saveConfigValue('crowi', 'plugin:foo:bar', 'baz');

    expect(calls).toEqual([['plugin:foo']]);
  });

  it('calls listener after deleteConfig', async () => {
    const svc = makeService();
    svc.config.crowi = { 'plugin:foo:bar': 'baz' };
    const calls: string[][] = [];
    svc.onConfigChange((ns) => {
      calls.push(ns);
    });

    await svc.deleteConfig('crowi', 'plugin:foo:bar');

    expect(calls).toEqual([['plugin:foo']]);
  });

  it('continues invoking listeners when one throws', async () => {
    const svc = makeService();
    const calls: string[] = [];
    svc.onConfigChange(() => {
      calls.push('first');
      throw new Error('boom');
    });
    svc.onConfigChange(() => {
      calls.push('second');
    });

    await svc.saveConfig('crowi', { 'plugin:foo:bar': 'baz' });

    expect(calls).toEqual(['first', 'second']);
  });
});

/**
 * feature-config-write-durability — `saveConfigValue` is now the
 * fail-propagating default: its underlying model static
 * (`configModel.updateConfig`) no longer catches a Mongo write failure
 * (see `models/config.ts`), so a rejection reaches the caller before any
 * local memory mutation or listener notification. These are unit-level
 * (mocked model), so they run everywhere (unlike
 * `config.smoke.test.ts`'s real-Redis cross-replica variant, which is
 * gated behind `crowi-test-redis` availability).
 */
describe('ConfigService.saveConfigValue (AC-3: fail-propagating by default)', () => {
  it('success: calls updateConfig, updates local memory, and notifies listeners', async () => {
    const svc = makeService();
    const calls: Array<{ ns: string[]; source: string }> = [];
    svc.onConfigChange((ns, source) => {
      calls.push({ ns, source });
    });

    await svc.saveConfigValue('crowi', 'security:linkCardEnabled', false);

    expect(svc.config.crowi?.['security:linkCardEnabled']).toBe(false);
    expect(calls).toEqual([{ ns: ['crowi'], source: 'local' }]);
  });

  it('failure: propagates the rejection, leaves local memory unmutated, and never notifies listeners', async () => {
    const updateConfig = jest.fn(async () => {
      throw new Error('mongo write failed');
    });
    const svc = makeService({ updateConfig });
    const calls: unknown[] = [];
    svc.onConfigChange((ns, source) => {
      calls.push({ ns, source });
    });

    await expect(svc.saveConfigValue('crowi', 'security:linkCardEnabled', false)).rejects.toThrow('mongo write failed');

    expect(updateConfig).toHaveBeenCalledWith('crowi', 'security:linkCardEnabled', false);
    // Zero local memory mutation — the namespace was never populated.
    expect(svc.config.crowi).toBeUndefined();
    // Zero notification/publish.
    expect(calls).toEqual([]);
  });

  it('failure leaves a PRE-EXISTING value in local memory untouched (not just absent)', async () => {
    const updateConfig = jest.fn(async () => {
      throw new Error('mongo write failed');
    });
    const svc = makeService({ updateConfig });
    svc.config.crowi = { 'security:linkCardEnabled': true };

    await expect(svc.saveConfigValue('crowi', 'security:linkCardEnabled', false)).rejects.toThrow('mongo write failed');

    expect(svc.config.crowi['security:linkCardEnabled']).toBe(true);
  });
});

/**
 * `saveConfig`'s underlying model static (`updateConfigByNamespace`)
 * writes each key independently, so a rejection can still leave some
 * keys persisted. Reloading from Mongo before rethrowing is what makes
 * local memory converge to whatever actually landed, instead of relying
 * on a caller resending the same payload to reconcile it.
 */
describe('ConfigService.saveConfig (feature-config-write-reconciliation)', () => {
  /**
   * Mimics the model layer's own Promise.allSettled semantics: a batch
   * containing `app:confidential` always fails that one key while its
   * siblings still land in `db` — any other batch succeeds outright.
   * Also backs `loadAllConfig` so the reload in `saveConfig`'s failure
   * path observes exactly what `db` holds.
   */
  function makePartialWriteDb() {
    const db: Record<string, unknown> = { 'app:title': 'Old Title' };
    const updateConfigByNamespace = jest.fn(async (_ns: string, config: Record<string, unknown>) => {
      const failing = 'app:confidential' in config;
      for (const [key, value] of Object.entries(config)) {
        if (failing && key === 'app:confidential') continue;
        db[key] = value;
      }
      if (failing) {
        throw new Error('mongo write failed: app:confidential');
      }
    });
    const loadAllConfig = jest.fn(async () => ({ crowi: { ...db } }));
    return { db, updateConfigByNamespace, loadAllConfig };
  }

  it('AC-1/AC-2/AC-8/AC-9: reloads from Mongo after a partial-write failure, converging memory to what landed, publishing to Redis, and notifying local listeners tagged "remote" so they reconfigure themselves', async () => {
    const { updateConfigByNamespace, loadAllConfig } = makePartialWriteDb();
    const svc = makeService({ updateConfigByNamespace, loadAllConfig });
    svc.config.crowi = { 'app:title': 'Old Title' };
    const publish = jest.fn(async () => undefined);
    svc.pubSub.publisher = { publish };
    const calls: Array<{ ns: string[]; source: string }> = [];
    svc.onConfigChange((ns, source) => calls.push({ ns, source }));

    await expect(svc.saveConfig('crowi', { 'app:title': 'New Title', 'app:confidential': 'Internal only' })).rejects.toThrow(
      'mongo write failed: app:confidential',
    );

    // `app:title` actually landed in Mongo despite the overall rejection
    // — memory must reflect exactly that, not the stale pre-attempt
    // value and not the attempted (never-persisted) `app:confidential`.
    expect(svc.config.crowi).toEqual({ 'app:title': 'New Title' });
    expect(loadAllConfig).toHaveBeenCalledTimes(1);
    // Tagged 'remote', not 'local': nobody else is going to call
    // reconfigureAffected for a write that never returned successfully,
    // so PluginManager.handleConfigChange must reconfigure right here,
    // the same as it would for a change it received over pub/sub.
    expect(calls).toEqual([{ ns: ['crowi'], source: 'remote' }]);

    expect(publish).toHaveBeenCalledTimes(1);
    const [channel, payload] = publish.mock.calls[0];
    expect(channel).toBe(svc.pubSub.channel);
    expect(JSON.parse(payload)).toEqual({ id: svc.pubSub.id, changedNamespaces: ['crowi'] });
  });

  it('AC-3: the original write error propagates even though the reload succeeded', async () => {
    const updateConfigByNamespace = jest.fn(async () => {
      throw new Error('mongo write failed');
    });
    const loadAllConfig = jest.fn(async () => ({ crowi: {} }));
    const svc = makeService({ updateConfigByNamespace, loadAllConfig });

    await expect(svc.saveConfig('crowi', { 'app:title': 'New Title' })).rejects.toThrow('mongo write failed');
  });

  it('AC-4: when the reload itself fails, memory is left untouched, listeners are never notified, and the original write error propagates', async () => {
    const updateConfigByNamespace = jest.fn(async () => {
      throw new Error('mongo write failed');
    });
    const loadAllConfig = jest.fn(async () => {
      throw new Error('mongo read failed');
    });
    const svc = makeService({ updateConfigByNamespace, loadAllConfig });
    svc.config.crowi = { 'app:title': 'Old Title' };
    const publish = jest.fn(async () => undefined);
    svc.pubSub.publisher = { publish };
    const calls: unknown[] = [];
    svc.onConfigChange((ns) => calls.push(ns));

    await expect(svc.saveConfig('crowi', { 'app:title': 'New Title' })).rejects.toThrow('mongo write failed');

    expect(svc.config.crowi).toEqual({ 'app:title': 'Old Title' });
    expect(calls).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });

  it('AC-5: without a resend, a later unrelated save does not carry a value the earlier failed attempt never actually persisted', async () => {
    const { db, updateConfigByNamespace, loadAllConfig } = makePartialWriteDb();
    const svc = makeService({ updateConfigByNamespace, loadAllConfig });
    svc.config.crowi = { 'app:title': 'Old Title' };

    await expect(svc.saveConfig('crowi', { 'app:title': 'New Title', 'app:confidential': 'Internal only' })).rejects.toThrow(
      'mongo write failed: app:confidential',
    );
    // The reload already converged memory to what actually landed.
    expect(svc.config.crowi).toEqual({ 'app:title': 'New Title' });
    expect(db['app:confidential']).toBeUndefined();

    // A later, unrelated save must build on that converged state, not
    // resurrect the never-persisted `app:confidential` — proving memory
    // was never left holding a value the database didn't actually have.
    await svc.saveConfig('crowi', { 'security:registrationMode': 'Restricted' });

    expect(svc.config.crowi).toEqual({ 'app:title': 'New Title', 'security:registrationMode': 'Restricted' });
    expect(svc.config.crowi['app:confidential']).toBeUndefined();
  });
});

/**
 * feature-config-reconciliation-safety §2 — `saveConfig` / `saveConfigValue`
 * / `saveConfigAtomicGroup` / `deleteConfig` are the public entry points
 * that change config; they now run one at a time within a process so a
 * failing write's reload-then-set can't land in the middle of a different
 * write's own set(). Internal calls (`update`, `load`, `notifyUpdated`)
 * deliberately do NOT go through the same queue (AC-7).
 */
describe('ConfigService write-queue serialization (feature-config-reconciliation-safety)', () => {
  it('AC-5: a second entry point does not start its write until an in-flight one has fully finished', async () => {
    let inFlight = 0;
    let overlapped = false;
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const updateConfigByNamespace = jest.fn(async () => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      await gate;
      inFlight -= 1;
    });
    const updateConfig = jest.fn(async () => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      inFlight -= 1;
    });
    const svc = makeService({ updateConfigByNamespace, updateConfig });

    const first = svc.saveConfig('crowi', { 'app:title': 'New Title' });
    // Let the first turn actually start (and block on the gate) before
    // firing the second — otherwise both could start in the same tick
    // and the assertion below wouldn't discriminate serialized from
    // concurrent.
    await tick();
    const second = svc.saveConfigValue('crowi', 'app:confidential', 'secret');

    releaseFirst!();
    await Promise.all([first, second]);

    expect(overlapped).toBe(false);
    expect(updateConfig).toHaveBeenCalledTimes(1);
  });

  it('AC-6: a save that succeeds while an earlier save is still reconciling after its own failure is not rolled back by that reconciliation', async () => {
    let releaseReload: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseReload = resolve;
    });

    const updateConfigByNamespace = jest.fn(async (_ns: string, config: Record<string, unknown>) => {
      if ('app:confidential' in config) {
        throw new Error('mongo write failed: app:confidential');
      }
    });
    // Deliberately stale: this snapshot predates the second save below.
    // Without serialization, `set()`-ing it after the second save has
    // already applied its own fresh value would roll that value back.
    const loadAllConfig = jest.fn(async () => {
      await gate;
      return { crowi: { 'app:title': 'Old Title' } };
    });
    const updateConfig = jest.fn(async () => undefined);
    const svc = makeService({ updateConfigByNamespace, loadAllConfig, updateConfig });
    svc.config.crowi = { 'app:title': 'Old Title' };

    const firstSave = svc.saveConfig('crowi', { 'app:confidential': 'Internal only' }).catch((err: Error) => err);

    await tick();

    const secondSave = svc.saveConfigValue('crowi', 'app:title', 'New Title');
    let secondSettled = false;
    secondSave.then(() => {
      secondSettled = true;
    });
    await tick();
    // Still queued behind the first save's still-open (gated) turn.
    expect(secondSettled).toBe(false);

    releaseReload!();
    await firstSave;
    await secondSave;

    expect(svc.config.crowi['app:title']).toBe('New Title');
  });

  it('AC-7: a public entry point does not deadlock on its own internal update() call', async () => {
    const svc = makeService();

    const result = await Promise.race([
      svc.saveConfigAtomicGroup('crowi', '@crowi/plugin-google', 'clientCredentials', { clientId: 'id', clientSecret: 'secret' }),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('deadlock: saveConfigAtomicGroup never resolved')), 1000)),
    ]);

    expect(result).toBeUndefined();
  });

  it("AC-7: a config-change listener that writes back from inside the failure-path notification (e.g. a plugin's reconfigure(ctx) calling ctx.setConfig()) does not deadlock on the turn that is still notifying it", async () => {
    const updateConfigByNamespace = jest.fn(async () => {
      throw new Error('mongo write failed');
    });
    const updateConfig = jest.fn(async () => undefined);
    const svc = makeService({ updateConfigByNamespace, loadAllConfig: jest.fn(async () => ({ crowi: {} })), updateConfig });

    let nestedWriteRan = false;
    svc.onConfigChange(async (_ns, source) => {
      if (source !== 'remote') return;
      // Mirrors PluginContext.setConfig(): a listener reacting to this
      // failure-path notification writing back through the same public
      // entry points saveConfig serializes against.
      await svc.saveConfigValue('crowi', 'app:title', 'reconfigured');
      nestedWriteRan = true;
    });

    const result = await Promise.race([
      svc.saveConfig('crowi', { 'app:confidential': 'secret' }).catch((err: Error) => err),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('deadlock: saveConfig never settled')), 1000)),
    ]);

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe('mongo write failed');
    expect(nestedWriteRan).toBe(true);
    expect(updateConfig).toHaveBeenCalledWith('crowi', 'app:title', 'reconfigured');
  });

  it("does not let a later write start until the failure-path notify — and whatever a listener does in response, e.g. a plugin's reconfigure(ctx) — has fully finished, not merely until the write+reload have", async () => {
    const updateConfigByNamespace = jest.fn(async (_ns: string, config: Record<string, unknown>) => {
      if ('app:confidential' in config) {
        throw new Error('mongo write failed: app:confidential');
      }
    });
    const loadAllConfig = jest.fn(async () => ({ crowi: {} }));
    const events: string[] = [];
    const updateConfig = jest.fn(async () => {
      events.push('second-write-start');
    });
    const svc = makeService({ updateConfigByNamespace, loadAllConfig, updateConfig });

    let releaseNotify: (() => void) | undefined;
    const notifyGate = new Promise<void>((resolve) => {
      releaseNotify = resolve;
    });
    svc.onConfigChange(async (_ns, source) => {
      // Stands in for a slow plugin reconfigure(ctx) reacting to the
      // failure-path notification.
      if (source !== 'remote') return;
      events.push('notify-start');
      await notifyGate;
      events.push('notify-end');
    });

    const firstSave = svc.saveConfig('crowi', { 'app:confidential': 'secret' }).catch((err: Error) => err);

    // Let the first turn run: the write fails, the reload lands, and the
    // notify reaches (and blocks on) the gate above.
    await tick();
    await tick();
    expect(events).toEqual(['notify-start']);

    const secondSave = svc.saveConfigValue('crowi', 'app:title', 'New Title');
    await tick();

    // Still queued behind the first turn's still-open notification. A
    // turn that released the queue right after the write+reload (before
    // notify) would let this start here already — that gap is exactly
    // what let two turns' reconfigure calls finish in either order.
    expect(updateConfig).not.toHaveBeenCalled();
    expect(events).toEqual(['notify-start']);

    releaseNotify!();
    await firstSave;
    await secondSave;

    expect(events).toEqual(['notify-start', 'notify-end', 'second-write-start']);
  });

  it("AC-5/AC-10: a SUCCESSFUL save's local notify runs after the write queue already released — a later write is not blocked behind it", async () => {
    const updateConfigByNamespace = jest.fn(async () => undefined);
    const events: string[] = [];
    const updateConfig = jest.fn(async () => {
      events.push('second-write-start');
    });
    const svc = makeService({ updateConfigByNamespace, updateConfig });

    let releaseNotify: (() => void) | undefined;
    const notifyGate = new Promise<void>((resolve) => {
      releaseNotify = resolve;
    });
    // Gate only the FIRST local notify (the one under test) — the second
    // save below also notifies with source 'local' on its own success
    // (that path is untouched, design decision 3), and must not be
    // mistaken for a second reaction to the first save.
    let gatedOnce = false;
    svc.onConfigChange(async (_ns, source) => {
      if (source !== 'local' || gatedOnce) return;
      gatedOnce = true;
      events.push('notify-start');
      await notifyGate;
      events.push('notify-end');
    });

    const firstSave = svc.saveConfig('crowi', { 'app:title': 'New Title' });

    // Let the first turn's write land, the queue release, and its
    // (still-gated) local notify start.
    await tick();
    await tick();
    expect(events).toEqual(['notify-start']);

    const secondSave = svc.saveConfigValue('crowi', 'app:confidential', 'secret');
    await tick();

    // Unlike the failure-path test above, a second write is NOT queued
    // behind the first save's still-open local notify — the write queue
    // already released once the first save's Mongo write + memory update
    // finished, before its local notify (this listener) ever ran. A
    // pre-fix implementation that kept the local notify inside the turn
    // would leave `updateConfig` uncalled here, still queued behind the
    // gate.
    expect(updateConfig).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['notify-start', 'second-write-start']);

    releaseNotify!();
    await firstSave;
    await secondSave;

    expect(events).toEqual(['notify-start', 'second-write-start', 'notify-end']);
  });
});

describe('ConfigService.saveConfigAtomicGroup (RFC-0014 phase 4, AC-3)', () => {
  it('applies the whole group to local config and notifies its plugin namespace exactly once', async () => {
    const svc = makeService();
    svc.config.crowi = { 'plugin:@crowi/plugin-google:clientId': 'old-id', 'plugin:@crowi/plugin-google:clientSecret': 'old-secret' };
    const calls: Array<{ ns: string[]; source: string }> = [];
    svc.onConfigChange((ns, source) => {
      calls.push({ ns, source });
    });

    await svc.saveConfigAtomicGroup('crowi', '@crowi/plugin-google', 'clientCredentials', { clientId: 'new-id', clientSecret: 'new-secret' });

    // Both fields land together — a listener must never observe the pair
    // half-applied, which is the entire reason they share a document.
    expect(svc.config.crowi['plugin:@crowi/plugin-google:clientId']).toBe('new-id');
    expect(svc.config.crowi['plugin:@crowi/plugin-google:clientSecret']).toBe('new-secret');
    // One logical change, one notification — not one per field.
    expect(calls).toHaveLength(1);
    expect(calls[0].ns).toEqual(['plugin:@crowi/plugin-google']);
  });

  it('AC-3: a rejected write propagates, leaves the cached pair untouched, and notifies nobody', async () => {
    const updateAtomicConfigGroup = jest.fn(async () => {
      throw new Error('mongo write failed');
    });
    const svc = makeService({ updateAtomicConfigGroup });
    svc.config.crowi = { 'plugin:@crowi/plugin-google:clientId': 'old-id', 'plugin:@crowi/plugin-google:clientSecret': 'old-secret' };
    const calls: string[][] = [];
    svc.onConfigChange((ns) => {
      calls.push(ns);
    });

    await expect(
      svc.saveConfigAtomicGroup('crowi', '@crowi/plugin-google', 'clientCredentials', { clientId: 'new-id', clientSecret: 'new-secret' }),
    ).rejects.toThrow('mongo write failed');

    // Nothing anywhere may reflect a value the database refused: not the
    // in-memory config other replicas would diverge from, and not the
    // publish that would tell them to reload.
    expect(svc.config.crowi['plugin:@crowi/plugin-google:clientId']).toBe('old-id');
    expect(svc.config.crowi['plugin:@crowi/plugin-google:clientSecret']).toBe('old-secret');
    expect(calls).toHaveLength(0);
  });

  it('writes through the single-document model call, never as separate per-key writes', async () => {
    const updateAtomicConfigGroup = jest.fn(async () => undefined);
    const svc = makeService({ updateAtomicConfigGroup });
    svc.config.crowi = {};

    await svc.saveConfigAtomicGroup('crowi', '@crowi/plugin-google', 'clientCredentials', { clientId: 'id', clientSecret: 'secret' });

    expect(updateAtomicConfigGroup).toHaveBeenCalledTimes(1);
    expect(updateAtomicConfigGroup).toHaveBeenCalledWith('crowi', '@crowi/plugin-google', 'clientCredentials', { clientId: 'id', clientSecret: 'secret' });
  });
});

/**
 * `setupPubSub()` wires
 * `subscriber.subscribe(channel, listener)` with a mocked `redis` module
 * (real connectivity for this same call path is already covered by
 * `config.smoke.test.ts` against a live Redis). node-redis invokes the
 * subscribe listener as `(message, channel)`; a client that silently
 * flipped that order would still type-check (both are `string`), so only a
 * behavioral test pins it — this exercises `setupPubSub`'s own
 * `channel !== pubSub.channel` guard both ways.
 */
describe('ConfigService.setupPubSub listener wiring', () => {
  function makeFakeRedisClient() {
    let subscribeListener: ((message: string, channel: string) => void | Promise<void>) | undefined;
    return {
      on: jest.fn(),
      connect: jest.fn(async () => undefined),
      publish: jest.fn(async () => undefined),
      subscribe: jest.fn(async (_channel: string, listener: (message: string, channel: string) => void | Promise<void>) => {
        subscribeListener = listener;
      }),
      disconnect: jest.fn(async () => undefined),
      invokeSubscribeListener: (message: string, channel: string) => subscribeListener?.(message, channel),
    };
  }

  /** Same narrow-fixture shape `config.smoke.test.ts`'s `fakeCrowi` uses, minus the real `buildRedisOpts` (the mocked `createClient` never inspects `redisOpts`'s shape). */
  function makeFakeCrowi(loadAllConfig: jest.Mock): Crowi {
    return {
      redisOpts: { socket: { host: '127.0.0.1', port: 6379 } },
      redis: {}, // truthy — setupPubSub only null-checks this field
      model: () => ({ loadAllConfig }),
      setupMailer: jest.fn(async () => undefined),
      getBaseUrl: () => null,
      getEnv: () => ({ REDIS_KEY_PREFIX: 'unit-test' }) as unknown as NodeJS.ProcessEnv,
    } as unknown as Crowi;
  }

  /** Builds a fresh `ConfigService` wired to two mocked redis clients and runs `setupPubSub()` — shared by both tests below, which differ only in how they call `invokeSubscribeListener`. */
  async function setupSubscribedSvc() {
    const { FreshConfigService, createClientMock } = freshConfigModule();
    const publisherClient = makeFakeRedisClient();
    const subscriberClient = makeFakeRedisClient();
    createClientMock.mockImplementationOnce(() => publisherClient).mockImplementationOnce(() => subscriberClient);

    const loadAllConfig = jest.fn(async () => ({}));
    const svc = new FreshConfigService(makeFakeCrowi(loadAllConfig));

    await svc.setupPubSub();

    return { svc, subscriberClient, loadAllConfig };
  }

  it('AC-5: a listener invoked as (message, channel) — the order node-redis uses — reloads config and notifies listeners "remote"', async () => {
    const { svc, subscriberClient, loadAllConfig } = await setupSubscribedSvc();
    const notifications: Array<[string[], string]> = [];
    svc.onConfigChange((changedNamespaces, source) => {
      notifications.push([changedNamespaces, source]);
    });

    expect(subscriberClient.subscribe).toHaveBeenCalledWith(svc.pubSub.channel, expect.any(Function));

    const message = JSON.stringify({ id: 'other-instance-id', changedNamespaces: ['crowi'] });
    await subscriberClient.invokeSubscribeListener(message, svc.pubSub.channel);

    expect(loadAllConfig).toHaveBeenCalledTimes(1);
    expect(notifications).toEqual([[['crowi'], 'remote']]);
  });

  it('a listener invoked with the arguments swapped (channel, message) never reloads — pins the order the correct-order test above relies on', async () => {
    const { svc, subscriberClient, loadAllConfig } = await setupSubscribedSvc();

    const message = JSON.stringify({ id: 'other-instance-id', changedNamespaces: ['crowi'] });
    // Swapped: channel first, message second — `setupPubSub`'s own
    // `channel !== pubSub.channel` guard reads the first argument as the
    // channel, so a swapped call is silently dropped instead of reloading.
    await subscriberClient.invokeSubscribeListener(svc.pubSub.channel, message);

    expect(loadAllConfig).not.toHaveBeenCalled();
  });
});
