import { ALL_BOOT_STEPS, type BootStep, CLI_SKIP_STEPS, resolveBootOrder } from './boot-steps';

const stub = (name: string, after: string[] = []): BootStep => ({
  name,
  layer: 'core',
  after,
  run: () => undefined,
});

describe('resolveBootOrder', () => {
  it('returns the input unchanged when no step has `after`', () => {
    const steps = [stub('a'), stub('b'), stub('c')];
    const order = resolveBootOrder(steps).map((s) => s.name);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('orders dependencies before dependents', () => {
    const steps = [stub('app', ['core']), stub('core'), stub('feature', ['app'])];
    const order = resolveBootOrder(steps).map((s) => s.name);
    expect(order.indexOf('core')).toBeLessThan(order.indexOf('app'));
    expect(order.indexOf('app')).toBeLessThan(order.indexOf('feature'));
  });

  it('throws on an `after` entry that is neither declared nor skipped', () => {
    const steps = [stub('a', ['missing'])];
    expect(() => resolveBootOrder(steps)).toThrow(/'a' requires 'missing'/);
  });

  it('throws on a cycle, naming the steps involved', () => {
    const steps = [stub('a', ['b']), stub('b', ['a'])];
    expect(() => resolveBootOrder(steps)).toThrow(/cycle detected: a → b → a$/);
  });

  it('throws on duplicate step names', () => {
    const steps = [stub('dup'), stub('dup')];
    expect(() => resolveBootOrder(steps)).toThrow(/declared twice/);
  });

  describe('skip', () => {
    it('excludes the skipped step from the output', () => {
      const steps = [stub('a'), stub('b'), stub('c')];
      const order = resolveBootOrder(steps, { skip: new Set(['b']) }).map((s) => s.name);
      expect(order).toEqual(['a', 'c']);
    });

    it('treats a dependency on a skipped step as already satisfied instead of erroring', () => {
      // `b` depends on `skipped`, which is declared in the input but excluded
      // via `skip` — this must NOT throw a "requires 'skipped'" error, and
      // `b` must still appear in the output (this is the semantic that
      // differs from `topoSortPlugins`'s `alreadyLoaded`, per AC-2).
      const steps = [stub('skipped'), stub('a'), stub('b', ['skipped'])];
      const order = resolveBootOrder(steps, { skip: new Set(['skipped']) }).map((s) => s.name);
      expect(order).toEqual(['a', 'b']);
    });

    it('does not error when a skipped name is not declared in the input at all', () => {
      const steps = [stub('a', ['not-in-batch'])];
      expect(() => resolveBootOrder(steps, { skip: new Set(['not-in-batch']) })).not.toThrow();
    });
  });
});

describe('ALL_BOOT_STEPS', () => {
  it('declares each of the 11 runInitLayers steps exactly once', () => {
    const names = ALL_BOOT_STEPS.map((s) => s.name);
    expect(names).toEqual([
      'encryption',
      'database',
      'models',
      'redis',
      'config',
      'bootMigrations',
      'seedOAuthClients',
      'renderer',
      'plugins',
      'mailer',
      'lru',
    ]);
  });

  it("resolveBootOrder(ALL_BOOT_STEPS) matches runInitLayers()'s current execution order (AC-3/AC-6)", () => {
    const order = resolveBootOrder(ALL_BOOT_STEPS).map((s) => s.name);
    expect(order).toEqual(ALL_BOOT_STEPS.map((s) => s.name));
  });

  it("resolveBootOrder(ALL_BOOT_STEPS, { skip: CLI_SKIP_STEPS }) matches initForCli()'s current execution order (AC-4/AC-6)", () => {
    const order = resolveBootOrder(ALL_BOOT_STEPS, { skip: CLI_SKIP_STEPS }).map((s) => s.name);
    expect(order).toEqual(['encryption', 'database', 'models', 'config', 'renderer', 'plugins']);
  });

  it("CLI_SKIP_STEPS names are all declared in ALL_BOOT_STEPS (no stale/typo'd entries)", () => {
    const names = new Set(ALL_BOOT_STEPS.map((s) => s.name));
    for (const skipped of CLI_SKIP_STEPS) {
      expect(names.has(skipped)).toBe(true);
    }
  });

  it('carries the pre-refactor `DEBUG=crowi:boot` phase label on every step via `debugLabel` (AC-11)', () => {
    // `runInitLayers()`'s `step()` timing wrapper used to be called with
    // literal `setupXxx`/`runXxx` labels (e.g. `step('setupEncryption', ...)`)
    // before this file existed. `debugLabel` must reproduce those exact
    // strings so `DEBUG=crowi:boot` output is unchanged post-refactor —
    // `bootStep.name` alone (the topo-sort/skip identifier, e.g.
    // `'encryption'`) is a different, shorter vocabulary and must not leak
    // into the debug label.
    const labels = Object.fromEntries(ALL_BOOT_STEPS.map((s) => [s.name, s.debugLabel]));
    expect(labels).toEqual({
      encryption: 'setupEncryption',
      database: 'setupDatabase',
      models: 'setupModels',
      redis: 'setupRedisClient',
      config: 'setupConfig',
      bootMigrations: 'runBootMigrations',
      seedOAuthClients: 'seedOAuthClients',
      renderer: 'setupRenderer',
      plugins: 'setupPlugins',
      mailer: 'setupMailer',
      lru: 'setupLRU',
    });
  });
});
