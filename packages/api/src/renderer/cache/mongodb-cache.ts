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
/** Per-page cumulative reject threshold (html budget — unchanged from Phase 4). */
export const PER_PAGE_REJECT_BYTES = 10 * 1024 * 1024;
/**
 * RFC-0023 (design doc §11) — per-page cumulative budget for
 * `result.structured` bytes, INDEPENDENT of the html budget (the
 * structured copy shares the same image bytes the html already embeds;
 * summing the two would newly reject entries that pass today with the
 * web output unchanged). Exceeding it strips `structured` from the
 * write (html still lands) — it never rejects the entry.
 */
export const PER_PAGE_STRUCTURED_REJECT_BYTES = 10 * 1024 * 1024;

/** Why a `set()` call rejected the entry. Surfaced to the SWR wrapper for placeholder fallback. */
export type CacheSetReject = 'entry-too-large' | 'page-quota-exceeded';

/**
 * RFC-0023 (design doc §11) — non-destructive verdict returned by
 * `setOrReject`. `reject` keeps the Phase 4 semantics (html-driven,
 * entry not written); `structuredStripped` reports that the entry WAS
 * written but with `result.structured` dropped (per-entry or per-page
 * structured budget). The storage never mutates the passed entry —
 * callers build the effective result from the verdict.
 */
export interface CacheSetVerdict {
  reject: CacheSetReject | null;
  structuredStripped: boolean;
}

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
   * Like `set` but returns a verdict instead of silently dropping.
   * Used by the SWR wrapper to fall back to a placeholder when an
   * oversized payload would otherwise vanish from the cache, and (RFC-
   * 0023 §11) to learn whether the structured payload was stripped.
   *
   * `html` and `structured` run through INDEPENDENT budgets:
   *   - `htmlBytes` per-entry / per-page gates are byte-identical to
   *     Phase 4 (a `structured`-carrying entry is never newly rejected
   *     because of its structured copy — the web output is unchanged).
   *   - `structuredBytes` exceeding `SINGLE_ENTRY_REJECT_BYTES` or the
   *     page-cumulative `PER_PAGE_STRUCTURED_REJECT_BYTES` strips just
   *     `result.structured` and writes an html-only entry.
   *
   * Never mutates `entry` (non-destructive contract, §11).
   */
  async setOrReject(key: CacheKey, entry: CacheEntry): Promise<CacheSetVerdict> {
    const html = entry.html;
    const htmlBytes = Buffer.byteLength(html, 'utf8');

    if (htmlBytes > SINGLE_ENTRY_REJECT_BYTES) {
      this.deps.log.warn(
        `[plugin-render-cache] entry too large; refusing to write. pluginName=${key.pluginName} pageId=${key.pageId} bytes=${htmlBytes} (limit=${SINGLE_ENTRY_REJECT_BYTES})`,
      );
      return { reject: 'entry-too-large', structuredStripped: false };
    }
    if (htmlBytes > SINGLE_ENTRY_WARN_BYTES) {
      this.deps.log.warn(
        `[plugin-render-cache] entry exceeds warn threshold; writing anyway. pluginName=${key.pluginName} pageId=${key.pageId} bytes=${htmlBytes} (warn=${SINGLE_ENTRY_WARN_BYTES})`,
      );
    }

    // Structured payload measurement. The `persistRenderResult` caller
    // already normalises pathological payloads, but `setOrReject` is
    // also reachable through the plugin-facing `set()` — so the
    // stringify is guarded here too (throwing `toJSON` / cycles strip
    // the payload rather than failing the write).
    let structured = entry.result.structured;
    let structuredBytes = 0;
    let structuredStripped = false;
    if (structured !== undefined) {
      try {
        structuredBytes = Buffer.byteLength(JSON.stringify(structured), 'utf8');
      } catch {
        this.deps.log.warn(`[plugin-render-cache] structured payload not serialisable; stripping. pluginName=${key.pluginName} pageId=${key.pageId}`);
        structured = undefined;
        structuredBytes = 0;
        structuredStripped = true;
      }
      if (structuredBytes > SINGLE_ENTRY_REJECT_BYTES) {
        this.deps.log.warn(
          `[plugin-render-cache] structured payload too large; stripping (html still written). pluginName=${key.pluginName} pageId=${key.pageId} bytes=${structuredBytes} (limit=${SINGLE_ENTRY_REJECT_BYTES})`,
        );
        structured = undefined;
        structuredBytes = 0;
        structuredStripped = true;
      }
    }

    // Per-page cumulative check. One aggregate computes the page-wide
    // totals (html + structured, two independent budgets) and the
    // existing-entry-for-this-key bytes simultaneously, so the
    // projected totals after the upsert can be checked in one
    // round-trip (plus the upsert itself). `htmlBytes` /
    // `structuredBytes` are denormalised on the doc so the sums stay
    // cheap `$sum`s.
    const pageId = new Types.ObjectId(key.pageId);
    const keyMatchesCond = {
      $and: [{ $eq: ['$pluginName', key.pluginName] }, { $eq: ['$embedKey', key.embedKey] }, { $eq: ['$pluginCacheVersion', key.pluginCacheVersion] }],
    };
    const cumulative = await this.deps.PluginRenderCache.aggregate<{
      totalBytes: number;
      existingBytes: number;
      totalStructuredBytes: number;
      existingStructuredBytes: number;
    }>([
      { $match: { pageId } },
      {
        $group: {
          _id: null,
          totalBytes: { $sum: '$htmlBytes' },
          existingBytes: { $sum: { $cond: [keyMatchesCond, '$htmlBytes', 0] } },
          // Pre-RFC-0023 rows have no `structuredBytes` — `$ifNull` keeps the sum defined.
          totalStructuredBytes: { $sum: { $ifNull: ['$structuredBytes', 0] } },
          existingStructuredBytes: { $sum: { $cond: [keyMatchesCond, { $ifNull: ['$structuredBytes', 0] }, 0] } },
        },
      },
    ]).exec();
    const { totalBytes = 0, existingBytes = 0, totalStructuredBytes = 0, existingStructuredBytes = 0 } = cumulative[0] ?? {};
    const projected = totalBytes - existingBytes + htmlBytes;
    if (projected > PER_PAGE_REJECT_BYTES) {
      this.deps.log.warn(
        `[plugin-render-cache] page would exceed cumulative quota; refusing to write. pluginName=${key.pluginName} pageId=${key.pageId} projectedBytes=${projected} (limit=${PER_PAGE_REJECT_BYTES})`,
      );
      return { reject: 'page-quota-exceeded', structuredStripped: false };
    }
    if (structured !== undefined) {
      const projectedStructured = totalStructuredBytes - existingStructuredBytes + structuredBytes;
      if (projectedStructured > PER_PAGE_STRUCTURED_REJECT_BYTES) {
        this.deps.log.warn(
          `[plugin-render-cache] page would exceed structured quota; stripping structured (html still written). pluginName=${key.pluginName} pageId=${key.pageId} projectedBytes=${projectedStructured} (limit=${PER_PAGE_STRUCTURED_REJECT_BYTES})`,
        );
        structured = undefined;
        structuredBytes = 0;
        structuredStripped = true;
      }
    }

    // Build the persisted `result` non-destructively: strip `structured`
    // into a copy when the verdict says so.
    const { structured: _rawStructured, ...resultRest } = entry.result;
    const persistedResult: RenderResult = structured !== undefined ? { ...resultRest, structured } : { ...resultRest };

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
        structuredBytes,
        fetchedAt: entry.fetchedAt,
        expiresAt: entry.expiresAt,
        result: persistedResult satisfies RenderResult,
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
    return { reject: null, structuredStripped };
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
