import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { StorageDriver } from '@crowi/plugin-api';
import { createLocalDriver } from '@crowi/plugin-storage-local';
import { crowi } from 'src/test/setup';
import type { MigrationApplicationModel } from 'src/models/migration-application';

import { createRebuildCliApi } from './rebuild-api';
import { RebuildRunner, defineRebuild } from './rebuild-runner';

/**
 * RFC-0008 §8.5 — rebuild dispatch + shared-runner reuse.
 *
 * Verifies the four registered targets dispatch correctly, dry-run flows
 * through the shared runner into the task ctx, and — critically — a rebuild
 * NEVER appends to the `migrationApplications` audit log (rebuilds have no
 * pending/applied concept). search/storage-copy ride the shared runner; the
 * not-yet-implemented renderer/backlink surface a clear error.
 */

const MigrationApplication = () => crowi.model('MigrationApplication') as MigrationApplicationModel;

beforeEach(async () => {
  await MigrationApplication().deleteMany({});
});

describe('RebuildRunner — shared core, no audit log (§8.5)', () => {
  it('runs a rebuild task through the shared context and returns its stats', async () => {
    let sawDryRun: boolean | null = null;
    const task = defineRebuild({
      id: 'fixture',
      description: 'fixture rebuild',
      async run(ctx) {
        sawDryRun = ctx.dryRun;
        ctx.progress.setLabel('working');
        return { widgets: 7 };
      },
    });

    const runner = new RebuildRunner(crowi);
    const outcome = await runner.run(task);

    expect(outcome.id).toBe('fixture');
    expect(outcome.stats).toEqual({ widgets: 7 });
    expect(outcome.interrupted).toBe(false);
    expect(sawDryRun).toBe(false);
  });

  it('propagates dryRun into the task ctx', async () => {
    let sawDryRun: boolean | null = null;
    const task = defineRebuild({
      id: 'fixture-dry',
      description: 'fixture',
      async run(ctx) {
        sawDryRun = ctx.dryRun;
        return {};
      },
    });

    await new RebuildRunner(crowi, { dryRun: true }).run(task);
    expect(sawDryRun).toBe(true);
  });

  it('does NOT append to migrationApplications (no pending/applied concept)', async () => {
    const task = defineRebuild({
      id: 'search',
      description: 'fixture',
      async run() {
        return { ok: 1 };
      },
    });

    await new RebuildRunner(crowi).run(task);

    const count = await MigrationApplication().countDocuments({});
    expect(count).toBe(0);
    expect(await MigrationApplication().latestFor('search')).toBeNull();
  });
});

describe('RebuildCliApi — dispatch (§8.5)', () => {
  it('rebuildSearch dispatches to the active search driver and records nothing', async () => {
    // Inject a fake search driver exposing rebuild().
    let rebuilt = false;
    const fakeDriver = { rebuild: async () => void (rebuilt = true) };
    const plugins = crowi.getPlugins() as unknown as {
      active: { search: unknown };
      search: { list: () => { driverName: string; plugin: string }[]; get: (n: string) => unknown };
    };
    const prevActive = plugins.active.search;
    const prevList = plugins.search.list;
    const prevGet = plugins.search.get;
    plugins.active.search = fakeDriver;
    plugins.search.list = () => [{ driverName: 'fake', plugin: 'test-plugin' }];
    plugins.search.get = (name: string) => (name === 'fake' ? fakeDriver : undefined);

    try {
      const api = createRebuildCliApi(crowi);
      const outcome = await api.rebuildSearch();
      expect(rebuilt).toBe(true);
      expect(outcome.stats).toMatchObject({ driverName: 'fake', pluginName: 'test-plugin' });
      expect(await MigrationApplication().countDocuments({})).toBe(0);
    } finally {
      plugins.active.search = prevActive;
      plugins.search.list = prevList;
      plugins.search.get = prevGet;
    }
  });

  it('rebuildStorageCopy copies objects through the shared runner', async () => {
    const srcRoot = mkdtempSync(path.join(os.tmpdir(), 'rebuild-copy-src-'));
    const dstRoot = mkdtempSync(path.join(os.tmpdir(), 'rebuild-copy-dst-'));
    const srcDriver: StorageDriver = createLocalDriver({ rootDir: srcRoot });
    const dstDriver: StorageDriver = createLocalDriver({ rootDir: dstRoot });
    const SRC = 'rb-src';
    const DST = 'rb-dst';

    const reg = crowi.getPlugins().storage as unknown as { drivers: Map<string, { plugin: string; driver: StorageDriver }> };
    reg.drivers.set(SRC, { plugin: 'test', driver: srcDriver });
    reg.drivers.set(DST, { plugin: 'test', driver: dstDriver });
    await crowi.model('Attachment').deleteMany({}).exec();

    try {
      await srcDriver.put('a/one.txt', Readable.from(['hello']), { contentType: 'text/plain' });
      await crowi.model('Attachment').create({ filePath: 'a/one.txt', fileFormat: 'text/plain', fileName: 'one.txt' });

      const api = createRebuildCliApi(crowi);
      const outcome = await api.rebuildStorageCopy({ from: SRC, to: DST });

      expect(outcome.stats).toMatchObject({ ok: 1, failed: 0 });
      expect(readFileSync(path.join(dstRoot, 'a/one.txt'), 'utf8')).toBe('hello');
      expect(await MigrationApplication().countDocuments({})).toBe(0);
    } finally {
      reg.drivers.delete(SRC);
      reg.drivers.delete(DST);
      rmSync(srcRoot, { recursive: true, force: true });
      rmSync(dstRoot, { recursive: true, force: true });
    }
  });

  it('rebuildStorageCopy dry-run lists candidates without writing', async () => {
    const srcRoot = mkdtempSync(path.join(os.tmpdir(), 'rebuild-copy-src-'));
    const dstRoot = mkdtempSync(path.join(os.tmpdir(), 'rebuild-copy-dst-'));
    const srcDriver: StorageDriver = createLocalDriver({ rootDir: srcRoot });
    const dstDriver: StorageDriver = createLocalDriver({ rootDir: dstRoot });
    const SRC = 'rb-src2';
    const DST = 'rb-dst2';

    const reg = crowi.getPlugins().storage as unknown as { drivers: Map<string, { plugin: string; driver: StorageDriver }> };
    reg.drivers.set(SRC, { plugin: 'test', driver: srcDriver });
    reg.drivers.set(DST, { plugin: 'test', driver: dstDriver });
    await crowi.model('Attachment').deleteMany({}).exec();

    try {
      await crowi.model('Attachment').create({ filePath: 'a/dry.txt', fileFormat: 'text/plain', fileName: 'dry.txt' });
      const api = createRebuildCliApi(crowi);
      const outcome = await api.rebuildStorageCopy({ from: SRC, to: DST, dryRun: true });
      expect(outcome.stats).toMatchObject({ skipped: 1, ok: 0 });
      expect(outcome.stats.sampleKeys).toEqual(['a/dry.txt']);
    } finally {
      reg.drivers.delete(SRC);
      reg.drivers.delete(DST);
      rmSync(srcRoot, { recursive: true, force: true });
      rmSync(dstRoot, { recursive: true, force: true });
    }
  });

  it('rebuildRenderer is not implemented yet (clear error, no record)', async () => {
    const api = createRebuildCliApi(crowi);
    await expect(api.rebuildRenderer()).rejects.toThrow(/not implemented yet/i);
    expect(await MigrationApplication().countDocuments({})).toBe(0);
  });

  it('rebuildBacklink is not implemented yet (clear error, no record)', async () => {
    const api = createRebuildCliApi(crowi);
    await expect(api.rebuildBacklink()).rejects.toThrow(/not implemented yet/i);
    expect(await MigrationApplication().countDocuments({})).toBe(0);
  });
});
