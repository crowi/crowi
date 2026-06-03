import ConfigService, { type ConfigChangeListener, deriveChangedNamespaces } from './config';

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
  function makeService(): ConfigService {
    const writes: Array<{ ns: string; config: Record<string, unknown> }> = [];
    const updateConfigByNamespace = jest.fn(async (ns: string, config: Record<string, unknown>) => {
      writes.push({ ns, config });
    });
    const updateConfig = jest.fn(async (_ns: string, _key: string, _value: unknown) => undefined);
    const deleteConfig = jest.fn(async (_ns: string, _key: string) => undefined);
    const fakeCrowi = {
      model: () => ({ updateConfigByNamespace, updateConfig, deleteConfig }),
      event: () => {
        const e: any = {
          on: jest.fn(),
          emit: jest.fn(),
        };
        return e;
      },
      setupMailer: jest.fn(async () => undefined),
      redisOpts: null,
    } as any;
    return new ConfigService(fakeCrowi);
  }

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
