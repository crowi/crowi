import * as Y from 'yjs';
import Debug from 'debug';
import { Types } from 'mongoose';
import type { CollabModels } from './models';
import type { ContributorsTracker } from './contributors';
import type { CollabPageEventPublisher } from './types';
import type { DocBaseRevisionStore } from './doc-base-revision';
import { DRAFT_STATUS, PUBLISHED_STATUS } from './page-status';
import { CONTENT_FIELD } from './yjs-doc';
import { persistYjsState } from './persist-yjs-state';

const debug = Debug('crowi:collab:save');

/**
 * Discriminator for collab save errors. The Hocuspocus stateless
 * handler maps these to the `crowi:save-error` wire message so the
 * client can distinguish transient (DB_ERROR) from "don't retry"
 * (RENDERER_FAILED / PAGE_NOT_FOUND).
 *
 * `CONFLICT` is the editor-preview-reliability §1A optimistic-lock
 * rejection (round 2, Decision 1 — server-doc-based lock): the page's
 * live `currentRevision` diverged from the revision the SERVER's
 * Hocuspocus document was materialised from (an HTTP save or another
 * instance moved the pointer), so persisting this body would clobber a
 * newer revision. The client must reload, not retry. Multi-user
 * co-editing never trips this (all editors share the ONE server doc /
 * base, which advances on each successful save).
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
  /**
   * Round 2, Decision 1 — the server-doc save lock anchor. `onLoadDocument`
   * records the revision each materialised server doc was seeded from here;
   * `executeSave` reads it to detect divergence (an out-of-band save moved
   * `currentRevision`) and advances it on every successful save. Shared with
   * `createOnLoadDocument` so both sides agree on the doc's base.
   */
  docBaseRevisions: DocBaseRevisionStore;
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
 *   5. Persist the Revision (`newRevision.save()`), then ATOMICALLY bump
 *      BOTH page pointers in ONE conditional `updateOne`
 *      (`{ _id, currentRevision: docBase }` → `$set: { revision,
 *      currentRevision, lastUpdateUser, updatedAt }`). Round 2, Decision 1:
 *      `revision` (non-collab readers) and `currentRevision` (collab) can
 *      never diverge because a single conditional write sets both — there
 *      is exactly ONE pointer writer for the collab path. The filter is
 *      the server-doc lock: it matches only when `currentRevision` still
 *      equals the revision THIS server doc was materialised from
 *      (`docBaseRevisions.get(pageId)`); a non-match means an HTTP save /
 *      another instance moved the pointer underneath us, so we reject
 *      CONFLICT (the Revision we saved stays in history, unreferenced — no
 *      data loss, the client reloads). On success we advance the doc base
 *      to the revision we just created so the next save locks against it.
 *
 *   6. `Page.updateOne` then writes the collab-specific yjsState +
 *      yjsCheckpointAt via the `persistYjsState` chokepoint. This is the
 *      second step of the **C-2 idempotent 2-step**: if step 5 committed
 *      but step 6 didn't (crash between writes), the next `onLoadDocument`
 *      reads `page.currentRevision ?? page.revision` so the latest revision
 *      still wins; `yjsState` is rebuilt from the body. No data loss.
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
  const docBaseRevisions = opts.docBaseRevisions;

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

      // Step 2b: server-doc save lock (round 2, Decision 1). The lock is
      // anchored to the revision the SERVER's Hocuspocus document was
      // materialised from (recorded in `onLoadDocument`, advanced on every
      // successful save) — NOT to any individual client's pinned base. All
      // connected editors share the ONE server doc / base, so multi-user
      // co-editing never false-CONFLICTs (A saves → base advances → B saves
      // against the same advanced base → succeeds).
      //
      // The DIVERGENCE we must catch: an HTTP save (`Page.updatePage`) or
      // another instance moved `currentRevision` underneath this live doc.
      // The doc then descends from a now-superseded revision, so persisting
      // its body would clobber the newer one. The actual enforcement is the
      // CONDITIONAL pointer write at step 5 (`updateOne({ currentRevision:
      // docBase }, …)`): it can only land when the live pointer still equals
      // the doc base, so the lock is a true compare-and-set, not a TOCTOU
      // read-then-write. We surface the early read here only to fail fast
      // (and skip the renderer pipeline) on an obvious divergence.
      //
      // `docBase === undefined` means the doc was never loaded in THIS
      // process (e.g. a synthetic test driver, or a process that restarted
      // since load) — fall back to "no early check", and let the
      // conditional write at step 5 self-check against the live pointer it
      // reads now.
      const docBase = docBaseRevisions.get(pageId);
      const liveRevision = (page.currentRevision ?? page.revision ?? null) as { toString(): string } | null;
      const liveRevisionStr = liveRevision ? liveRevision.toString() : null;
      if (docBase !== undefined && docBase !== liveRevisionStr) {
        throw new CollabSaveError(
          'CONFLICT',
          `server doc for page ${pageId} was materialised from revision ${docBase ?? '(none)'} but the page is now at ` +
            `${liveRevisionStr ?? '(none)'} (an out-of-band save moved it); reload required`,
        );
      }

      // Decision 2 — anti-shrink is REMOVED from the save path entirely. A
      // user save is explicit intent (large deletions and full clears are
      // legitimate), already protected structurally by the client synced
      // gate (no unsynced save) + the server-doc lock above + the on-load
      // body-seed fallback (a stale/empty doc never materialises empty over
      // a non-empty body). So we ALLOW empty/shrunk bodies through.
      //
      // Decision 2 (C3) — the one safety requirement: the baseline /
      // verification read for the yjsState write must REJECT the save on a
      // read failure, never degrade to a no-op that lets an empty body
      // through. We read the previous body here; a DB error throws DB_ERROR
      // (the client retries) rather than committing blind. `null` is a
      // legitimate value (page had no revision yet / body genuinely empty)
      // and flows through — it is the THROW we guard against, not the null.
      let previousBody: string | null = null;
      if (liveRevision) {
        try {
          const prevRev = await Revision.findById(liveRevision).select('body').lean().exec();
          previousBody = typeof prevRev?.body === 'string' ? prevRev.body : null;
        } catch (err) {
          throw new CollabSaveError(
            'DB_ERROR',
            `failed to read previous revision body for page ${pageId} (cannot verify the save safely): ${(err as Error).message}`,
          );
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

      // Step 5a: persist the Revision document on its own.
      try {
        await newRevision.save();
      } catch (err) {
        throw new CollabSaveError('DB_ERROR', `Revision.save failed: ${(err as Error).message}`);
      }

      // Step 5b: ATOMIC pointer write (round 2, Decision 1 — fixes A1
      // split-brain). Bump BOTH `revision` (non-collab readers) AND
      // `currentRevision` (collab) in ONE conditional `updateOne`, so the
      // two pointers can never diverge — there is exactly one writer for the
      // collab path. The filter `{ _id, currentRevision: docBaseFilter }` is
      // the server-doc lock as a true compare-and-set: it lands only when
      // the live pointer still equals the revision THIS doc was materialised
      // from. A non-match means a concurrent / out-of-band save moved it
      // first → reject CONFLICT (the Revision we just saved stays in history,
      // unreferenced; the loser reloads, no data loss, A3: we never reach the
      // deleteMany / ack below). `lastUpdateUser` + `updatedAt` mirror the
      // fields `Page.pushRevision` used to set so non-collab readers see the
      // same metadata.
      //
      // `docBaseFilter`: when the doc base (= live pointer) is a real
      // revision id we match against it. When it is null (brand-new page, no
      // revision yet) we match `currentRevision: null` so a racing first save
      // still loses cleanly. A v1.x page with only `revision` set (no
      // `currentRevision`) is handled by matching `currentRevision: null`
      // too — its first collab save then sets both pointers, normalising it.
      const docBaseFilterValue = liveRevision && page.currentRevision != null ? (page.currentRevision as Types.ObjectId) : null;
      let pointerWrite: { matchedCount?: number } | null = null;
      try {
        pointerWrite = await Page.updateOne(
          { _id: pageId, currentRevision: docBaseFilterValue },
          {
            $set: {
              revision: newRevision._id,
              currentRevision: newRevision._id,
              lastUpdateUser: user._id,
              updatedAt: new Date(),
            },
          },
        ).exec();
      } catch (err) {
        throw new CollabSaveError('DB_ERROR', `Page pointer updateOne failed: ${(err as Error).message}`);
      }
      if ((pointerWrite?.matchedCount ?? 0) === 0) {
        // The lock failed: `currentRevision` moved between our read and this
        // write (a concurrent collab save, an HTTP save, or another
        // instance). Our Revision stays in history unreferenced; reject so
        // the client reloads. We do NOT prune PageYjsUpdate rows and do NOT
        // ack a non-committed revision (A3).
        throw new CollabSaveError('CONFLICT', `pointer compare-and-set for page ${pageId} did not match (currentRevision moved concurrently); reload required`);
      }

      // The save committed and is now the live pointer. Advance the doc base
      // so the NEXT save on this same server doc locks against the revision
      // we just created (otherwise the next save would see the live pointer
      // diverge from the still-old base and false-CONFLICT).
      docBaseRevisions.set(pageId, String(newRevision._id));

      // Step 6: collab yjsState mirror via the single chokepoint. Best-
      // effort — the data is already consistent on disk via step 5 (next
      // onLoadDocument rebuilds yjsState from the body if this fails). A
      // user save is explicit intent, so `allowShrink: true` bypasses the
      // ratio arm (Decision 2: large deletions / clears are legitimate);
      // `previousBody` is the read-verified baseline (C3 already rejected on
      // a read failure).
      try {
        await persistYjsState(Page, { pageId, document, baselineBody: previousBody, allowShrink: true, origin: 'save' });
      } catch (err) {
        console.warn(`[crowi:collab] save: yjsState write failed for page ${pageId}; recoverable on next load.`, (err as Error).message);
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
