import Debug from 'debug';
import { Types } from 'mongoose';
import * as Y from 'yjs';
import type { ContributorsTracker } from './contributors';
import type { DocBaseRevisionStore } from './doc-base-revision';
import type { DocEpochStore } from './doc-epoch';
import type { CollabContentSequenceAllocator, CollabDraftPublisher, CollabModels } from './models';
import { DELETED_STATUS, DRAFT_STATUS, PUBLISHED_STATUS } from './page-status';
import { persistYjsState } from './persist-yjs-state';
import type { CollabPageEventPublisher } from './types';
import { CONTENT_FIELD } from './yjs-doc';

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
  /**
   * RFC-0017 Phase 1 §4.1/AC-1..8 — the collab lifecycle epoch anchor, read
   * (not written) here: `executeSave`'s atomic CAS folds
   * `collabLifecycleVersion: expectedEpoch` alongside the existing
   * `{ _id, currentRevision }` server-doc lock, using the epoch
   * `onLoadDocument` recorded for this doc (`doc-epoch.ts`). Optional —
   * when absent, or the doc was never loaded in THIS process, the epoch
   * predicate is omitted and the CAS degrades to the pre-RFC-0017
   * `{ _id, currentRevision }` + `status` predicate (AC-7: fail-safe, not a
   * bypass — a process that never recorded an epoch cannot forge a
   * MATCHING stale one either).
   */
  docEpochRevisions?: DocEpochStore;
  /**
   * RFC-0021 §D-7 (Phase 2a) — assigns the saved Revision's content
   * sequence. Optional: unset (the default, e.g. every pre-Phase-2a test
   * config) means collab never allocates one, unchanged from before this
   * option existed.
   */
  contentSequenceAllocator?: CollabContentSequenceAllocator;
  /**
   * RFC-0021 §6.3/DC-6 (Phase 2c-1) — the api-side `publishDraftPage`
   * command, injected the same way `contentSequenceAllocator` is. Optional:
   * unset (every pre-Phase-2c-1 test config, and any standalone collab
   * setup) falls back to the inline `updateOne` step 6b already ran before
   * this option existed — behaviour is byte-for-byte unchanged.
   */
  draftPublisher?: CollabDraftPublisher;
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
/**
 * G2 — attempt to coalesce a CAS-loser into the same-process winner.
 *
 * Returns `{ winnerRevisionId }` when ALL coalesce conditions hold (a
 * same-process collab save won AND its body is byte-identical to the loser's
 * body), `null` otherwise (the caller then keeps the CONFLICT).
 *
 * The contributors $addToSet is strictly best-effort: a failure to record
 * the loser as a contributor must NEVER turn a coalesced save-ok back into a
 * failure (the winner's revision is already canonical), so we swallow it.
 */
/**
 * G2 (hardening) — number of micro-retries after a CAS miss before we settle
 * on CONFLICT, and the delay between them. A same-process winner advances the
 * doc base in a `docBaseRevisions.set(...)` that runs in its own continuation;
 * a loser that lost the CAS a few microticks earlier can observe the page's
 * NEW `currentRevision` while the base still holds the stale value, so a single
 * coalesce probe would read condition 1 as failed and false-CONFLICT. Re-
 * probing a handful of times across a few tens of ms lets the winner's
 * continuation land. Cheap (read-only re-reads) and strictly bounded so a
 * genuine external divergence still settles to CONFLICT promptly.
 */
const COALESCE_MICRO_RETRIES = 5;
const COALESCE_MICRO_RETRY_MS = 8;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function tryCoalesce(args: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Page: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Revision: any;
  docBaseRevisions: DocBaseRevisionStore;
  pageId: string;
  loserBody: string;
  loserUserId: Types.ObjectId;
}): Promise<{ winnerRevisionId: string } | null> {
  const { Page, Revision, docBaseRevisions, pageId, loserBody, loserUserId } = args;

  // Re-read the page's live pointer (the winner just moved it).
  let freshPage: { currentRevision?: { toString(): string } | null } | null;
  try {
    freshPage = await Page.findById(pageId).select('currentRevision').lean().exec();
  } catch (err) {
    // A read failure here just means "we couldn't prove a coalesce" — fall
    // back to CONFLICT (safe: the client reloads).
    debug('coalesce: re-read of page %s failed: %s', pageId, (err as Error).message);
    return null;
  }
  const liveRevisionId = freshPage?.currentRevision ? freshPage.currentRevision.toString() : null;
  if (!liveRevisionId) return null;

  // Condition 1 — the IN-PROCESS doc base advanced to the live pointer. A
  // same-process collab save advances the base to the revision it created
  // (and that revision is now the live `currentRevision`); an out-of-band
  // move (HTTP / other instance / CLI) never touches the in-process base, so
  // it still holds our stale value and this check fails → CONFLICT.
  const advancedBase = docBaseRevisions.get(pageId);
  if (advancedBase !== liveRevisionId) {
    debug(
      'coalesce: doc base (%s) did not advance to live revision (%s) for page %s — not a same-process save',
      advancedBase ?? '(none)',
      liveRevisionId,
      pageId,
    );
    return null;
  }

  // Condition 2 — the winner's body is byte-identical to ours.
  let winnerRevision: { body?: string } | null;
  try {
    winnerRevision = await Revision.findById(liveRevisionId).select('body').lean().exec();
  } catch (err) {
    debug('coalesce: winner revision %s body read failed: %s', liveRevisionId, (err as Error).message);
    return null;
  }
  if (!winnerRevision || typeof winnerRevision.body !== 'string' || winnerRevision.body !== loserBody) {
    debug('coalesce: winner body differs from loser body for page %s — keeping CONFLICT', pageId);
    return null;
  }

  // Both conditions hold — coalesce. Best-effort: fold the loser's trigger
  // user into the winner's contributors (a co-editor who pressed save at the
  // same instant). A failure must not undo the coalesce.
  try {
    await Revision.updateOne({ _id: liveRevisionId }, { $addToSet: { contributors: loserUserId } }).exec();
  } catch (err) {
    console.warn(`[crowi:collab] save: coalesce $addToSet contributors failed for revision ${liveRevisionId}; save still ok.`, (err as Error).message);
  }

  return { winnerRevisionId: liveRevisionId };
}

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
  const docEpochRevisions = opts.docEpochRevisions;
  const contentSequenceAllocator = opts.contentSequenceAllocator;
  const draftPublisher = opts.draftPublisher;

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
      // C3 (round 3) — the save path NO LONGER reads the previous revision
      // body. That read existed only to feed `persistYjsState(..., baselineBody)`,
      // but the save always passes `allowShrink: true`, and `evaluateAntiShrink`
      // returns `ok: true` on `allowShrink` BEFORE it ever consults
      // `baselineBody` — so the value was discarded. The only thing the read
      // could still do was turn a transient `Revision.findById` failure into a
      // spurious DB_ERROR that rejected an otherwise-valid save (an extra DB
      // round-trip with no compensating safety). Empty-overwrite is already
      // blocked structurally (the Revision `body` is required + the client
      // synced gate), so we drop the read entirely.

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
      // RFC-0017 Phase 1 §4.1/AC-1..8 — fold the collab lifecycle epoch +
      // deleted-status guard into the SAME atomic CAS. `expectedEpoch` is
      // this process's `onLoadDocument`-recorded epoch for this doc
      // (`undefined` when never loaded here — the predicate is then omitted,
      // AC-7 fail-safe fallback). `status` is ALWAYS filtered regardless
      // (AC-3: belt-and-suspenders for legacy rows / an unknown epoch).
      //
      // AC-1 (rename case, load-bearing): rename doesn't touch
      // `currentRevision`, so `docBaseFilterValue` still matches — the epoch
      // predicate is the ONLY thing that rejects a stale post-rename save.
      const expectedEpoch = docEpochRevisions?.get(pageId);
      const pointerFilter: Record<string, unknown> = { _id: pageId, currentRevision: docBaseFilterValue, status: { $ne: DELETED_STATUS } };
      if (expectedEpoch !== undefined) {
        pointerFilter.collabLifecycleVersion = expectedEpoch;
      }
      let pointerWrite: { matchedCount?: number } | null = null;
      try {
        pointerWrite = await Page.updateOne(pointerFilter, {
          $set: {
            revision: newRevision._id,
            currentRevision: newRevision._id,
            lastUpdateUser: user._id,
            updatedAt: new Date(),
          },
        }).exec();
      } catch (err) {
        throw new CollabSaveError('DB_ERROR', `Page pointer updateOne failed: ${(err as Error).message}`);
      }
      if ((pointerWrite?.matchedCount ?? 0) === 0) {
        // The lock failed: `currentRevision` moved between our read and this
        // write. The mover is one of:
        //   (i)  a concurrent SAME-PROCESS collab save on the SAME shared
        //        server doc (two `executeSave` both read docBase=R1, both
        //        prepared a Revision, the CAS let one win); or
        //   (ii) an out-of-band move (an HTTP `Page.updatePage`, another
        //        instance, an admin-CLI DB edit).
        //
        // G2 — conditional coalesce. Case (i) is a SPURIOUS conflict: both
        // saves carried the SAME body (they edited the same live doc, and a
        // save snapshots the doc's current text), so the winner already
        // persisted exactly what this loser would have. Forcing the loser to
        // reload contradicts "co-editing never false-CONFLICTs". So we
        // coalesce — return the WINNER's revisionId as save-ok — ONLY when
        // BOTH hold; otherwise we keep the CONFLICT (case (ii), where the
        // winning body may differ and a reload is genuinely required):
        //
        //   1. the doc base advanced to the page's NEW live `currentRevision`
        //      (proves a same-process collab save won — `executeSave`
        //      advances the base on success; an out-of-band move does NOT
        //      touch the in-process base, so it stays at our stale value);
        //   2. the new `currentRevision`'s body EXACTLY equals the body we
        //      were about to persist.
        //
        // The loser's just-saved Revision stays in history, unreferenced
        // (tolerated — the orphan already occurred today). We do NOT move the
        // pointer, persist yjsState, or prune PageYjsUpdate rows: the winner
        // already owns all of that. Best-effort: fold the loser's trigger
        // user into the winner's `contributors` (metadata only).
        // G2 micro-retry — re-probe a bounded handful of times (re-reading
        // `currentRevision` + `docBaseRevisions` each pass) before deciding
        // coalesce-vs-CONFLICT, so a same-process winner whose
        // `docBaseRevisions.set(newRevision)` continuation hasn't landed yet
        // doesn't false-CONFLICT a byte-identical co-edit. The 3 coalesce
        // conditions are unchanged (`tryCoalesce` still requires the base to
        // have advanced to the live pointer AND the bodies to match), so an
        // external/other-instance move (which never advances the in-process
        // base) is still never coalesced — it just settles to CONFLICT after
        // the (short) retry budget.
        let coalesced: { winnerRevisionId: string } | null = null;
        for (let attempt = 0; attempt <= COALESCE_MICRO_RETRIES; attempt += 1) {
          coalesced = await tryCoalesce({
            Page,
            Revision,
            docBaseRevisions,
            pageId,
            loserBody: body,
            loserUserId: user._id,
          });
          if (coalesced) break;
          if (attempt < COALESCE_MICRO_RETRIES) {
            await sleep(COALESCE_MICRO_RETRY_MS);
          }
        }
        if (coalesced) {
          debug('save coalesced for page %s — winner revision=%s (loser body identical)', pageId, coalesced.winnerRevisionId);
          // The winner already pruned rows / wrote yjsState / advanced the
          // base, so we skip steps 6-7 here. Still fan out the page event so
          // this user's "I was editing" signal is not lost.
          await opts.pageEventPublisher.publish('update', { pageId, userId: userIdStr });
          return { revisionId: coalesced.winnerRevisionId };
        }
        // No coalesce — a genuine divergence (out-of-band edit, or a racing
        // save with a different body). Our Revision stays in history
        // unreferenced; reject so the client reloads. We do NOT prune
        // PageYjsUpdate rows and do NOT ack a non-committed revision (A3).
        throw new CollabSaveError('CONFLICT', `pointer compare-and-set for page ${pageId} did not match (currentRevision moved concurrently); reload required`);
      }

      // The save committed and is now the live pointer. Advance the doc base
      // so the NEXT save on this same server doc locks against the revision
      // we just created (otherwise the next save would see the live pointer
      // diverge from the still-old base and false-CONFLICT).
      docBaseRevisions.set(pageId, String(newRevision._id));

      // §D-7 — MUST run after the doc base advance above, never before.
      // `tryCoalesce`'s condition 1 (a same-process CAS loser deciding
      // whether to coalesce onto this winner) checks whether the doc base
      // has already advanced to this save's new revision; placing the
      // allocator call ahead of the `.set()` above would stall that
      // advance for as long as the allocator takes, turning a legitimate
      // same-process co-edit save-ok into a spurious CONFLICT (AC-18).
      if (contentSequenceAllocator) {
        try {
          await contentSequenceAllocator(page._id as Types.ObjectId, newRevision._id as Types.ObjectId);
        } catch (err) {
          debug('executeSave: contentSequenceAllocator failed for page %s: %s', pageId, (err as Error)?.message ?? err);
        }
      }

      // Step 6: collab yjsState mirror via the single chokepoint. Best-
      // effort — the data is already consistent on disk via step 5 (next
      // onLoadDocument rebuilds yjsState from the body if this fails). A
      // user save is explicit intent, so `allowShrink: true` bypasses the
      // desync guard entirely (Decision 2: large deletions / clears are
      // legitimate) — `baselineBody` is never consulted on this path (C3), so
      // we pass `null` rather than spend a DB round-trip reading it.
      try {
        // RFC-0017 Phase 1 §4.2 — reuse the SAME `expectedEpoch` read for the
        // pointer CAS above: a collab save never itself advances the epoch
        // (only a lifecycle transition does), and that CAS having just
        // succeeded already proves the epoch was still `expectedEpoch` at
        // write time.
        await persistYjsState(Page, { pageId, document, baselineBody: null, allowShrink: true, origin: 'save', expectedEpoch });
      } catch (err) {
        console.warn(`[crowi:collab] save: yjsState write failed for page ${pageId}; recoverable on next load.`, (err as Error).message);
      }

      // Step 6b: publish-on-save (RFC-0005 Phase 1; RFC-0021 §6.3/DC-6 —
      // Phase 2c-1). A `draft` page transitions to `published` on its
      // first successful save. The save itself is already durable on disk
      // (step 5 persisted the Revision; step 6 wrote the collab pointer),
      // so flipping the status here is strictly additive — it never gates
      // or rolls back the save. A failure is logged and swallowed: the
      // page simply stays a draft and the *next* save retries the flip
      // (both the injected publisher's CAS and the fallback `updateOne`
      // are idempotent — a no-op once already published). Already-
      // published pages match `page.status !== DRAFT_STATUS` and skip
      // the write entirely.
      if (page.status === DRAFT_STATUS) {
        if (draftPublisher) {
          try {
            await draftPublisher(page._id as Types.ObjectId, user._id as Types.ObjectId);
            debug('publish-on-save: draftPublisher invoked for page %s', pageId);
          } catch (err) {
            // `draftPublisher` (bound to `publishDraftPage`, a `runPageEventCommand`
            // caller) never rejects in production — its Error-semantics contract
            // collapses every failure to a returned outcome, never a throw (DC-1).
            // A rejection here is therefore an unexpected internal failure, not a
            // routine "publish didn't commit" — same posture as `contentSequenceAllocator`
            // above (§D-7): debug-only (never `console.warn`), since the caught
            // value could carry an unredacted internal error message the spec's
            // output contract keeps out of default-visible logs.
            debug('executeSave: draftPublisher unexpected rejection for page %s', pageId);
          }
        } else {
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
