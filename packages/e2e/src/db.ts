import { type Db, MongoClient, ObjectId } from 'mongodb';
import { E2E_DB_NAME, E2E_MONGO_URI } from './config';

export function databaseNameFromMongoUri(uri: string): string {
  const parsed = new URL(uri);
  const name = parsed.pathname.replace(/^\//, '').split('?')[0];
  return decodeURIComponent(name);
}

export function assertE2eDatabaseName(uri: string): void {
  const dbName = databaseNameFromMongoUri(uri);
  if (dbName !== E2E_DB_NAME) {
    throw new Error(`Refusing to drop MongoDB database '${dbName || '(empty)'}'. The E2E database must be exactly '${E2E_DB_NAME}'.`);
  }
}

/** Open a short-lived connection to the E2E mongo, hand `fn` the `Db`, and always close the client afterwards. */
async function withE2eDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const client = new MongoClient(E2E_MONGO_URI, { serverSelectionTimeoutMS: 3_000 });
  try {
    await client.connect();
    return await fn(client.db(databaseNameFromMongoUri(E2E_MONGO_URI)));
  } finally {
    await client.close();
  }
}

export async function dropE2eDatabase(): Promise<void> {
  assertE2eDatabaseName(E2E_MONGO_URI);

  await withE2eDb((db) => db.dropDatabase());
}

/**
 * Count `PluginRenderCache` rows (Mongoose collection name
 * `pluginrendercaches`) for a given `pageId` + `pluginName`.
 * feature-renderer-plugin-boundary Phase 2 — `renderer-plugins.spec.ts`
 * asserts a real PlantUML/Mermaid save actually writes a cache row (spec
 * §9), and that a subsequent forced-stale re-read (`forceStaleRendererVersion`
 * below) does not duplicate it. See `getPluginRenderCacheFetchedAt` for why
 * this alone cannot prove a cache HIT occurred.
 */
export async function countPluginRenderCacheRows(pageId: string, pluginName: string): Promise<number> {
  return withE2eDb((db) => db.collection('pluginrendercaches').countDocuments({ pageId: new ObjectId(pageId), pluginName }));
}

/**
 * Read a single `PluginRenderCache` row's `fetchedAt` for a given
 * `pageId` + `pluginName` (or `null` if no row exists yet).
 * feature-renderer-plugin-boundary Phase 2 — `renderer-plugins.spec.ts`
 * compares this across two render passes for the SAME page/content: an
 * unchanged `fetchedAt` proves the second pass hit the cache and skipped
 * calling the plugin's real `render()` again — a genuine miss/re-render
 * always rewrites `fetchedAt` to a strictly later `Date`
 * (`packages/api/src/renderer/cache/index.ts`'s `persistRenderResult`).
 * `countPluginRenderCacheRows` alone cannot distinguish hit from miss
 * here: both write to the SAME upserted row (identical 4-tuple cache
 * key), so the row count stays 1 either way.
 */
export async function getPluginRenderCacheFetchedAt(pageId: string, pluginName: string): Promise<Date | null> {
  const doc = await withE2eDb((db) =>
    db.collection('pluginrendercaches').findOne<{ fetchedAt: Date }>({ pageId: new ObjectId(pageId), pluginName }, { projection: { fetchedAt: 1 } }),
  );
  return doc?.fetchedAt ?? null;
}

/**
 * Directly corrupt a page's current revision's `rendererVersion`
 * (Mongoose collection `revisions`, field `page` holds the owning page's
 * `_id` — `packages/api/src/models/revision.ts`) to a value that can
 * never match the running pipeline's `RENDERER_PIPELINE_VERSION`
 * (`packages/api/src/renderer/version.ts`).
 *
 * feature-renderer-plugin-boundary Phase 2 — forces the next
 * `GET /api/v2/pages` to treat the stored `renderedAst` as stale and fall
 * back to an on-the-fly `runRender(mode: 'read', pageId, ...)`
 * (`computeRevisionRenderArtifactsAsync`,
 * `packages/api/src/util/page-response.ts`) — the SAME
 * `PluginRenderCache`-backed dispatch a save uses (`pipeline.ts`'s
 * `dispatch.pageId` branch), deterministically and without ever emitting
 * `pageEvent('update', ...)` (a plain GET never does), so there is no race
 * with the render-cache invalidation listener
 * (`packages/api/src/events/render-cache.ts`) the way re-saving the page
 * (a real revision UPDATE) would have.
 */
export async function forceStaleRendererVersion(pageId: string): Promise<void> {
  await withE2eDb((db) => db.collection('revisions').updateOne({ page: new ObjectId(pageId) }, { $set: { rendererVersion: 'e2e-forced-stale' } }));
}
