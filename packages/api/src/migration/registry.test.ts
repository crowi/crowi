import { MigrationRegistry } from './registry';
import { defineMigration, type MigrationDefinition } from './types';

/**
 * RFC-0008 §5.3/§5.5 — registry ordering + lookup. Pure, no DB: the
 * registry never touches Mongo (pending/apply live in the runner).
 */

const fixture = (id: string, fromVersion: string, toVersion: string, order?: number): MigrationDefinition =>
  defineMigration({
    id,
    fromVersion,
    toVersion,
    layer: 'preflight',
    severity: 'blocking',
    description: `fixture ${id}`,
    order,
    stages: [],
    isPending: async () => false,
  });

describe('MigrationRegistry', () => {
  it('orders by fromVersion, then toVersion, then order, then declaration', () => {
    const reg = new MigrationRegistry([
      fixture('c', '2.0', '2.1'),
      fixture('a', '1.x', '2.0'),
      fixture('b', '1.x', '2.1'),
      fixture('a2', '1.x', '2.0', 5), // same range as 'a' but explicit later order
    ]);
    expect(reg.all().map((m) => m.id)).toEqual(['a', 'a2', 'b', 'c']);
  });

  it('treats `1.x` as preceding `2.0`', () => {
    const reg = new MigrationRegistry([fixture('newer', '2.0', '2.1'), fixture('older', '1.x', '2.0')]);
    expect(reg.all()[0].id).toBe('older');
  });

  it('filters by layer', () => {
    const boot = defineMigration({
      id: 'boot-one',
      fromVersion: '1.x',
      toVersion: '2.0',
      layer: 'boot',
      description: 'fixture boot-one',
      stages: [],
      isPending: async () => false,
    });
    const reg = new MigrationRegistry([boot, fixture('pre-one', '1.x', '2.0')]);
    expect(reg.byLayer('boot').map((m) => m.id)).toEqual(['boot-one']);
    expect(reg.byLayer('preflight').map((m) => m.id)).toEqual(['pre-one']);
  });

  it('looks up by id and reports the latest target', () => {
    const reg = new MigrationRegistry([fixture('a', '1.x', '2.0'), fixture('b', '2.0', '2.1')]);
    expect(reg.get('b')?.id).toBe('b');
    expect(reg.get('missing')).toBeUndefined();
    expect(reg.latestTarget()).toBe('2.1');
  });

  it('rejects duplicate ids', () => {
    expect(() => new MigrationRegistry([fixture('dup', '1.x', '2.0'), fixture('dup', '2.0', '2.1')])).toThrow(/Duplicate migration id/);
  });

  it('returns null latestTarget for an empty registry (Phase 1 baseline)', () => {
    expect(new MigrationRegistry([]).latestTarget()).toBeNull();
    expect(new MigrationRegistry([]).all()).toHaveLength(0);
  });
});
