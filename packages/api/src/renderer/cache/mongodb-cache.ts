import { Types } from 'mongoose';
import type { CacheEntry, CacheKey, CacheStorage, RenderResult } from '@crowi/plugin-api';
import type Crowi from 'src/crowi';
import type { PluginRenderCacheDocument, PluginRenderCacheModel } from 'src/models/plugin-render-cache';

/**
 * Per-entry warn threshold. Logged but not rejected.
 * RFC §"Size limits" — 50KB warn, 100KB reject.
 */
export const SINGLE_ENTRY_WARN_BYTES = 50 * 1024;
/** Per-entry reject threshold. Above this we drop the write and let the caller fall back to a placeholder. */
export const SINGLE_ENTRY_REJECT_BYTES = 100 * 1024;
/** Per-page cumulative reject threshold. */
export const PER_PAGE_REJECT_BYTES = 10 * 1024 * 1024;

/** Why a `set()` call rejected the entry. Surfaced to the SWR wrapper for placeholder fallback. */
export type CacheSetReject = 'entry-too-large' | 'page-quota-exceeded';

export interface MongoCacheStorageDeps {
  PluginRenderCache: PluginRenderCacheModel;
  /** Logger for size-limit warnings. The cache itself is plugin-agnostic. */
  log: {
    warn(msg: string, ...args: unknown[]): void;
    debug(msg: string, ...args: unknown[]): void;
  };
}

/**
 * MongoDB-backed implementation of `CacheStorage`. The schema +
 * indexes live in `models/plugin-render-cache.ts`; this class is the
 * thin query layer.
 *
 * Behaviour quirks worth noting:
 *
 *   - **TTL defence-in-depth.** MongoDB's TTL monitor sweeps every
 *     ~60s, so a row whose `expiresAt` just elapsed may still be on
 *     disk. `get()` checks `expiresAt < now` and treats the hit as a
 *     miss + deletes the row so the next read is fast.
 *
 *   - **`pluginCacheVersion` mismatch = miss.** Plugins bump their
 *     `cacheVersion` to invalidate every cached entry without an
 *     operator action. We don't actively delete stale-version rows
 *     (the TTL eventually does); we just refuse to return them.
 *
 *   - **Size limits.** `set()` rejects entries `> 100KB` and entries
 *     that would push the page over 10MB. Both rejections log a warn
 *     with `pluginName` + `pageId` and surface a `CacheSetReject`
 *     code via the `setOrReject` helper used by the SWR wrapper.
 *     Entries `> 50KB` but `< 100KB` warn but write.
 */
export class MongoCacheStorage implements CacheStorage {
  constructor(private readonly deps: MongoCacheStorageDeps) {}

  /**
   * Read an entry. Returns null only when:
   *   - row absent
   *   - `pluginCacheVersion` mismatch (version bump is a logical miss)
   *
   * **`expiresAt < now` is NOT treated as a miss here.** The SWR
   * wrapper (`cachedRender`) needs to see expired-but-within-stale-
   * window entries to serve them while a background re-render runs.
   * Entries past the SWR window are evicted by the wrapper itself
   * after the blocking re-render; MongoDB's TTL sweep is the
   * disk-reclaim safety net (RFC §"TTL index of operational note").
   */
  async get(key: CacheKey): Promise<CacheEntry | null> {
    const filter = {
      pageId: new Types.ObjectId(key.pageId),
      pluginName: key.pluginName,
      embedKey: key.embedKey,
      pluginCacheVersion: key.pluginCacheVersion,
    };
    const doc = await this.deps.PluginRenderCache.findOne(filter).lean<PluginRenderCacheDocument | null>().exec();
    if (!doc) return null;
    return {
      html: doc.html,
      result: doc.result,
      fetchedAt: doc.fetchedAt,
      expiresAt: doc.expiresAt,
      lastGoodFetchedAt: doc.lastGoodFetchedAt,
    };
  }

  /**
   * Write an entry, replacing any existing row with the same compound
   * key. Use `setOrReject` instead when callers need to know whether
   * the write was rejected by size limits.
   */
  async set(key: CacheKey, entry: CacheEntry): Promise<void> {
    await this.setOrReject(key, entry);
  }

  /**
   * Like `set` but returns the rejection reason instead of silently
   * dropping. Used by the SWR wrapper to fall back to a placeholder
   * when an oversized payload would otherwise vanish from the cache.
   */
  async setOrReject(key: CacheKey, entry: CacheEntry): Promise<CacheSetReject | null> {
    const html = entry.html;
    const htmlBytes = Buffer.byteLength(html, 'utf8');

    if (htmlBytes > SINGLE_ENTRY_REJECT_BYTES) {
      this.deps.log.warn(
        `[plugin-render-cache] entry too large; refusing to write. pluginName=${key.pluginName} pageId=${key.pageId} bytes=${htmlBytes} (limit=${SINGLE_ENTRY_REJECT_BYTES})`,
      );
      return 'entry-too-large';
    }
    if (htmlBytes > SINGLE_ENTRY_WARN_BYTES) {
      this.deps.log.warn(
        `[plugin-render-cache] entry exceeds warn threshold; writing anyway. pluginName=${key.pluginName} pageId=${key.pageId} bytes=${htmlBytes} (warn=${SINGLE_ENTRY_WARN_BYTES})`,
      );
    }

    // Per-page cumulative check. One aggregate computes the page-wide
    // total and the existing-entry-for-this-key bytes simultaneously,
    // so the projected total after the upsert can be checked in one
    // round-trip (plus the upsert itself). `htmlBytes` is denormalised
    // on the doc so the sum is a cheap `$sum: '$htmlBytes'` rather
    // than `$strLenBytes` over every cached HTML string.
    const pageId = new Types.ObjectId(key.pageId);
    const cumulative = await this.deps.PluginRenderCache.aggregate<{ totalBytes: number; existingBytes: number }>([
      { $match: { pageId } },
      {
        $group: {
          _id: null,
          totalBytes: { $sum: '$htmlBytes' },
          existingBytes: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$pluginName', key.pluginName] },
                    { $eq: ['$embedKey', key.embedKey] },
                    { $eq: ['$pluginCacheVersion', key.pluginCacheVersion] },
                  ],
                },
                '$htmlBytes',
                0,
              ],
            },
          },
        },
      },
    ]).exec();
    const { totalBytes = 0, existingBytes = 0 } = cumulative[0] ?? {};
    const projected = totalBytes - existingBytes + htmlBytes;
    if (projected > PER_PAGE_REJECT_BYTES) {
      this.deps.log.warn(
        `[plugin-render-cache] page would exceed cumulative quota; refusing to write. pluginName=${key.pluginName} pageId=${key.pageId} projectedBytes=${projected} (limit=${PER_PAGE_REJECT_BYTES})`,
      );
      return 'page-quota-exceeded';
    }

    // `lastGoodFetchedAt` is optional and, unlike every other field
    // here, can legitimately need to be CLEARED (a stale-if-error entry
    // degrading past `STALE_IF_ERROR_MAX_AGE_SEC` has no last-good left
    // to track) — `$set` with an `undefined` value would just leave a
    // stale prior value on the doc, so an absent one goes through
    // `$unset` instead.
    const update: { $set: Record<string, unknown>; $unset?: { lastGoodFetchedAt: '' } } = {
      $set: {
        pageId,
        pluginName: key.pluginName,
        embedKey: key.embedKey,
        pluginCacheVersion: key.pluginCacheVersion,
        html,
        htmlBytes,
        fetchedAt: entry.fetchedAt,
        expiresAt: entry.expiresAt,
        result: entry.result satisfies RenderResult,
      },
    };
    if (entry.lastGoodFetchedAt) {
      update.$set.lastGoodFetchedAt = entry.lastGoodFetchedAt;
    } else {
      update.$unset = { lastGoodFetchedAt: '' };
    }

    await this.deps.PluginRenderCache.updateOne(
      {
        pageId,
        pluginName: key.pluginName,
        embedKey: key.embedKey,
        pluginCacheVersion: key.pluginCacheVersion,
      },
      update,
      { upsert: true },
    ).exec();
    return null;
  }

  /** Drop every cached entry for a page. Returns the number of deleted rows. */
  async invalidatePage(pageId: string): Promise<number> {
    const res = await this.deps.PluginRenderCache.deleteMany({ pageId: new Types.ObjectId(pageId) }).exec();
    return res.deletedCount ?? 0;
  }

  /** Drop every cached entry written by a single plugin. Returns the number of deleted rows. */
  async invalidatePlugin(pluginName: string): Promise<number> {
    const res = await this.deps.PluginRenderCache.deleteMany({ pluginName }).exec();
    return res.deletedCount ?? 0;
  }

  /** Drop every cached entry. Returns the number of deleted rows. */
  async invalidateAll(): Promise<number> {
    const res = await this.deps.PluginRenderCache.deleteMany({}).exec();
    return res.deletedCount ?? 0;
  }
}

/** Convenience factory that pulls the model + a logger from a Crowi instance. */
export function createMongoCacheStorage(crowi: Crowi): MongoCacheStorage {
  const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
  return new MongoCacheStorage({
    PluginRenderCache,
    log: {
      warn: (msg, ...args) => console.warn(msg, ...args),
      debug: () => undefined,
    },
  });
}
