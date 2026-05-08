import type { CrowiPlugin } from '@crowi/plugin-api';
import { topoSortPlugins } from './topo-sort';

const stub = (name: string, requires: string[] = []): CrowiPlugin => ({
  name,
  version: '0.0.0',
  requires,
});

describe('topoSortPlugins', () => {
  it('returns the input unchanged when no plugin has requires', () => {
    const plugins = [stub('a'), stub('b'), stub('c')];
    const sorted = topoSortPlugins(plugins);
    expect(sorted.map((p) => p.name)).toEqual(['a', 'b', 'c']);
  });

  it('orders dependencies before dependents', () => {
    const plugins = [stub('app', ['core']), stub('core'), stub('feature', ['app'])];
    const sorted = topoSortPlugins(plugins);
    const order = sorted.map((p) => p.name);
    expect(order.indexOf('core')).toBeLessThan(order.indexOf('app'));
    expect(order.indexOf('app')).toBeLessThan(order.indexOf('feature'));
  });

  it('throws on a missing required plugin', () => {
    const plugins = [stub('a', ['missing'])];
    expect(() => topoSortPlugins(plugins)).toThrow(/'a' requires 'missing'/);
  });

  it('treats already-loaded names as resolved', () => {
    const plugins = [stub('a', ['already-loaded'])];
    expect(() => topoSortPlugins(plugins, new Set(['already-loaded']))).not.toThrow();
  });

  it('throws on a cycle', () => {
    const plugins = [stub('a', ['b']), stub('b', ['a'])];
    expect(() => topoSortPlugins(plugins)).toThrow(/cycle/);
  });

  it('throws on duplicate plugin names', () => {
    const plugins = [stub('dup'), stub('dup')];
    expect(() => topoSortPlugins(plugins)).toThrow(/loaded twice/);
  });
});
