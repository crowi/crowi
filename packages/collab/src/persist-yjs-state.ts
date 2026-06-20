import * as Y from 'yjs';
import Debug from 'debug';
import type { Model } from 'mongoose';
import { evaluateAntiShrink, type AntiShrinkVerdict } from './yjs-anti-shrink';

const debug = Debug('crowi:collab:persist');

/**
 * editor-preview-reliability — the SINGLE chokepoint every `Page.yjsState`
 * write path routes through (save-flow, compaction store-only fast path,
 * compaction full-merge, on-store). Before the original fix-round each of
 * those sites bolted anti-shrink on with *divergent* reject behaviour:
 * save-flow nulled `yjsState` on reject, compaction full-merge KEPT the
 * stale state AND still pruned the folded rows (C1: permanent loss of a
 * legit large deletion), and store-only returned a non-null "ok-shaped"
 * result that made on-store think it had persisted (tail item: the 10-min
 * time-trigger invariant broke).
 *
 * Centralising the verdict + the reject policy here means there is exactly
 * ONE definition of "what happens when anti-shrink says no" and ONE
 * guarantee: **a reject never loses data.**
 *
 * Reject policy (no-data-loss, applied uniformly to every checkpoint path):
 *   - DO NOT write `yjsState` (the candidate is empty / heavily shrunk).
 *   - DO NOT prune the folded `PageYjsUpdate` rows. They carry the
 *     (possibly legitimate) shrinking deltas; leaving them means the next
 *     `onLoadDocument` replays them over the surviving base state and the
 *     deletion is preserved — instead of C1's "keep stale state + prune
 *     rows = deletion reverted". The 1-hour TTL still bounds growth.
 *   - DO NOT bump `yjsCheckpointAt` (a reject is not a checkpoint; bumping
 *     it would suppress the 10-min time-trigger that re-attempts the write).
 *
 * The save path is different: a user save is explicit intent (protected by
 * the §1A optimistic lock + §2 synced gate), so it does NOT route its
 * checkpoint through the ratio arm — see `save-flow.ts`, which passes
 * `allowShrink: true` here so only the empty-doc guard (evaluated BEFORE
 * the revision is committed) can fire.
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
   * Bypass the ratio arm (NOT the structural decode). Set by the save path
   * (explicit user intent) so a legitimate large deletion isn't blocked;
   * the empty-doc guard still applies unless this is set.
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
 * Evaluate anti-shrink for `document` and, only when it passes, write the
 * encoded state + `yjsCheckpointAt` to `Page.yjsState`. Returns a verdict
 * the caller uses to decide whether it may prune folded rows (only on
 * `ok: true`).
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
    console.warn(
      `[crowi:collab] persistYjsState: anti-shrink rejected the ${input.origin} checkpoint for page ${input.pageId} ` +
        `(reason=${verdict.reason}, candidate=${verdict.candidateChars} chars, baseline=${verdict.baselineChars} chars); ` +
        'yjsState left intact and folded rows preserved — the next onLoadDocument rebuilds from the surviving base + deltas.',
    );
    return { ok: false, verdict };
  }

  const stateBuf = Buffer.from(Y.encodeStateAsUpdate(input.document));
  await page.updateOne({ _id: input.pageId }, { $set: { yjsState: stateBuf, yjsCheckpointAt: new Date() } }).exec();
  debug('persistYjsState: wrote %d bytes for page %s (origin=%s)', stateBuf.length, input.pageId, input.origin);
  return { ok: true, bytes: stateBuf.length, verdict };
}
