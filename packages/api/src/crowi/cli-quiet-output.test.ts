import { join, resolve } from 'node:path';
import type { CrowiPlugin } from '@crowi/plugin-api';
import Crowi from 'src/crowi';
import type { PluginRegistries } from 'src/plugin';
import { PluginManager } from 'src/plugin';

/**
 * feature-admin-cli-quiet-output: `setupPlugins()` runs under both boot
 * entry points — `init()` (the server) and `initForCli()` (`@crowi/admin-cli`)
 * — but only the CLI wants its stdout free of boot noise (`--json | jq`
 * piping must not see it). `cliContext` (set by `initForCli()`) is how
 * `setupPlugins()` tells the two apart:
 *   - server (`cliContext === false`): unchanged — `console.log` via
 *     `bootNote()`, regardless of `NODE_ENV`.
 *   - CLI (`cliContext === true`) + dev: the summary moves to stderr
 *     (`console.error`), never stdout.
 *   - CLI (`cliContext === true`) + prod (`NODE_ENV=production`): suppressed
 *     entirely.
 *
 * `PluginManager.bootstrap()` / `getLoadedPlugins()` are stubbed so this runs
 * without a real plugin resolution pass — the DB/env-construction cost is
 * the same "side-effect-free construction" `env-validation.test.ts` /
 * `api-ready-url.test.ts` rely on; only `setupPlugins()` itself does I/O
 * here (fully mocked below).
 */

const ROOT_DIR = resolve(join(__dirname, '..', '..'));

function stubPlugin(): CrowiPlugin {
  return { name: 'test-plugin', version: '1.2.3' } as CrowiPlugin;
}

function mockPluginManager(loaded: CrowiPlugin[]): void {
  jest.spyOn(PluginManager.prototype, 'bootstrap').mockResolvedValue({} as PluginRegistries);
  jest.spyOn(PluginManager.prototype, 'getLoadedPlugins').mockReturnValue(loaded);
}

describe('Crowi.setupPlugins (feature-admin-cli-quiet-output)', () => {
  it('server boot (cliContext=false) keeps logging the summary to stdout, unaffected by NODE_ENV', async () => {
    mockPluginManager([stubPlugin()]);
    const crowi = new Crowi(ROOT_DIR, { NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(crowi.cliContext).toBe(false);
    await crowi.setupPlugins();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[crowi] Loaded 1 plugin(s): test-plugin@1.2.3'));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('CLI + dev: the summary goes to stderr, never stdout', async () => {
    mockPluginManager([stubPlugin()]);
    const crowi = new Crowi(ROOT_DIR, { NODE_ENV: 'development' } as unknown as NodeJS.ProcessEnv);
    crowi.cliContext = true;
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await crowi.setupPlugins();

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[crowi] Loaded 1 plugin(s): test-plugin@1.2.3'));
  });

  it('CLI + prod (NODE_ENV=production): the summary is suppressed entirely', async () => {
    mockPluginManager([stubPlugin()]);
    const crowi = new Crowi(ROOT_DIR, { NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv);
    crowi.cliContext = true;
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await crowi.setupPlugins();

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('initForCli() sets cliContext=true before the shared boot steps run', async () => {
    // CLIENT_URL set so this env doesn't also produce the unrelated
    // "CLIENT_URL is not set" env-validation warning (see env-validation.test.ts).
    const crowi = new Crowi(ROOT_DIR, { NODE_ENV: 'development', CLIENT_URL: 'http://localhost:4301' } as unknown as NodeJS.ProcessEnv);
    jest.spyOn(crowi, 'setupEncryption').mockImplementation(() => undefined);
    jest.spyOn(crowi, 'setupDatabase').mockResolvedValue(undefined);
    jest.spyOn(crowi, 'setupModels').mockResolvedValue(undefined);
    jest.spyOn(crowi, 'setupConfig').mockResolvedValue(undefined);
    jest.spyOn(crowi, 'setupRenderer').mockImplementation(() => undefined);
    // Assert cliContext inside the setupPlugins mock itself, not only after
    // initForCli() resolves — this pins down that the flag is already true
    // by the time setupPlugins() (the step that reads it) actually runs,
    // rather than merely being true by some later point.
    const setupPluginsSpy = jest.spyOn(crowi, 'setupPlugins').mockImplementation(async () => {
      expect(crowi.cliContext).toBe(true);
    });

    expect(crowi.cliContext).toBe(false);
    await crowi.initForCli();

    expect(setupPluginsSpy).toHaveBeenCalledTimes(1);
    expect(crowi.cliContext).toBe(true);
  });
});
