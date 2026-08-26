import ConfigService, { type ConfigChangeListener, deriveChangedNamespaces } from './config';

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

  it('AC-1/AC-2: reloads from Mongo after a partial-write failure, converging memory to what landed, and notifies/publishes the attempted namespaces', async () => {
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
    expect(calls).toEqual([{ ns: ['crowi'], source: 'local' }]);

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
