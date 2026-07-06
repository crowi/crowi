import Debug from 'debug';
import type Crowi from 'src/crowi';
import { STATUS_DELETED } from 'src/models/page';
import { type CommentChangedPayload, getPresenceService, type PageUpdatedPayload } from 'src/service/presence';

const debug = Debug('crowi:events:presence-broadcast');

/**
 * feature-live-page-content-sync (RFC-0003 §v2.1) — read-side
 * soft-refresh broadcast listener. Hooks into `pageEvent('update')` and,
 * for genuine new-body saves, fans a `page-updated` signal out through
 * the presence service to every viewer socket on the page so the reader
 * can swap the body in place without a full reload.
 *
 * Why a dedicated listener (not inside `PageEvent.onUpdate`): `PageEvent`
 * only holds `this.crowi` and reaches models via `this.crowi.model(...)`
 * — it has no handle on the presence service, which is resolved lazily
 * through `getPresenceService(crowi)` (returns a Promise). This mirrors
 * `events/render-cache.ts`, which likewise registers from
 * `Crowi.setupRenderer()` (the boot point where the renderer / lazy
 * services are available and where CLI mode is excluded) rather than
 * living in `events/page.ts`.
 *
 * Gating:
 *   - `revisionCreated === true` — only a new revision (REST
 *     `Page.updatePage` or a collab checkpoint) triggers a swap. Rename /
 *     metadata-only 'update' emits pass a falsy 4th arg and are ignored.
 *   - soft delete (`status === DELETED`) is excluded — it emits without
 *     `revisionCreated`, and delete-time signalling is out of scope.
 *
 * Failures are swallowed (best-effort, `trackSideEffect`) exactly like
 * render-cache: a presence fan-out problem must never block the save.
 */

/** Best-effort string coercion of a Mongo `_id`-like value. */
const toIdString = (value: unknown): string | null => {
  if (typeof value === 'string') return value;
  if (value != null) return String(value);
  return null;
};

interface SavedPageLike {
  _id?: unknown;
  status?: unknown;
  revision?: unknown;
}

interface EditorLike {
  _id?: unknown;
  name?: unknown;
  username?: unknown;
}

/**
 * The shape of a Comment document as emitted on `crowi.event('Comment')`.
 * `page` / `creator` are ObjectIds (or populated docs); `toIdString`
 * coerces either. `creator` is only read for the `'add'` path (the
 * comment author, used for self-suppression on the client).
 */
interface CommentLike {
  _id?: unknown;
  page?: unknown;
  creator?: unknown;
}

/**
 * Resolve the new revision's id from the emitted `savedPage.revision`.
 * `Page.updatePage` / the collab publisher emit with `revision`
 * populated to the full Revision document, but tolerate a bare ObjectId.
 */
const resolveRevisionId = (revision: unknown): string | null => {
  if (revision == null) return null;
  if (typeof revision === 'string') return revision;
  if (typeof revision === 'object' && '_id' in (revision as Record<string, unknown>)) {
    return toIdString((revision as { _id?: unknown })._id);
  }
  return toIdString(revision);
};

export function registerPresencePageBroadcast(crowi: Crowi): void {
  const pageEvent = crowi.event('Page');

  pageEvent.on('update', (savedPageRaw: unknown, userRaw: unknown, _bookmarkCount: unknown, revisionCreated: unknown) => {
    // Only a genuine new-body save fans out.
    if (revisionCreated !== true) return;

    const savedPage = (savedPageRaw ?? undefined) as SavedPageLike | undefined;
    if (!savedPage) return;

    // Defensive: a soft-delete transition emits with `status=DELETED` and
    // no `revisionCreated`, so it is already excluded above — skip it
    // explicitly too (mirrors render-cache / autoWatch).
    if (savedPage.status === STATUS_DELETED) return;

    const pageId = toIdString(savedPage._id);
    const revisionId = resolveRevisionId(savedPage.revision);
    if (!pageId || !revisionId) {
      debug('skip page-updated broadcast: unresolvable pageId/revisionId');
      return;
    }

    const user = (userRaw ?? undefined) as EditorLike | undefined;
    const editorUserId = toIdString(user?._id) ?? '';
    // Same identity source as `loadViewerIdentity` in presence/attach.ts.
    const editorDisplayName = (typeof user?.name === 'string' && user.name) || (typeof user?.username === 'string' && user.username) || '';

    const payload: PageUpdatedPayload = { pageId, revisionId, editorUserId, editorDisplayName };

    // Best-effort, non-blocking (includes the lazy `getPresenceService`
    // await). Never propagate a fan-out failure into the save path.
    crowi.trackSideEffect(
      getPresenceService(crowi)
        .then((service) => service.publishPageUpdated(pageId, payload))
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          debug('publishPageUpdated(%s) failed: %s', pageId, message);
        }),
    );
  });

  // feature-live-page-comment-sync — the sibling of the page-updated
  // fan-out above, but on the Comment event stream: a new comment
  // (`'add'`, emitted from the Comment post-save hook) or a deleted one
  // (`'remove'`, emitted from `Comment.removeCommentById`) fans a
  // `comment-changed` signal out to every viewer socket on the page so
  // the reader's comment list stays live. Best-effort / swallow, same as
  // the page-updated path — a fan-out problem must never break the
  // comment save / delete.
  const commentEvent = crowi.event('Comment');

  const publishCommentChanged = (pageId: string, payload: CommentChangedPayload): void => {
    crowi.trackSideEffect(
      getPresenceService(crowi)
        .then((service) => service.publishCommentChanged(pageId, payload))
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          debug('publishCommentChanged(%s) failed: %s', pageId, message);
        }),
    );
  };

  commentEvent.on('add', (savedCommentRaw: unknown) => {
    const comment = (savedCommentRaw ?? undefined) as CommentLike | undefined;
    if (!comment) return;
    const pageId = toIdString(comment.page);
    const commentId = toIdString(comment._id);
    if (!pageId || !commentId) {
      debug('skip comment-changed(added) broadcast: unresolvable pageId/commentId');
      return;
    }
    const actorUserId = toIdString(comment.creator) ?? undefined;
    publishCommentChanged(pageId, { pageId, changeType: 'added', commentId, actorUserId });
  });

  commentEvent.on('remove', (removedCommentRaw: unknown) => {
    // `removeCommentById` emits the pre-delete document (or null when the
    // id did not resolve) — guard both.
    const comment = (removedCommentRaw ?? undefined) as CommentLike | undefined;
    if (!comment) return;
    const pageId = toIdString(comment.page);
    const commentId = toIdString(comment._id);
    if (!pageId || !commentId) {
      debug('skip comment-changed(removed) broadcast: unresolvable pageId/commentId');
      return;
    }
    // No actorUserId on removal — the deleter is not known at the model
    // event layer, and a redundant re-fetch on the deleter's own client
    // is idempotent (spec §self-suppress).
    publishCommentChanged(pageId, { pageId, changeType: 'removed', commentId });
  });
}
