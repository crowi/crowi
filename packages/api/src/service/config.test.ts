import ConfigService, { type ConfigChangeListener, deriveChangedNamespaces } from './config';

/** Shared by `ConfigService listener API` + the `saveConfig(Value)` describe blocks below. */
function makeService(
  overrides: { updateByParams?: jest.Mock; updateAtomicConfigGroup?: jest.Mock; updateConfig?: jest.Mock; updateConfigByNamespace?: jest.Mock } = {},
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
  const fakeCrowi = {
    model: () => ({ updateConfigByNamespace, updateConfig, updateByParams, updateAtomicConfigGroup, deleteConfig }),
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
 * feature-config-write-durability §2/§3 — `saveConfig`'s underlying
 * model static (`configModel.updateConfigByNamespace`) propagates a write
 * failure instead of swallowing it, so a rejection reaches the caller
 * before `this.update(...)` (local memory mutation, listener notify,
 * Redis publish) ever runs (AC-3), and a resend of the SAME full config
 * after a partial failure re-writes every key and converges memory with
 * the database (AC-9).
 */
describe('ConfigService.saveConfig (AC-3/AC-9: fail-propagating by default, resend converges)', () => {
  it('AC-3: failure propagates the rejection, leaves local memory unmutated, and never notifies listeners', async () => {
    const updateConfigByNamespace = jest.fn(async () => {
      throw new Error('mongo write failed');
    });
    const svc = makeService({ updateConfigByNamespace });
    svc.config.crowi = { 'app:title': 'Old Title' };
    const calls: unknown[] = [];
    svc.onConfigChange((ns) => {
      calls.push(ns);
    });

    await expect(svc.saveConfig('crowi', { 'app:title': 'New Title' })).rejects.toThrow('mongo write failed');

    expect(svc.config.crowi['app:title']).toBe('Old Title');
    expect(calls).toEqual([]);
  });

  it('AC-9: resending the SAME full config after a partial-write failure ends with memory and the underlying store in agreement', async () => {
    // Mimics the model layer's own Promise.allSettled semantics: only
    // `app:confidential`'s write actually fails on the first attempt —
    // `app:title`'s succeeds and lands in `db` even though the overall
    // call still rejects.
    const db: Record<string, unknown> = {};
    let failConfidential = true;
    const updateConfigByNamespace = jest.fn(async (_ns: string, config: Record<string, unknown>) => {
      const shouldFail = failConfidential && 'app:confidential' in config;
      for (const [key, value] of Object.entries(config)) {
        if (shouldFail && key === 'app:confidential') continue;
        db[key] = value;
      }
      if (shouldFail) {
        throw new Error('mongo write failed: app:confidential');
      }
    });
    const svc = makeService({ updateConfigByNamespace });

    const fullConfig = { 'app:title': 'New Title', 'app:confidential': 'Internal only' };

    await expect(svc.saveConfig('crowi', fullConfig)).rejects.toThrow('mongo write failed: app:confidential');
    // Memory was never touched by the failed attempt — this is exactly
    // what forces a resend to recompute from the pre-failure (stale)
    // state and resubmit every key, not just the one that failed.
    expect(svc.config.crowi).toBeUndefined();
    expect(db).toEqual({ 'app:title': 'New Title' });

    failConfidential = false;
    await svc.saveConfig('crowi', fullConfig);

    expect(db).toEqual(fullConfig);
    expect(svc.config.crowi).toEqual(fullConfig);
    // The resend re-sent BOTH keys, not a diff against the failed
    // attempt — upsert-idempotency on the key that already persisted is
    // what makes this self-healing rather than merely "eventually mostly
    // correct".
    expect(updateConfigByNamespace).toHaveBeenNthCalledWith(2, 'crowi', fullConfig);
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
