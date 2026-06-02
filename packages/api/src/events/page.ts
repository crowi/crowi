import Crowi from 'src/crowi';
import { EventEmitter } from 'node:events';
import Debug from 'debug';
import type { PageLike } from 'src/util/page-response';
import { indexPageInSearch, removePageFromSearch } from 'src/util/page-search-index';
import { autoWatchPage } from 'src/util/auto-watch';
import { STATUS_DELETED } from 'src/models/page';
import type { Types } from 'mongoose';

const debug = Debug('crowi:events:page');

const isPageLike = (value: unknown): value is PageLike => typeof value === 'object' && value !== null && '_id' in value;

const hasId = (value: unknown): value is { _id: Types.ObjectId } => typeof value === 'object' && value !== null && '_id' in value;

export default class PageEvent extends EventEmitter {
  public crowi: Crowi;

  constructor(crowi: Crowi) {
    super();
    this.crowi = crowi;
    // EventEmitter's `on(name, listener)` does not bind `this` for the
    // listener; pre-bind so `this.crowi` is reachable from inside.
    this.onCreate = this.onCreate.bind(this);
    this.onUpdate = this.onUpdate.bind(this);
    this.onDelete = this.onDelete.bind(this);
  }

  onCreate(savedPage: unknown, user: unknown) {
    this.registerBacklinks(savedPage);
    if (isPageLike(savedPage)) void indexPageInSearch(this.crowi, savedPage);
    this.autoWatch(savedPage, user);
  }

  // Page.updatePage's third arg is `bookmarkCount`; the fourth is the
  // `revisionCreated` flag (true only when the 'update' emit followed a
  // new body revision — see Page.updatePage / collab attach.ts). rename /
  // metadata-only 'update' emits omit it (falsy), so they don't notify.
  onUpdate(savedPage: unknown, user: unknown, _bookmarkCount?: unknown, revisionCreated?: unknown) {
    this.registerBacklinks(savedPage);
    if (isPageLike(savedPage)) void indexPageInSearch(this.crowi, savedPage);
    // Materialise the editor's WATCH row first, then fan out the UPDATE
    // notification: getNotificationTargetUsers excludes the actionUser, so
    // the editor never gets notified of their own save.
    this.autoWatch(savedPage, user);
    if (revisionCreated === true) this.notifyPageUpdate(savedPage, user);
  }

  // Hard delete (Page.completelyDeletePage). Soft delete flows through
  // 'update' with `status='deleted'` and is handled by indexPageInSearch.
  onDelete(savedPage: unknown, _user: unknown) {
    if (isPageLike(savedPage)) void removePageFromSearch(this.crowi, savedPage);
  }

  /**
   * feature-watch-autosubscribe — materialise a WATCH watcher row for the
   * acting user when they create a page or save a new revision. This is the
   * single fan-out point that covers BOTH save paths:
   *   - HTTP saves (`Page.createPage` / `Page.updatePage`), and
   *   - realtime collab saves (`collab/attach.ts` re-emits the same
   *     `crowi.event('Page').emit('update', pageDoc, userDoc, ...)`).
   *
   * Guards:
   *   - Soft delete flows through `update` with `status === 'deleted'`
   *     (via `Page.rename`). We must NOT auto-watch the user who deleted /
   *     renamed a page just because the event passes through here.
   *   - Best-effort: failures are swallowed (same posture as backlink /
   *     search indexing) — the comment handler is the only path that needs
   *     the result synchronously.
   */
  private autoWatch(savedPage: unknown, user: unknown) {
    if (!hasId(savedPage) || !hasId(user)) return;
    // Skip soft-delete / trash transitions; the deleter is not a participant.
    if ((savedPage as { status?: unknown }).status === STATUS_DELETED) return;

    const Watcher = this.crowi.model('Watcher');
    Promise.resolve()
      .then(() => autoWatchPage(Watcher, user._id, savedPage._id))
      .catch((err) => {
        debug('auto-watch: failed to upsert watcher', err);
      });
  }

  /**
   * feature-page-update-notification — create an UPDATE Activity when a page
   * body gets a new revision. The Activity.post('save') hook fans it out to
   * every WATCH watcher (minus IGNORE / the editor / inactive users), and
   * Notification.upsertByActivity collapses repeated / multi-editor updates
   * into one notification per recipient.
   *
   * Guards / posture mirror autoWatch:
   *   - Only invoked when the 'update' emit carried `revisionCreated === true`
   *     (Page.updatePage / collab save), so rename / metadata-only updates
   *     never reach here.
   *   - Skip soft-delete / trash transitions (status === 'deleted').
   *   - Best-effort: a failed Activity insert must not fail the save; the
   *     notification is simply dropped (same posture as backlink / search /
   *     auto-watch).
   */
  private notifyPageUpdate(savedPage: unknown, user: unknown) {
    if (!hasId(savedPage) || !hasId(user)) return;
    if ((savedPage as { status?: unknown }).status === STATUS_DELETED) return;

    const Activity = this.crowi.model('Activity');
    Promise.resolve()
      .then(() => Activity.createByPageUpdate(savedPage, user))
      .catch((err) => {
        debug('page-update-notification: failed to create UPDATE activity', err);
      });
  }

  private registerBacklinks(savedPage: unknown) {
    const Backlink = this.crowi.model('Backlink');
    Promise.resolve()
      .then(() => Backlink.createBySavedPage(savedPage))
      .catch((err) => {
        debug('backlink: failed to register backlink', err);
      });
  }
}
