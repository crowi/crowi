import plugin from '../index';

describe('plugin default export', () => {
  it('declares CrowiPlugin metadata', () => {
    expect(plugin.name).toBe('@crowi/plugin-search-mongo');
    expect(typeof plugin.version).toBe('string');
    expect(plugin.configSchema).toBeDefined();
    expect(typeof plugin.registerSearch).toBe('function');
  });

  // feature-plugin-capability-scoping: declares exactly the models it
  // reads (read-only) via ctx.model() in driver.ts.
  it('declares modelAccess for the models it reads via ctx.model()', () => {
    expect(plugin.modelAccess).toEqual(['Page', 'Revision']);
  });
});
