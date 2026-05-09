import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CrowiConfigFileSchema, IMPLICIT_DEFAULT_PLUGINS, loadCrowiConfigFile, resolvePluginList } from './config-file';

describe('CrowiConfigFileSchema', () => {
  it('fills in defaults for an empty input', () => {
    const result = CrowiConfigFileSchema.parse({});
    expect(result.plugins).toEqual([]);
    expect(result.storage.driver).toBe('local');
    expect(result.search.driver).toBe('mongo');
  });

  it('preserves plugin list and driver overrides', () => {
    const result = CrowiConfigFileSchema.parse({
      plugins: ['@crowi/plugin-storage-aws-s3'],
      storage: { driver: 's3' },
      search: { driver: 'elasticsearch' },
    });
    expect(result.plugins).toEqual(['@crowi/plugin-storage-aws-s3']);
    expect(result.storage.driver).toBe('s3');
    expect(result.search.driver).toBe('elasticsearch');
  });
});

describe('resolvePluginList', () => {
  it('returns the implicit defaults when the config has no plugins', () => {
    const config = CrowiConfigFileSchema.parse({});
    const list = resolvePluginList(config);
    expect(list).toEqual([...IMPLICIT_DEFAULT_PLUGINS]);
  });

  it('appends user-listed plugins after the implicit defaults', () => {
    const config = CrowiConfigFileSchema.parse({ plugins: ['@crowi/plugin-storage-aws-s3'] });
    const list = resolvePluginList(config);
    expect(list[list.length - 1]).toBe('@crowi/plugin-storage-aws-s3');
    expect(list.slice(0, IMPLICIT_DEFAULT_PLUGINS.length)).toEqual([...IMPLICIT_DEFAULT_PLUGINS]);
  });

  it('deduplicates while preserving first-occurrence order', () => {
    const config = CrowiConfigFileSchema.parse({ plugins: ['some-plugin', 'some-plugin'] });
    const list = resolvePluginList(config);
    expect(list.filter((n) => n === 'some-plugin')).toHaveLength(1);
  });
});

describe('loadCrowiConfigFile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crowi-cfg-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns defaults when crowi.config.json is absent', async () => {
    const config = await loadCrowiConfigFile(tmpDir);
    expect(config.plugins).toEqual([]);
    expect(config.storage.driver).toBe('local');
  });

  it('parses a valid file', async () => {
    await fs.writeFile(path.join(tmpDir, 'crowi.config.json'), JSON.stringify({ plugins: ['@crowi/plugin-storage-aws-s3'], storage: { driver: 's3' } }));
    const config = await loadCrowiConfigFile(tmpDir);
    expect(config.plugins).toEqual(['@crowi/plugin-storage-aws-s3']);
    expect(config.storage.driver).toBe('s3');
  });

  it('rejects invalid JSON with a clear message', async () => {
    await fs.writeFile(path.join(tmpDir, 'crowi.config.json'), '{ broken');
    await expect(loadCrowiConfigFile(tmpDir)).rejects.toThrow(/invalid JSON/);
  });

  it('rejects schema-incompatible content', async () => {
    await fs.writeFile(path.join(tmpDir, 'crowi.config.json'), JSON.stringify({ plugins: 'not-an-array' }));
    await expect(loadCrowiConfigFile(tmpDir)).rejects.toThrow(/schema validation failed/);
  });
});
