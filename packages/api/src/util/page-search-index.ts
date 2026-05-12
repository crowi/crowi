import type { SearchableDoc } from '@crowi/plugin-api';
import type Crowi from 'src/crowi';
import { STATUS_DELETED } from 'src/models/page';
import Debug from 'debug';
import { isPopulatedUser, toStringId } from './ts-rest-helpers';
import { type PageLike, isPopulatedRevision } from './page-response';

const debug = Debug('crowi:util:page-search-index');

/**
 * Push a page into the active search driver after a save / rename.
 * Pages that have become redirects or `status='deleted'` are removed
 * from the index instead — mirrors `shouldIndex()` in the ES driver's
 * rebuild path.
 *
 * Fire-and-forget at the call site: the helper logs and swallows
 * errors so a search-cluster outage never breaks page CRUD.
 */
export async function indexPageInSearch(crowi: Crowi, page: PageLike): Promise<void> {
  const searcher = crowi.getSearcher();
  if (!searcher) return;

  const id = toStringId(page._id);

  try {
    if (page.redirectTo || page.status === STATUS_DELETED) {
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
    if (target.redirectTo || target.status === STATUS_DELETED) {
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
