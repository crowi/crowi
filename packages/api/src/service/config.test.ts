import ConfigService, { type ConfigChangeListener, deriveChangedNamespaces } from './config';

/** Shared by `ConfigService listener API` + `ConfigService.saveConfigValueDurable` below. */
function makeService(overrides: { updateByParams?: jest.Mock } = {}): ConfigService {
  const writes: Array<{ ns: string; config: Record<string, unknown> }> = [];
  const updateConfigByNamespace = jest.fn(async (ns: string, config: Record<string, unknown>) => {
    writes.push({ ns, config });
  });
  const updateConfig = jest.fn(async (_ns: string, _key: string, _value: unknown) => undefined);
  const updateByParams = overrides.updateByParams ?? jest.fn(async (_ns: string, _key: string, _value: unknown) => undefined);
  const deleteConfig = jest.fn(async (_ns: string, _key: string) => undefined);
  const fakeCrowi = {
    model: () => ({ updateConfigByNamespace, updateConfig, updateByParams, deleteConfig }),
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
 * feature-renderer-plugin-boundary Phase 3 spec §6.2 — the fail-
 * propagating durable write path used ONLY for `security:linkCardEnabled`.
 * Unlike `saveConfigValue`/`saveConfig` (whose underlying model statics
 * catch-and-log write errors, so they never throw), `saveConfigValueDurable`
 * calls `configModel.updateByParams` directly — the one static that
 * propagates. These are unit-level (mocked model), so they run
 * everywhere (unlike `config.smoke.test.ts`'s real-Redis cross-replica
 * variant, which is gated behind `crowi-test-redis` availability).
 */
describe('ConfigService.saveConfigValueDurable', () => {
  it('success: calls updateByParams, updates local memory, and notifies listeners', async () => {
    const svc = makeService();
    const calls: Array<{ ns: string[]; source: string }> = [];
    svc.onConfigChange((ns, source) => {
      calls.push({ ns, source });
    });

    await svc.saveConfigValueDurable('crowi', 'security:linkCardEnabled', false);

    expect(svc.config.crowi?.['security:linkCardEnabled']).toBe(false);
    expect(calls).toEqual([{ ns: ['crowi'], source: 'local' }]);
  });

  it('failure: propagates the rejection, leaves local memory unmutated, and never notifies listeners', async () => {
    const updateByParams = jest.fn(async () => {
      throw new Error('mongo write failed');
    });
    const svc = makeService({ updateByParams });
    const calls: unknown[] = [];
    svc.onConfigChange((ns, source) => {
      calls.push({ ns, source });
    });

    await expect(svc.saveConfigValueDurable('crowi', 'security:linkCardEnabled', false)).rejects.toThrow('mongo write failed');

    expect(updateByParams).toHaveBeenCalledWith('crowi', 'security:linkCardEnabled', false);
    // Zero local memory mutation — the namespace was never populated.
    expect(svc.config.crowi).toBeUndefined();
    // Zero notification/publish.
    expect(calls).toEqual([]);
  });

  it('failure leaves a PRE-EXISTING value in local memory untouched (not just absent)', async () => {
    const updateByParams = jest.fn(async () => {
      throw new Error('mongo write failed');
    });
    const svc = makeService({ updateByParams });
    svc.config.crowi = { 'security:linkCardEnabled': true };

    await expect(svc.saveConfigValueDurable('crowi', 'security:linkCardEnabled', false)).rejects.toThrow('mongo write failed');

    expect(svc.config.crowi['security:linkCardEnabled']).toBe(true);
  });
});
