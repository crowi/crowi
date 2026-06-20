import * as Y from 'yjs';
import Debug from 'debug';
import { Types } from 'mongoose';
import type { CollabModels } from './models';
import type { ContributorsTracker } from './contributors';
import type { CollabPageEventPublisher } from './types';
import { DRAFT_STATUS, PUBLISHED_STATUS } from './page-status';
import { CONTENT_FIELD } from './yjs-doc';
import { evaluateAntiShrink } from './yjs-anti-shrink';

const debug = Debug('crowi:collab:save');

/**
 * Discriminator for collab save errors. The Hocuspocus stateless
 * handler maps these to the `crowi:save-error` wire message so the
 * client can distinguish transient (DB_ERROR) from "don't retry"
 * (RENDERER_FAILED / PAGE_NOT_FOUND).
 *
 * `CONFLICT` is the editor-preview-reliability §1A optimistic-lock
 * rejection: the save's `baseRevisionId` no longer matches the page's
 * live `currentRevision`, so persisting it would clobber a newer
 * revision (e.g. another save landed, or this doc was materialised from
 * a stale replica's `yjsState`). The client must reload, not retry.
 */
export type CollabSaveErrorCode = 'RENDERER_FAILED' | 'DB_ERROR' | 'PAGE_NOT_FOUND' | 'USER_NOT_FOUND' | 'READONLY' | 'CONFLICT';

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
  /**
   * editor-preview-reliability §1A: the revision the editing session
   * was seeded from (the page's `currentRevision` at wsToken-issue
   * time). When present and the page's live `currentRevision` has moved
   * on, the save is rejected with `CONFLICT`. Omitted / null disables
   * the check (no base known, or page has no revision yet).
   */
  baseRevisionId?: string | null;
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
 *   6b. publish-on-save (RFC-0005 Phase 1): if the page was a `draft`,
 *      flip `status` to `published`. Runs only after the save is
 *      durable (steps 5 + 6) so it is strictly additive — a failure
 *      is logged and swallowed, and the idempotent `status: 'draft'`-
 *      filtered `updateOne` retries cleanly on the next save.
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
    async executeSave({ pageId, userId, document, message, baseRevisionId }) {
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

      // Step 2b: optimistic lock (editor-preview-reliability §1A). The
      // client pinned `baseRevisionId` to the page's `currentRevision`
      // at session start (wsToken response). If the page's live
      // `currentRevision` has since moved on — another save landed, or
      // this Y.Doc was materialised from a stale replica's `yjsState`
      // that pre-dates the latest revision — persisting this body would
      // clobber the newer revision. Reject with `CONFLICT` so the
      // client reloads instead of overwriting (mirrors the HTTP save's
      // `revision_id` lock + `PageRevisionConflictError`).
      //
      // The check is skipped when no base is known (legacy client) or
      // when the page itself has no revision yet (`currentRevision` and
      // `revision` both unset) — there is nothing newer to clobber.
      const liveRevision = (page.currentRevision ?? page.revision ?? null) as { toString(): string } | null;
      if (baseRevisionId && liveRevision && liveRevision.toString() !== baseRevisionId) {
        throw new CollabSaveError(
          'CONFLICT',
          `save base revision ${baseRevisionId} is stale — page ${pageId} is now at revision ${liveRevision.toString()}; reload required`,
        );
      }

      // editor-preview-reliability §1B baseline: the body of the
      // revision this save REPLACES (the pre-save current revision), read
      // before step 5 bumps the pointer. The anti-shrink guard compares
      // the candidate yjsState against this so an empty / heavily-shrunk
      // doc can't silently overwrite the previously-persisted content.
      // Best-effort — a read failure degrades to "no baseline".
      let previousBody: string | null = null;
      if (liveRevision) {
        try {
          const prevRev = await Revision.findById(liveRevision).select('body').lean().exec();
          previousBody = typeof prevRev?.body === 'string' ? prevRev.body : null;
        } catch (err) {
          debug('failed to read previous revision body for anti-shrink baseline on page %s: %s', pageId, (err as Error).message);
        }
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
        // editor-preview-reliability §1B: never persist an empty /
        // catastrophically-shrunk yjsState over the previously-persisted
        // content. The baseline is the PREVIOUS revision's body (read
        // above, before the pointer moved): a desync that empties the
        // live doc would otherwise write an empty `[0,0]` snapshot that
        // a later load applies cleanly, masking the real body. The new
        // revision is already durable (steps 4-5), so we just suppress
        // the misleading yjsState and let the next load rebuild from the
        // body via `currentRevision`.
        const verdict = evaluateAntiShrink({ candidate: document, baselineBody: previousBody });
        if (!verdict.ok) {
          // Revision is already durable (steps 4-5). Skipping the
          // yjsState write is safe: the next onLoadDocument rebuilds
          // yjsState from the body via the `currentRevision` pointer we
          // still set below. Bump `currentRevision` so the rebuild reads
          // the body we just wrote, but leave the stale `yjsState`
          // intact rather than clobbering it with an empty snapshot.
          console.warn(
            `[crowi:collab] save: anti-shrink rejected yjsState write for page ${pageId} ` +
              `(reason=${verdict.reason}, candidate=${verdict.candidateChars} chars, baseline=${verdict.baselineChars} chars); ` +
              `repointing currentRevision and rebuilding yjsState from body on next load.`,
          );
          await Page.updateOne({ _id: pageId }, { $set: { currentRevision: newRevision._id, yjsState: null, yjsCheckpointAt: new Date() } }).exec();
        } else {
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
        }
      } catch (err) {
        // Don't fail the save — the data is already consistent on
        // disk via step 5. Warn so an operator sees this in logs but
        // the client gets `crowi:save-ok`.
        console.warn(`[crowi:collab] save: collab-pointer write failed for page ${pageId}; recoverable on next load.`, (err as Error).message);
      }

      // Step 6b: publish-on-save (RFC-0005 Phase 1). A `draft` page
      // transitions to `published` on its first successful save. The
      // save itself is already durable on disk (step 5 persisted the
      // Revision; step 6 wrote the collab pointer), so flipping the
      // status here is strictly additive — it never gates or rolls
      // back the save. A failure is logged and swallowed: the page
      // simply stays a draft and the *next* save retries the flip
      // (the transition is idempotent — `updateOne` filtered on
      // `status: DRAFT_STATUS` is a no-op once published). Already-
      // published pages match `page.status !== DRAFT_STATUS` and skip
      // the write entirely.
      if (page.status === DRAFT_STATUS) {
        try {
          await Page.updateOne({ _id: pageId, status: DRAFT_STATUS }, { $set: { status: PUBLISHED_STATUS } }).exec();
          debug('publish-on-save: page %s transitioned draft -> published', pageId);
        } catch (err) {
          // Recoverable on the next save — don't fail the save itself.
          console.warn(
            `[crowi:collab] save: publish-on-save status flip failed for page ${pageId}; page stays draft, retried on next save.`,
            (err as Error).message,
          );
        }
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
