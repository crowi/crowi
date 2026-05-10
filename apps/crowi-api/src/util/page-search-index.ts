import type { SearchableDoc } from '@crowi/plugin-api';
import type Crowi from 'src/crowi';
import Debug from 'debug';

const debug = Debug('crowi:util:page-search-index');

interface PageLike {
  _id?: { toString: () => string } | string;
  path?: string;
  status?: string | null;
  redirectTo?: string | null;
  grant?: number;
  grantedUsers?: Array<{ toString: () => string } | string>;
  creator?: { username?: string } | { toString: () => string } | string | null;
  liker?: unknown[];
  commentCount?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

const pickId = (page: PageLike | string): string | null => {
  if (typeof page === 'string') return page;
  if (!page._id) return null;
  return typeof page._id === 'string' ? page._id : page._id.toString();
};

/**
 * Push a page into the active search driver after a save / rename.
 * Re-fetches the page with revision + creator populated so we always
 * forward a consistent body — the `pageEvent` payload may carry only
 * an ObjectId revision ref (renames don't repopulate). Pages that
 * have become redirects or `status='deleted'` are removed from the
 * index instead, mirroring the driver-level `shouldIndex` filter
 * used by `rebuild()`.
 *
 * Fire-and-forget at the call site: the helper logs and swallows
 * errors so a Redis / search-cluster hiccup never breaks page CRUD.
 */
export async function indexPageInSearch(crowi: Crowi, pageOrId: PageLike | string): Promise<void> {
  const searcher = crowi.getSearcher();
  if (!searcher) return;

  const id = pickId(pageOrId);
  if (!id) {
    debug('indexPageInSearch: no id resolvable from input, skipping');
    return;
  }

  try {
    const Page = crowi.model('Page');
    const populated = (await Page.findById(id).populate('revision').populate('creator')) as PageLike | null;

    if (!populated) {
      debug('page %s no longer exists, removing from index', id);
      if (typeof searcher.remove === 'function') await searcher.remove(id);
      return;
    }

    if (populated.redirectTo || populated.status === 'deleted') {
      debug('page %s is redirect or deleted, removing from index', id);
      if (typeof searcher.remove === 'function') await searcher.remove(id);
      return;
    }

    const revision = populated as unknown as { revision?: { body?: string } };
    const body = revision.revision?.body;
    if (body === undefined) {
      debug('page %s has no revision body, skipping index', id);
      return;
    }

    const grantedUsers = (populated.grantedUsers ?? []).map((u) => (typeof u === 'string' ? u : u.toString()));
    const creator = populated.creator;
    const username = creator && typeof creator === 'object' && 'username' in creator ? (creator as { username?: string }).username : undefined;

    const doc: SearchableDoc = {
      id,
      path: populated.path ?? '',
      body,
      meta: {
        username,
        grant: populated.grant,
        granted_users: grantedUsers,
        comment_count: populated.commentCount ?? 0,
        like_count: populated.liker?.length ?? 0,
        created_at: populated.createdAt,
        updated_at: populated.updatedAt,
      },
    };

    await searcher.index(doc);
  } catch (err) {
    debug('search index failed for page %s: %s', id, (err as Error).message);
  }
}

export async function removePageFromSearch(crowi: Crowi, pageOrId: PageLike | string): Promise<void> {
  const searcher = crowi.getSearcher();
  if (!searcher || typeof searcher.remove !== 'function') return;

  const id = pickId(pageOrId);
  if (!id) return;

  try {
    await searcher.remove(id);
  } catch (err) {
    debug('search remove failed for page %s: %s', id, (err as Error).message);
  }
}
