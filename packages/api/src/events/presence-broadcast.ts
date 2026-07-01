import Debug from 'debug';
import type Crowi from 'src/crowi';
import { STATUS_DELETED } from 'src/models/page';
import { getPresenceService, type PageUpdatedPayload } from 'src/service/presence';

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
}
