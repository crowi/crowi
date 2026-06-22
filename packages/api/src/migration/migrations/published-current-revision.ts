import { STATUS_PUBLISHED } from 'src/models/page';
import type { MigrationContext } from '../types';

/**
 * Shared "walk every published page's current revision" helper for the
 * preflight migrations that have to project a revision field (no index on
 * `meta.toc.text` / `revision.body`, so an index-backed O(1) probe is
 * impossible — matches `wikilink-format`'s accepted tradeoff). It exists so the
 * walk skeleton + the page→revision pairing are defined once and cannot drift
 * between `isPending` (early-stop verdict) and `detect`/stage (full scan).
 *
 * Streaming + batching:
 *   - streams the published-page collection projecting only `_id revision`
 *     (`status: published` or legacy `null`, treated as published — trash /
 *     deprecated pages are read-only fixtures and out of scope), and
 *   - batch-fetches the paired current revisions with a single
 *     `Revision.find({ _id: { $in: batch } })` per `batchSize` pages instead of
 *     one `findById` per page (eliminates the per-page N+1).
 *
 * Early stop: `visit` may return `STOP` to abort the walk at the first hit, so
 * `isPending` can short-circuit without reading every page.
 *
 * NOTE: `wikilink-format` predates this helper and keeps its own copy on
 * purpose (its tests pin the existing walk); it can adopt this later.
 */

/** Sentinel a `visit` callback returns to abort the walk early. */
export const STOP = Symbol('stop-walk');

/** Page projection: only the fields the pairing needs. */
interface PageRow {
  _id: unknown;
  revision?: unknown;
}

/** A current revision, with the `select(projection)` fields plus its page. */
export interface RevisionVisit {
  /** The projected revision fields (`select`-ed by `projection`). */
  revision: Record<string, unknown>;
  /** The owning page's `_id`, as a string. */
  pageId: string;
}

export interface WalkOptions {
  /**
   * Mongoose `.select(...)` projection string for the revision fetch
   * (e.g. `'meta.toc'`, `'body'`). `_id` is always available on the result.
   */
  projection: string;
  /** Pages per `$in` revision batch. Defaults to 200. */
  batchSize?: number;
}

const DEFAULT_BATCH_SIZE = 200;

/**
 * Stream published pages, batch-fetch their current revisions with the given
 * projection, and invoke `visit(revision)` for each. Returning `STOP` from
 * `visit` aborts the walk immediately.
 */
export async function forEachPublishedCurrentRevision(
  ctx: MigrationContext,
  options: WalkOptions,
  visit: (entry: RevisionVisit) => typeof STOP | void | Promise<typeof STOP | void>,
): Promise<void> {
  const Page = ctx.crowi.model('Page');
  const Revision = ctx.crowi.model('Revision');
  const projection = options.projection;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  const cursor = Page.find({ $or: [{ status: STATUS_PUBLISHED }, { status: null }] })
    .select('_id revision')
    .lean()
    .cursor();

  // Buffer of pages whose current revision still needs fetching.
  let batch: PageRow[] = [];

  // Fetch the batch's revisions in one `$in` round-trip and pair each back to
  // its page (preserving page order). Returns STOP if `visit` asked to abort.
  const flush = async (): Promise<typeof STOP | void> => {
    if (batch.length === 0) return;
    const ids = batch.map((p) => p.revision);
    const revisions = await Revision.find({ _id: { $in: ids } })
      .select(projection)
      .lean()
      .exec();
    const byId = new Map<string, Record<string, unknown>>();
    for (const rev of revisions as { _id?: unknown }[]) {
      if (rev?._id != null) byId.set(String(rev._id), rev as Record<string, unknown>);
    }
    const pages = batch;
    batch = [];
    for (const page of pages) {
      const revision = byId.get(String(page.revision));
      if (!revision) continue;
      const result = await visit({ revision, pageId: String(page._id) });
      if (result === STOP) return STOP;
    }
  };

  try {
    for await (const raw of cursor) {
      const page = raw as PageRow;
      if (!page.revision) continue;
      batch.push(page);
      if (batch.length >= batchSize) {
        if ((await flush()) === STOP) return;
      }
    }
    await flush();
  } finally {
    await cursor.close();
  }
}
