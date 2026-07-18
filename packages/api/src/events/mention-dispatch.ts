import Debug from 'debug';
import type { Types } from 'mongoose';
import type Crowi from 'src/crowi';
import type { ActivityDocument } from 'src/models/activity';
import type { RevisionDocument, RevisionMention } from 'src/models/revision';
import type { UserDocument } from 'src/models/user';
import ActivityDefine from 'src/util/activityDefine';

const debug = Debug('crowi:events:mention-dispatch');

interface PageLike {
  _id: Types.ObjectId | string;
  path?: string;
  revision?: Types.ObjectId | string | null;
}

interface UserLike {
  _id: Types.ObjectId | string;
}

/**
 * RFC-0002 Phase 8 mention dispatcher. Listens for `pageEvent('update')`
 * (the canonical post-save hook for both create and update — `createPage`
 * emits 'create' for backlink registration and 'update' is the broader
 * page-state-changed signal), then:
 *
 *   1. Loads the latest revision and reads `metadata.mentions[]`.
 *   2. Loads the previous revision (if any) for diff, so only **newly
 *      added** `@username` tokens trigger a notification — re-saving
 *      a page without changing mentions is a no-op.
 *   3. For each new mention: resolve to a User document, skip
 *      self-mention / inactive user / unknown username, then create
 *      an Activity (action MENTION) and a Notification directly for
 *      the single recipient via `Notification.upsertByActivity`.
 *
 * The `Activity.post('save')` hook for MENTION is intentionally a no-op
 * (see `models/activity.ts`) — a mention has exactly one recipient and
 * MUST NOT fan out to page watchers.
 *
 * Listener is fire-and-forget: failures are logged via console.warn so
 * the page save / event chain is never blocked. Mirrors Phase 4
 * `events/render-cache.ts` invalidation pattern.
 *
 * Registration happens from `Crowi.setupRenderer()` so that the renderer
 * (and Revision model) is available when the first save fires.
 */
export function registerMentionDispatch(crowi: Crowi): void {
  const pageEvent = crowi.event('Page');

  const handle = (savedPage: unknown, user: unknown) => {
    crowi.trackSideEffect(
      Promise.resolve()
        .then(() => {
          // Dispatch reads + writes several collections. Skip once the
          // connection is no longer `connected` so a side effect that
          // fired after teardown began only logs at debug rather than
          // throwing teardown-noise. Normal operation is unaffected.
          if (!crowi.isMongoConnected()) {
            debug('skip dispatch: mongo connection not connected');
            return;
          }
          return dispatchMentions(crowi, savedPage as PageLike | undefined, user as UserLike | undefined);
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          debug('dispatch failed: %s', message);
        }),
    );
  };

  // Subscribe to both 'create' (first save of a new page) and 'update'
  // (subsequent saves). Without 'create', a page created with @alice in
  // its initial body would never fire a notification — the diff vs. a
  // non-existent previous revision still resolves to "all mentions are
  // new" inside `dispatchMentions`, so the same handler works for both.
  pageEvent.on('create', handle);
  pageEvent.on('update', handle);
}

/**
 * Core dispatch routine. Exported for unit testing without going through
 * the EventEmitter — the listener path itself is intentionally minimal
 * (just a try/catch wrapper) so most of the logic lives here.
 */
export async function dispatchMentions(crowi: Crowi, savedPage: PageLike | undefined, user: UserLike | undefined): Promise<void> {
  if (!savedPage || !user) {
    debug('skip: missing savedPage or user');
    return;
  }
  const pageId = savedPage._id;
  const revisionId = savedPage.revision;
  if (!pageId || !revisionId) {
    debug('skip: savedPage missing _id or revision (page=%o)', pageId);
    return;
  }

  const Revision = crowi.model('Revision');
  const User = crowi.model('User');
  const Activity = crowi.model('Activity');
  const Notification = crowi.model('Notification');

  const currentRev = (await Revision.findById(revisionId).exec()) as RevisionDocument | null;
  if (!currentRev) {
    debug('skip: latest revision %s not found', revisionId);
    return;
  }

  const currentMentions = extractMentionUsernames(currentRev.meta?.mentions);
  if (currentMentions.size === 0) {
    return;
  }

  // Previous revision on the same page, keyed by the immutable `page` id
  // (DC-5 — see `RevisionDocument.page`; a `path` key could mix in an
  // unrelated page that later reused this path). `path` fallback only for
  // pre-migration rows without the field. First-save (no prior revision)
  // degrades to "all mentions are new", which is the desired semantics.
  // `select('meta')`: only `meta.mentions` is read — without it this
  // per-save findOne fetches the full body/renderedAst of the previous
  // revision just to throw it away.
  const notSelf = { _id: { $ne: currentRev._id } };
  const prevRevisionQuery = currentRev.page ? { page: currentRev.page, ...notSelf } : { path: currentRev.path, ...notSelf };
  const prevRev = (await Revision.findOne(prevRevisionQuery).sort({ createdAt: -1 }).select('meta').exec()) as RevisionDocument | null;
  const prevMentions = extractMentionUsernames(prevRev?.meta?.mentions);

  const newUsernames: string[] = [];
  for (const username of currentMentions) {
    if (!prevMentions.has(username)) {
      newUsernames.push(username);
    }
  }
  if (newUsernames.length === 0) {
    return;
  }

  const authorId = user._id;

  for (const username of newUsernames) {
    try {
      const mentionedUser = (await User.findOne({ username }).exec()) as UserDocument | null;
      if (!mentionedUser) {
        console.warn(`[crowi:mention-dispatch] unknown username '@${username}' on page ${String(pageId)} — skipping`);
        continue;
      }
      if (mentionedUser.status !== User.STATUS_ACTIVE) {
        debug('skip: user %s status %s != ACTIVE', username, mentionedUser.status);
        continue;
      }
      if (String(mentionedUser._id) === String(authorId)) {
        debug('skip: self-mention by %s', username);
        continue;
      }

      const activity = (await Activity.createByPageMention(savedPage, mentionedUser, { _id: authorId })) as ActivityDocument;
      await Notification.upsertByActivity(mentionedUser._id, activity);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[crowi:mention-dispatch] failed to dispatch mention for '@${username}': ${message}`);
    }
  }
}

function extractMentionUsernames(mentions: RevisionMention[] | undefined): Set<string> {
  const set = new Set<string>();
  if (!Array.isArray(mentions)) return set;
  for (const m of mentions) {
    if (m && typeof m.username === 'string' && m.username.length > 0) {
      set.add(m.username);
    }
  }
  return set;
}
