import * as Y from 'yjs';
import Debug from 'debug';
import type { Model } from 'mongoose';
import { evaluateAntiShrink, type AntiShrinkVerdict } from './yjs-anti-shrink';

const debug = Debug('crowi:collab:persist');

/**
 * editor-preview-reliability — the SINGLE chokepoint every `Page.yjsState`
 * write path routes through (save-flow, compaction store-only fast path,
 * compaction full-merge, on-store). Centralising the verdict + the reject
 * policy here means there is exactly ONE definition of "what happens when
 * the desync guard says no" and ONE guarantee: **a reject never loses
 * data.**
 *
 * Round 2 (Decision 2): the guard is now a DESYNC check (empty decoded doc
 * over a non-empty revision body — the tell-tale of a doc materialised
 * empty from a failed load), NOT a shrink-ratio. A legitimate large
 * deletion is a non-empty doc and persists durably into `yjsState` (so it
 * survives past the 1-hour `PageYjsUpdate` TTL — fixes C1's durability
 * hole). See `yjs-anti-shrink.ts`.
 *
 * Reject policy (no-data-loss, applied uniformly to every checkpoint path):
 *   - DO NOT write `yjsState` (the candidate is empty over real content =
 *     a probable desync).
 *   - DO NOT prune the folded `PageYjsUpdate` rows. Leaving them means the
 *     next `onLoadDocument` replays them over the surviving base state —
 *     instead of "keep stale state + prune rows = content reverted". The
 *     1-hour TTL still bounds growth.
 *   - DO NOT bump `yjsCheckpointAt` (a reject is not a checkpoint; bumping
 *     it would suppress the 10-min time-trigger that re-attempts the write).
 *
 * The save path is different: a user save is explicit intent (protected by
 * the server-doc lock + the client synced gate), so it passes
 * `allowShrink: true` here — a deliberate empty clear / large deletion
 * always persists.
 */

/** Minimal `Page` model surface this chokepoint touches. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PageModelLike = Pick<Model<any>, 'updateOne'>;

export interface PersistYjsStateInput {
  /** Page id (= Hocuspocus documentName) being checkpointed. */
  pageId: string;
  /** The live Y.Doc whose encoded state is the write candidate. */
  document: Y.Doc;
  /**
   * Latest persisted `Revision.body` — the protected anti-shrink baseline.
   * `null` / empty disables the ratio + empty guards (nothing to protect).
   */
  baselineBody: string | null | undefined;
  /**
   * Bypass the desync guard. Set by the save path (explicit user intent)
   * so a deliberate empty clear / large deletion always persists.
   */
  allowShrink?: boolean;
  /**
   * Human-readable label for the write site, used only in the warn log so
   * an operator can tell apart "save", "store-only", "full-merge".
   */
  origin: 'save' | 'store-only' | 'full-merge';
}

export type PersistYjsStateResult =
  | {
      /** The candidate passed and `Page.yjsState` + `yjsCheckpointAt` were written. */
      ok: true;
      /** Byte length of the encoded state that was persisted. */
      bytes: number;
      verdict: AntiShrinkVerdict;
    }
  | {
      /**
       * Anti-shrink rejected the candidate. Nothing was written; per the
       * no-data-loss policy the caller must ALSO leave any folded
       * `PageYjsUpdate` rows in place (do not prune on a reject).
       */
      ok: false;
      verdict: AntiShrinkVerdict;
    };

/**
 * Sampled reject-warning bookkeeping (tail item): a page whose live doc is
 * stuck empty (a wedged client) would otherwise log a reject warning on
 * EVERY ~2s debounce. We log the first reject per page, then 1-in-N after,
 * so an operator still sees a persistent problem without a log flood.
 */
const REJECT_LOG_SAMPLE = 20;
const rejectCounts = new Map<string, number>();

/**
 * Evaluate the desync guard for `document` and, only when it passes, write
 * the encoded state + `yjsCheckpointAt` to `Page.yjsState`. Returns a
 * verdict the caller uses to decide whether it may prune folded rows (only
 * on `ok: true`).
 *
 * Pure-ish: the single side effect is the conditional `Page.updateOne`.
 * The caller owns its own try/catch (the existing write sites already wrap
 * their persistence in one) — a thrown Mongo error propagates unchanged.
 */
export async function persistYjsState(page: PageModelLike, input: PersistYjsStateInput): Promise<PersistYjsStateResult> {
  const verdict = evaluateAntiShrink({
    candidate: input.document,
    baselineBody: input.baselineBody,
    allowShrink: input.allowShrink,
  });

  if (!verdict.ok) {
    // Sample the warn so a stuck-empty page doesn't flood the log.
    const n = (rejectCounts.get(input.pageId) ?? 0) + 1;
    rejectCounts.set(input.pageId, n);
    if (n === 1 || n % REJECT_LOG_SAMPLE === 0) {
      console.warn(
        `[crowi:collab] persistYjsState: desync guard rejected the ${input.origin} checkpoint for page ${input.pageId} ` +
          `(reason=${verdict.reason}, candidate=${verdict.candidateChars} chars, baseline=${verdict.baselineChars} chars, occurrence #${n}); ` +
          'yjsState left intact and folded rows preserved — the next onLoadDocument rebuilds from the surviving base + deltas.',
      );
    }
    return { ok: false, verdict };
  }

  // A successful write clears the reject streak so a page that recovers
  // (content re-established) logs fresh if it ever wedges again.
  rejectCounts.delete(input.pageId);

  const stateBuf = Buffer.from(Y.encodeStateAsUpdate(input.document));
  await page.updateOne({ _id: input.pageId }, { $set: { yjsState: stateBuf, yjsCheckpointAt: new Date() } }).exec();
  debug('persistYjsState: wrote %d bytes for page %s (origin=%s)', stateBuf.length, input.pageId, input.origin);
  return { ok: true, bytes: stateBuf.length, verdict };
}
