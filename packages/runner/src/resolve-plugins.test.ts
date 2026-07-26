import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IMPLICIT_DEFAULT_PLUGINS } from './config-file';
import { ABSORBED_CORE_PLUGIN_NAMES, resolvePlugins } from './resolve-plugins';

/**
 * `resolvePlugins()`'s `ABSORBED_CORE_PLUGIN_NAMES` top-level-seed shim
 * (feature-renderer-plugin-boundary Phase 3 spec §7) — no test file
 * existed for `resolve-plugins.ts` before this phase. Builds a real
 * (throwaway) project dir with a fake `node_modules/` so `resolvePlugins`
 * runs its ACTUAL `createRequire`/`require` resolution path, same
 * `fs.mkdtemp` tmpdir pattern `config-file.test.ts` already uses.
 */

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

/** Write a minimal CJS `CrowiPlugin` package into `projectDir/node_modules/<name>`. */
async function writeFakePlugin(projectDir: string, name: string, opts: { requires?: string[] } = {}): Promise<void> {
  const pkgDir = path.join(projectDir, 'node_modules', name);
  await fs.mkdir(pkgDir, { recursive: true });
  await writeJson(path.join(pkgDir, 'package.json'), { name, version: '0.0.0', main: 'index.js' });
  const requiresLiteral = JSON.stringify(opts.requires ?? []);
  await fs.writeFile(
    path.join(pkgDir, 'index.js'),
    `module.exports = { default: { name: ${JSON.stringify(name)}, version: '0.0.0', requires: ${requiresLiteral} } };\n`,
  );
}

describe('resolvePlugins — ABSORBED_CORE_PLUGIN_NAMES top-level seed shim', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crowi-runner-absorbed-'));
    await writeJson(path.join(tmpDir, 'package.json'), { name: 'fake-runner-project', version: '0.0.0' });
    // `resolvePluginList()` always prepends IMPLICIT_DEFAULT_PLUGINS
    // regardless of `crowi.config.json` — fake-install all of them so
    // every test's `resolvePlugins()` call resolves cleanly.
    for (const name of IMPLICIT_DEFAULT_PLUGINS) {
      await writeFakePlugin(tmpDir, name);
    }
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('a top-level absorbed plugin name is skipped with a warning and does not fail even though it is NOT installed', async () => {
    await writeJson(path.join(tmpDir, 'crowi.config.json'), { plugins: ['@crowi/plugin-renderer-emoji'] });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await resolvePlugins(tmpDir);

    expect(result.plugins.some((p) => p.name === '@crowi/plugin-renderer-emoji')).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/@crowi\/plugin-renderer-emoji/);
  });

  it('BOTH absorbed names warn exactly once each (no duplicate warning per name)', async () => {
    await writeJson(path.join(tmpDir, 'crowi.config.json'), {
      plugins: ['@crowi/plugin-renderer-emoji', '@crowi/plugin-renderer-link-card'],
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await resolvePlugins(tmpDir);

    const absorbedInResult = result.plugins.filter((p) => ABSORBED_CORE_PLUGIN_NAMES.has(p.name));
    expect(absorbedInResult).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('a duplicate top-level entry for the same absorbed name (deduped upstream by resolvePluginList) still warns only once', async () => {
    await writeJson(path.join(tmpDir, 'crowi.config.json'), {
      plugins: ['@crowi/plugin-renderer-emoji', '@crowi/plugin-renderer-emoji'],
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await resolvePlugins(tmpDir);

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('an unrelated missing plugin still throws (fail-fast is unaffected by the shim)', async () => {
    await writeJson(path.join(tmpDir, 'crowi.config.json'), { plugins: ['@crowi/plugin-does-not-exist'] });
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(resolvePlugins(tmpDir)).rejects.toThrow(/Failed to import plugin '@crowi\/plugin-does-not-exist'/);
  });

  it('a transitive `requires` naming an absorbed package still throws — the shim only forgives TOP-LEVEL seed entries', async () => {
    await writeFakePlugin(tmpDir, 'my-plugin-with-stale-requires', { requires: ['@crowi/plugin-renderer-emoji'] });
    await writeJson(path.join(tmpDir, 'crowi.config.json'), { plugins: ['my-plugin-with-stale-requires'] });
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(resolvePlugins(tmpDir)).rejects.toThrow(/Failed to import plugin '@crowi\/plugin-renderer-emoji'/);
  });

  it('the returned config object is not mutated — the stale name is still visible in result.config.plugins', async () => {
    await writeJson(path.join(tmpDir, 'crowi.config.json'), { plugins: ['@crowi/plugin-renderer-link-card'] });
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await resolvePlugins(tmpDir);

    expect(result.config.plugins).toContain('@crowi/plugin-renderer-link-card');
    // ...but it was still excluded from the actually-imported plugin set.
    expect(result.plugins.some((p) => p.name === '@crowi/plugin-renderer-link-card')).toBe(false);
  });

  it('a config with no absorbed names at all resolves normally with zero warnings', async () => {
    await writeFakePlugin(tmpDir, 'some-real-plugin');
    await writeJson(path.join(tmpDir, 'crowi.config.json'), { plugins: ['some-real-plugin'] });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await resolvePlugins(tmpDir);

    expect(result.plugins.some((p) => p.name === 'some-real-plugin')).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
