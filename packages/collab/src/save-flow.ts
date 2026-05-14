import * as Y from 'yjs';
import Debug from 'debug';
import { Types } from 'mongoose';
import type { CollabModels } from './models';
import type { ContributorsTracker } from './contributors';
import type { CollabPageEventPublisher } from './types';
import { CONTENT_FIELD } from './yjs-doc';

const debug = Debug('crowi:collab:save');

/**
 * Discriminator for collab save errors. The Hocuspocus stateless
 * handler maps these to the `crowi:save-error` wire message so the
 * client can distinguish transient (DB_ERROR) from "don't retry"
 * (RENDERER_FAILED / PAGE_NOT_FOUND).
 */
export type CollabSaveErrorCode = 'RENDERER_FAILED' | 'DB_ERROR' | 'PAGE_NOT_FOUND' | 'USER_NOT_FOUND' | 'READONLY';

export class CollabSaveError extends Error {
  readonly code: CollabSaveErrorCode;
  constructor(code: CollabSaveErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'CollabSaveError';
  }
}

export interface ExecuteSaveInput {
  /** PageId being saved (Hocuspocus's `documentName`). */
  pageId: string;
  /** The user who triggered the save (from the connection's `context.userId`). */
  userId: string;
  /** Live Y.Doc the Hocuspocus session is editing. */
  document: Y.Doc;
  /** Optional checkpoint message — RFC-0003 §Phase 8 will expose this in the UI later. */
  message?: string;
}

export interface ExecuteSaveResult {
  revisionId: string;
}

export interface SaveFlow {
  executeSave(input: ExecuteSaveInput): Promise<ExecuteSaveResult>;
}

export interface CreateSaveFlowOptions {
  models: CollabModels;
  contributorsTracker: ContributorsTracker;
  pageEventPublisher: CollabPageEventPublisher;
}

/**
 * Build the collab-side save flow.
 *
 * Algorithm (RFC-0003 §Phase 5, user judgment C-2 "idempotent 2-step,
 * no transaction"):
 *
 *   1. Read the body from the Y.Doc (`doc.getText('content').toString()`).
 *      Y.Text is the single source of truth for collab; the resulting
 *      string is what `Revision.body` and the renderer pipeline see.
 *
 *   2. Look up the Page and the trigger User. Failures surface as
 *      typed `CollabSaveError`s so the on-stateless handler can wire
 *      them straight to the wire-level `crowi:save-error` message.
 *
 *   3. Drain the awareness-driven contributors set. We exclude the
 *      trigger user from the array — `Revision.savedBy` already
 *      points at that user, and the API doc cleanly separates "I
 *      triggered this save" from "I was around when it happened".
 *
 *   4. Build the new Revision via `Revision.prepareRevision`. The
 *      renderer pipeline runs here (core 5 transforms; plugin
 *      transforms not loaded in the collab process — see
 *      models.ts:registerRenderer). On renderer throw → 'RENDERER_FAILED'.
 *
 *   5. `Page.pushRevision` persists the Revision and updates
 *      `Page.{revision, lastUpdateUser, updatedAt}`. Existing helper —
 *      reused without modification.
 *
 *   6. `Page.updateOne` then sets the collab-specific pointer triplet
 *      (`currentRevision` + `yjsState` + `yjsCheckpointAt`). This is
 *      the second step of the **C-2 idempotent 2-step**: if step 5
 *      committed but step 6 didn't (crash between writes), the next
 *      `onLoadDocument` reads `page.currentRevision ?? page.revision`
 *      so the latest revision still wins; `yjsState` is rebuilt from
 *      the body. No data loss, no manual recovery.
 *
 *   7. Drop every pending `PageYjsUpdate` for the page — the new
 *      `yjsState` already captures everything, so leaving them around
 *      would just be re-applied as no-ops on the next load (Yjs CRDT
 *      idempotency keeps that safe, but it's wasted bandwidth).
 *
 *   8. Publish `crowi:pageEvent:update` so the api process re-runs
 *      backlinks / search indexing / mention dispatch / render-cache
 *      invalidation. Best-effort: a publish failure does not roll
 *      back the save. Operators recover stale indexes with the
 *      `renderer:rebuild` / `search:reindex` admin tools.
 *
 *   9. Return the new revision id to the caller (stateless handler
 *      sends `crowi:save-ok { revisionId }` to the client).
 */
export function createSaveFlow(opts: CreateSaveFlowOptions): SaveFlow {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Page = opts.models.Page as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Revision = opts.models.Revision as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const User = opts.models.User as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const PageYjsUpdate = opts.models.PageYjsUpdate as any;

  return {
    async executeSave({ pageId, userId, document, message }) {
      // Step 1: extract the markdown body from the live Y.Doc.
      const body = document.getText(CONTENT_FIELD).toString();

      // Step 2: locate page + user in parallel. Both queries are
      // independent; running them serially added ~1 RTT to every save.
      // `allSettled` lets us preserve the typed `PAGE_NOT_FOUND` /
      // `USER_NOT_FOUND` / `DB_ERROR` discrimination — `all` would
      // collapse a rejected Page into an opaque rejection.
      const [pageResult, userResult] = await Promise.allSettled([Page.findById(pageId).exec(), User.findById(userId).exec()]);
      if (pageResult.status === 'rejected') {
        throw new CollabSaveError('DB_ERROR', `Page.findById failed: ${(pageResult.reason as Error).message}`);
      }
      if (userResult.status === 'rejected') {
        throw new CollabSaveError('DB_ERROR', `User.findById failed: ${(userResult.reason as Error).message}`);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const page = pageResult.value as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const user = userResult.value as any;
      if (!page) {
        throw new CollabSaveError('PAGE_NOT_FOUND', `page ${pageId} not found`);
      }
      if (!user) {
        throw new CollabSaveError('USER_NOT_FOUND', `user ${userId} not found`);
      }

      // Step 3: contributors (awareness set, minus the trigger user).
      const allContributors = opts.contributorsTracker.drain(pageId);
      const userIdStr = String(user._id);
      const contributors: Types.ObjectId[] = [];
      for (const idStr of allContributors) {
        if (idStr === userIdStr) continue;
        try {
          contributors.push(new Types.ObjectId(idStr));
        } catch {
          // A malformed userId in the awareness state — drop silently.
          // Phase 7 (web) is responsible for setting valid ObjectIds;
          // logging here would be loud + actionable only for that team.
          debug('skipping malformed contributor id %s on page %s', idStr, pageId);
        }
      }

      // Step 4: build the new Revision (renderer runs in-line).
      const parentRevisionId = (page.currentRevision ?? page.revision ?? null) as Types.ObjectId | null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let newRevision: any;
      try {
        newRevision = await Revision.prepareRevision(page, body, user, {
          savedBy: user._id,
          contributors,
          message,
          type: 'snapshot',
          parentRevisionId,
        });
      } catch (err) {
        throw new CollabSaveError('RENDERER_FAILED', `renderer pipeline failed: ${(err as Error).message}`);
      }

      // Step 5: persist Revision + bump Page.revision pointer.
      try {
        await Page.pushRevision(page, newRevision, user);
      } catch (err) {
        throw new CollabSaveError('DB_ERROR', `Page.pushRevision failed: ${(err as Error).message}`);
      }

      // Step 6: collab-pointer write (currentRevision + yjsState + checkpoint).
      // C-2 idempotent 2-step: if this $set fails after step 5, the
      // next onLoadDocument still finds the latest revision via the
      // `currentRevision ?? revision` fallback and rebuilds yjsState
      // from the body. The compactor will re-write yjsState in the
      // next debounce window.
      try {
        const yjsStateBuf = Buffer.from(Y.encodeStateAsUpdate(document));
        await Page.updateOne(
          { _id: pageId },
          {
            $set: {
              currentRevision: newRevision._id,
              yjsState: yjsStateBuf,
              yjsCheckpointAt: new Date(),
            },
          },
        ).exec();
      } catch (err) {
        // Don't fail the save — the data is already consistent on
        // disk via step 5. Warn so an operator sees this in logs but
        // the client gets `crowi:save-ok`.
        console.warn(`[crowi:collab] save: collab-pointer write failed for page ${pageId}; recoverable on next load.`, (err as Error).message);
      }

      // Step 7: drop pending PageYjsUpdate rows (now folded into yjsState).
      try {
        await PageYjsUpdate.deleteMany({ pageId }).exec();
      } catch (err) {
        // Pending rows would harmlessly replay on next load. Warn + continue.
        console.warn(`[crowi:collab] save: PageYjsUpdate.deleteMany failed for page ${pageId}.`, (err as Error).message);
      }

      // Step 8: best-effort cross-process fan-out. publish() never
      // throws. `bookmarkCount` is intentionally omitted — collab
      // doesn't track bookmarks, and the api-side subscriber defaults
      // it to 0 (`payload.bookmarkCount ?? 0`) before emitting.
      await opts.pageEventPublisher.publish('update', {
        pageId,
        userId: userIdStr,
      });

      debug('save complete for page %s — revision=%s contributors=%d', pageId, newRevision._id, contributors.length);

      // Step 9: ack.
      return { revisionId: String(newRevision._id) };
    },
  };
}
