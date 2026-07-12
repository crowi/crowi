import type { SearchableDoc } from '@crowi/plugin-api';
import type Crowi from 'src/crowi';
import { STATUS_DELETED, STATUS_DEPRECATED, STATUS_DRAFT, STATUS_WIP } from 'src/models/page';
import Debug from 'debug';
import { isPopulatedUser, toStringId } from './ts-rest-helpers';
import { type PageLike, isPopulatedRevision } from './page-response';

const debug = Debug('crowi:util:page-search-index');

/**
 * Status keep-set for the search index, mirrored against
 * `visiblePageStatusOr`'s list-visibility boundary (null / published /
 * own-draft) minus the always-excluded `draft` (search has no per-viewer
 * draft-author filter, unlike list). `deleted` / `wip` / `deprecated` are
 * all excluded from the index — see the `indexPageInSearch` doc comment.
 */
const isExcludedFromIndexByStatus = (status: string | null | undefined): boolean =>
  status === STATUS_DELETED || status === STATUS_DRAFT || status === STATUS_WIP || status === STATUS_DEPRECATED;

/**
 * Push a page into the active search driver after a save / rename.
 * Pages that have become redirects or `status='deleted'` are removed
 * from the index instead — mirrors `shouldIndex()` in the ES driver's
 * rebuild path.
 *
 * RFC-0004: `status='draft'` pages are likewise kept out of the index
 * — a draft is visible only to its author, and search results have no
 * per-viewer draft-author filter. When the author publishes (Phase 3),
 * the resulting `update` event re-runs this helper with
 * `status='published'` and the page is indexed normally.
 *
 * Fire-and-forget at the call site: the helper logs and swallows
 * errors so a search-cluster outage never breaks page CRUD.
 *
 * feature-restricted-grant-share-banner §"index 側の status 境界の整合" —
 * `wip` / `deprecated` pages are excluded from the index too (alongside
 * `deleted` / `draft` above), matching `visiblePageStatusOr`'s list-
 * visibility keep set (null / published / own-draft). Without this, the
 * search hydration's status drop (`hono/handlers/search.ts`) would turn
 * every already-indexed `wip` / `deprecated` page into a permanent dead
 * hit: returned by the driver, then always dropped, wasting a result slot
 * every time. This is an intentional, user-visible search-policy change —
 * search now matches list's visibility boundary for these statuses.
 */
export async function indexPageInSearch(crowi: Crowi, page: PageLike): Promise<void> {
  const searcher = crowi.getSearcher();
  if (!searcher) return;

  const id = toStringId(page._id);

  try {
    if (page.redirectTo || isExcludedFromIndexByStatus(page.status)) {
      await searcher.remove(id);
      return;
    }

    // The rename path emits 'update' with revision still as an
    // ObjectId ref, so refetch when the payload isn't already
    // carrying a populated revision body.
    const target = isPopulatedRevision(page.revision) ? page : await refetchPopulated(crowi, id);
    if (!target) {
      await searcher.remove(id);
      return;
    }
    if (target.redirectTo || isExcludedFromIndexByStatus(target.status)) {
      await searcher.remove(id);
      return;
    }
    if (!isPopulatedRevision(target.revision) || !target.revision.body) {
      debug('skip: no revision body for page %s', id);
      return;
    }

    const creator = isPopulatedUser(target.creator) ? target.creator : null;

    const doc: SearchableDoc = {
      id,
      path: target.path,
      body: target.revision.body,
      meta: {
        username: creator?.username,
        grant: target.grant,
        granted_users: (target.grantedUsers ?? []).map(toStringId),
        comment_count: target.commentCount ?? 0,
        like_count: target.liker?.length ?? 0,
        created_at: target.createdAt,
        updated_at: target.updatedAt,
      },
    };

    await searcher.index(doc);
  } catch (err) {
    debug('search index failed for page %s: %s', id, (err as Error).message);
  }
}

export async function removePageFromSearch(crowi: Crowi, page: PageLike): Promise<void> {
  const searcher = crowi.getSearcher();
  if (!searcher) return;

  const id = toStringId(page._id);
  try {
    await searcher.remove(id);
  } catch (err) {
    debug('search remove failed for page %s: %s', id, (err as Error).message);
  }
}

async function refetchPopulated(crowi: Crowi, id: string): Promise<PageLike | null> {
  const Page = crowi.model('Page');
  return (await Page.findById(id).populate('revision').populate('creator')) as PageLike | null;
}

/**
 * feature-restricted-grant-share-banner — reindex-by-id, for callers that
 * only have a page `_id` (not an in-hand `PageLike` snapshot) and want the
 * FRESH DB state indexed, not a possibly-already-stale in-memory one.
 * Three call sites share this: the claim handler (grant-on-first-access),
 * `setPageGrant` (grant reset invalidates link-invited co-editors), and
 * `deletePage`'s soft-delete branch (which — unlike hard delete — emits no
 * page event, so nothing else would ever remove the trashed page from the
 * index; see the corrected comment on `events/page.ts`'s `onDelete`).
 *
 * Re-reads via the same internal `refetchPopulated` that `indexPageInSearch`
 * itself falls back to, then delegates remove-or-index to
 * `indexPageInSearch` — so the same status/redirect exclusions above apply
 * here for free.
 *
 * MUST swallow every error itself (not just the ones `indexPageInSearch`
 * already swallows internally): every call site is a `void`-fire-and-
 * forget, and this function's own refetch + the "document is already gone"
 * remove branch below sit OUTSIDE of `indexPageInSearch`'s internal
 * try/catch. The api process installs no `unhandledRejection` handler, so
 * an uncaught rejection here would crash it on a transient Mongo/ES error.
 */
export async function indexPageInSearchById(crowi: Crowi, id: string): Promise<void> {
  try {
    const searcher = crowi.getSearcher();
    if (!searcher) return;

    const fresh = await refetchPopulated(crowi, id);
    if (!fresh) {
      await searcher.remove(id);
      return;
    }

    await indexPageInSearch(crowi, fresh);
  } catch (err) {
    debug('reindex-by-id failed for page %s: %s', id, (err as Error).message);
  }
}
