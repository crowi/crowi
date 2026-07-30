import { Types } from 'mongoose';
import { crowi } from 'src/test/setup';
import type { PluginRenderCacheModel } from 'src/models/plugin-render-cache';
import { MongoCacheStorage, SINGLE_ENTRY_REJECT_BYTES, PER_PAGE_REJECT_BYTES } from './mongodb-cache';

const silentLog = { warn: jest.fn(), debug: jest.fn() };

const buildCache = (): MongoCacheStorage => {
  const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
  silentLog.warn.mockReset();
  return new MongoCacheStorage({ PluginRenderCache, log: silentLog });
};

const buildKey = (overrides: Partial<{ pluginName: string; pluginCacheVersion: number; pageId: string; embedKey: string }> = {}) => ({
  pluginName: overrides.pluginName ?? '@crowi/plugin-test',
  pluginCacheVersion: overrides.pluginCacheVersion ?? 1,
  pageId: overrides.pageId ?? new Types.ObjectId().toHexString(),
  embedKey: overrides.embedKey ?? 'abc123',
});

const buildEntry = (overrides: Partial<{ html: string; ttlSec: number; lastGoodFetchedAt: Date }> = {}) => {
  const now = new Date();
  const ttlSec = overrides.ttlSec ?? 300;
  return {
    html: overrides.html ?? '<p>cached html</p>',
    fetchedAt: now,
    expiresAt: new Date(now.getTime() + ttlSec * 1000),
    result: { html: overrides.html ?? '<p>cached html</p>' },
    lastGoodFetchedAt: overrides.lastGoodFetchedAt,
  };
};

describe('MongoCacheStorage', () => {
  beforeEach(async () => {
    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    await PluginRenderCache.deleteMany({}).exec();
  });

  describe('get / set round-trip', () => {
    it('returns null on miss', async () => {
      const cache = buildCache();
      const result = await cache.get(buildKey());
      expect(result).toBeNull();
    });

    it('writes then reads back the same entry', async () => {
      const cache = buildCache();
      const key = buildKey();
      const entry = buildEntry({ html: '<a>x</a>' });
      await cache.set(key, entry);

      const got = await cache.get(key);
      expect(got).not.toBeNull();
      expect(got?.html).toBe('<a>x</a>');
      expect(got?.expiresAt.getTime()).toBe(entry.expiresAt.getTime());
    });

    it('upserts on set with the same key', async () => {
      const cache = buildCache();
      const key = buildKey();
      await cache.set(key, buildEntry({ html: 'first' }));
      await cache.set(key, buildEntry({ html: 'second' }));

      const got = await cache.get(key);
      expect(got?.html).toBe('second');

      // Verify only one doc exists for the key.
      const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
      const count = await PluginRenderCache.countDocuments({
        pluginName: key.pluginName,
        embedKey: key.embedKey,
      }).exec();
      expect(count).toBe(1);
    });

    it('treats a mismatched pluginCacheVersion as a miss', async () => {
      const cache = buildCache();
      const key = buildKey({ pluginCacheVersion: 1 });
      await cache.set(key, buildEntry());

      const got = await cache.get({ ...key, pluginCacheVersion: 2 });
      expect(got).toBeNull();
    });
  });

  describe('TTL handling', () => {
    it('returns expired entries to the caller (SWR wrapper decides freshness)', async () => {
      // get() does NOT filter on expiresAt — the SWR wrapper
      // (`cachedRender`) needs to see expired-but-within-stale-window
      // entries to serve them while a background re-render runs.
      // MongoDB's TTL monitor is the disk-reclaim safety net.
      const cache = buildCache();
      const key = buildKey();
      const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
      const now = new Date();
      await PluginRenderCache.create({
        pluginName: key.pluginName,
        pluginCacheVersion: key.pluginCacheVersion,
        pageId: new Types.ObjectId(key.pageId),
        embedKey: key.embedKey,
        html: 'expired',
        fetchedAt: new Date(now.getTime() - 600_000),
        expiresAt: new Date(now.getTime() - 1_000),
        result: { html: 'expired' },
      });

      const got = await cache.get(key);
      expect(got).not.toBeNull();
      expect(got?.html).toBe('expired');
      // The caller can compare `expiresAt` against `now` itself.
      expect(got!.expiresAt.getTime()).toBeLessThan(Date.now());
    });
  });

  describe('lastGoodFetchedAt', () => {
    it('round-trips a set lastGoodFetchedAt', async () => {
      const cache = buildCache();
      const key = buildKey();
      const lastGoodFetchedAt = new Date(Date.now() - 3_600_000);
      await cache.set(key, buildEntry({ lastGoodFetchedAt }));

      const got = await cache.get(key);
      expect(got?.lastGoodFetchedAt?.getTime()).toBe(lastGoodFetchedAt.getTime());
    });

    it('leaves lastGoodFetchedAt undefined when the entry omits it', async () => {
      const cache = buildCache();
      const key = buildKey();
      await cache.set(key, buildEntry());

      const got = await cache.get(key);
      expect(got?.lastGoodFetchedAt).toBeUndefined();
    });

    it('clears a previously-set lastGoodFetchedAt on a later write that omits it (degrade past stale-if-error)', async () => {
      const cache = buildCache();
      const key = buildKey();
      await cache.set(key, buildEntry({ lastGoodFetchedAt: new Date() }));
      expect((await cache.get(key))?.lastGoodFetchedAt).toBeDefined();

      await cache.set(key, buildEntry());
      const got = await cache.get(key);
      expect(got?.lastGoodFetchedAt).toBeUndefined();
    });
  });

  describe('invalidate*', () => {
    it('invalidatePage removes only entries for the given page', async () => {
      const cache = buildCache();
      const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
      const pageA = new Types.ObjectId().toHexString();
      const pageB = new Types.ObjectId().toHexString();
      await cache.set(buildKey({ pageId: pageA, embedKey: 'a' }), buildEntry());
      await cache.set(buildKey({ pageId: pageA, embedKey: 'b' }), buildEntry());
      await cache.set(buildKey({ pageId: pageB, embedKey: 'c' }), buildEntry());

      await cache.invalidatePage(pageA);

      const remainingA = await PluginRenderCache.countDocuments({ pageId: new Types.ObjectId(pageA) }).exec();
      const remainingB = await PluginRenderCache.countDocuments({ pageId: new Types.ObjectId(pageB) }).exec();
      expect(remainingA).toBe(0);
      expect(remainingB).toBe(1);
    });

    it('invalidatePlugin removes only entries for the given plugin', async () => {
      const cache = buildCache();
      const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
      const pageId = new Types.ObjectId().toHexString();
      await cache.set(buildKey({ pluginName: '@crowi/plugin-a', pageId, embedKey: '1' }), buildEntry());
      await cache.set(buildKey({ pluginName: '@crowi/plugin-b', pageId, embedKey: '1' }), buildEntry());

      await cache.invalidatePlugin('@crowi/plugin-a');

      const countA = await PluginRenderCache.countDocuments({ pluginName: '@crowi/plugin-a' }).exec();
      const countB = await PluginRenderCache.countDocuments({ pluginName: '@crowi/plugin-b' }).exec();
      expect(countA).toBe(0);
      expect(countB).toBe(1);
    });

    it('invalidateAll empties the collection', async () => {
      const cache = buildCache();
      const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
      const pageId = new Types.ObjectId().toHexString();
      await cache.set(buildKey({ pageId, embedKey: '1' }), buildEntry());
      await cache.set(buildKey({ pageId, embedKey: '2' }), buildEntry());

      await cache.invalidateAll();

      const count = await PluginRenderCache.countDocuments({}).exec();
      expect(count).toBe(0);
    });
  });

  describe('size limits', () => {
    it('refuses an entry larger than the per-entry reject threshold', async () => {
      const cache = buildCache();
      const key = buildKey();
      const tooLarge = 'x'.repeat(SINGLE_ENTRY_REJECT_BYTES + 1);
      const verdict = await cache.setOrReject(key, buildEntry({ html: tooLarge }));
      expect(verdict).toEqual({ reject: 'entry-too-large', structuredStripped: false });

      const got = await cache.get(key);
      expect(got).toBeNull();
      expect(silentLog.warn).toHaveBeenCalled();
    });

    it('warns at the warn threshold but still writes', async () => {
      const cache = buildCache();
      const key = buildKey();
      // 60KB — between warn (50KB) and reject (100KB).
      const html = 'y'.repeat(60 * 1024);
      const verdict = await cache.setOrReject(key, buildEntry({ html }));
      expect(verdict).toEqual({ reject: null, structuredStripped: false });
      const got = await cache.get(key);
      expect(got?.html.length).toBe(html.length);
      expect(silentLog.warn).toHaveBeenCalled();
    });

    it('refuses when per-page cumulative quota would be exceeded', async () => {
      const cache = buildCache();
      const pageId = new Types.ObjectId().toHexString();
      // Seed the page with ~9.95 MB across multiple entries (each just
      // under the per-entry warn threshold to avoid spamming warns).
      const chunkBytes = 49 * 1024;
      const chunkCount = Math.ceil((PER_PAGE_REJECT_BYTES - 100 * 1024) / chunkBytes);
      for (let i = 0; i < chunkCount; i++) {
        await cache.set(buildKey({ pageId, embedKey: `chunk-${i}` }), buildEntry({ html: 'z'.repeat(chunkBytes) }));
      }

      // Adding another 99KB entry now should push past the 10MB cap.
      const lastKey = buildKey({ pageId, embedKey: 'too-much' });
      const verdict = await cache.setOrReject(lastKey, buildEntry({ html: 'q'.repeat(99 * 1024) }));
      expect(verdict).toEqual({ reject: 'page-quota-exceeded', structuredStripped: false });

      const got = await cache.get(lastKey);
      expect(got).toBeNull();
    });
  });
});
