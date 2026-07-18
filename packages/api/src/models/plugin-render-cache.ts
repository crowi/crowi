import type Crowi from 'src/crowi';
import { type Document, type Model, Schema, type Types, model } from 'mongoose';
import type { RenderResult } from '@crowi/plugin-api';

/**
 * Persisted entry in the renderer plugin cache. One document per
 * `(pluginName, pluginCacheVersion, pageId, embedKey)` 4-tuple.
 *
 * Indexes (Phase 4 RFC §"MongoDB collection schema"):
 *   1. compound unique on the 4-tuple — the read/write key. Also
 *      covers `invalidatePage(pageId)` via its `pageId` prefix.
 *   2. TTL on `expiresAt` (`expireAfterSeconds: 0`) — MongoDB sweeps
 *      expired entries ~every 60s. The SWR wrapper handles freshness
 *      itself, so we do not pre-filter `expiresAt < now` on read.
 *   3. `pluginName` — supports `invalidatePlugin(name)`.
 *
 * `result` stores the plugin's full `RenderResult` so a read can
 * surface the same error placeholder + assets the original render
 * produced. `html` is duplicated for log/admin clarity (also in
 * `result.html`); `htmlBytes` is denormalised so the per-page quota
 * aggregate doesn't have to `$strLenBytes` over every cached HTML
 * string on every write. `lastGoodFetchedAt` backs the stale-if-error
 * policy (`packages/api/src/renderer/cache/index.ts`) — optional and
 * unset on rows written before that policy existed (no migration).
 */
export interface PluginRenderCacheDocument extends Document {
  _id: Types.ObjectId;
  pluginName: string;
  pluginCacheVersion: number;
  pageId: Types.ObjectId;
  embedKey: string;
  html: string;
  htmlBytes: number;
  fetchedAt: Date;
  expiresAt: Date;
  result: RenderResult;
  lastGoodFetchedAt?: Date;
}

export interface PluginRenderCacheModel extends Model<PluginRenderCacheDocument> {
  /** Plugin scope identifier for log messages / admin UI surfacing. */
  readonly modelName: 'PluginRenderCache';
}

export default (_crowi: Crowi) => {
  const PluginRenderCacheSchema = new Schema<PluginRenderCacheDocument, PluginRenderCacheModel>(
    {
      pluginName: { type: String, required: true },
      pluginCacheVersion: { type: Number, required: true },
      pageId: { type: Schema.Types.ObjectId, required: true, ref: 'Page' },
      embedKey: { type: String, required: true },
      html: { type: String, required: true, default: '' },
      // Denormalised byte length so the per-page quota aggregate avoids
      // `$strLenBytes` (which forces the whole html into the working
      // set) on every write.
      htmlBytes: { type: Number, required: true, default: 0 },
      fetchedAt: { type: Date, required: true, default: () => new Date() },
      expiresAt: { type: Date, required: true },
      // `RenderResult` is stored as a free-form sub-doc — Mongoose's
      // `Schema.Types.Mixed` lets us round-trip the plugin's exact
      // shape (html / assets / ttlSec / error).
      result: { type: Schema.Types.Mixed, required: true },
      // Optional — see `PluginRenderCacheDocument.lastGoodFetchedAt`.
      lastGoodFetchedAt: { type: Date, required: false },
    },
    {
      // No `createdAt` / `updatedAt` — `fetchedAt` already captures
      // the only timestamp we care about and `expiresAt` is the TTL
      // anchor. Skipping timestamps trims ~20 bytes per doc.
      timestamps: false,
    },
  );

  // (1) Compound unique on the read/write key.
  PluginRenderCacheSchema.index({ pageId: 1, pluginName: 1, embedKey: 1, pluginCacheVersion: 1 }, { unique: true, name: 'pluginRenderCache_key' });

  // (2) TTL — MongoDB removes docs whose `expiresAt` is in the past.
  // `expireAfterSeconds: 0` means "expire as soon as the date is past".
  PluginRenderCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'pluginRenderCache_ttl' });

  // (3) Plugin-scope invalidation lookup.
  PluginRenderCacheSchema.index({ pluginName: 1 }, { name: 'pluginRenderCache_pluginName' });

  // `invalidatePage(pageId)` is covered by index (1)'s `pageId` prefix
  // — no separate `{ pageId: 1 }` index is needed and the redundant
  // index would only widen write amplification on this hot collection.

  return model<PluginRenderCacheDocument, PluginRenderCacheModel>('PluginRenderCache', PluginRenderCacheSchema);
};
