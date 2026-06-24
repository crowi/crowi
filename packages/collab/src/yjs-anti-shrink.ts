import * as Y from 'yjs';
import { CONTENT_FIELD } from './yjs-doc';
import { payloadToUint8Array } from './yjs-payload';

/**
 * editor-preview-reliability (round 2, Decision 2) — DESYNC detection for
 * the automatic `Page.yjsState` checkpoint paths (compaction store-only +
 * full-merge + on-store). REPLACES the old shrink-RATIO guard, which
 * mistook legitimate large deletions / empty clears for corruption and was
 * not durable (a rejected deletion lived only in 1h-TTL `PageYjsUpdate`
 * rows, so an idle large-deletion page reverted after the TTL).
 *
 * The real risk is NOT a doc the user legitimately shrank — it is
 * persisting a doc that was materialised EMPTY/STALE from a FAILED load
 * over a still-non-empty revision body. After a proper `onLoadDocument`
 * the server doc reflects the revision body (it seeds from body when
 * yjsState is empty), so a properly-loaded doc is authoritative and its
 * deletions are real intent — they go DURABLY into `yjsState`.
 *
 * So the only checkpoint we skip is the one tell-tale of a desync: an
 * EMPTY decoded doc over a NON-EMPTY revision body. That is the "doc
 * unloaded / unseeded → about to overwrite real content with nothing"
 * case. Everything else — including a large deletion to a few chars, and a
 * legitimate empty clear when the baseline is itself empty — is persisted.
 *
 * The SAVE path does not use this at all (a user save is explicit intent,
 * always persisted; see `save-flow.ts`). The on-load empty→body-seed
 * fallback (`on-load-document.ts`) is the complementary protection: a
 * stale/empty yjsState never even materialises empty over a non-empty body.
 *
 * Why a decoded-length check and NOT a `Buffer.length` check:
 * `Y.encodeStateAsUpdate` of an *empty* doc still returns a non-empty
 * Buffer (observed `[0,0]`), so the binary length tells us nothing about
 * whether the document carries content. We decode the candidate into a
 * throwaway Y.Doc and measure the `Y.Text` length to know if it is empty.
 */

export interface AntiShrinkInput {
  /** Candidate state about to be written, either an encoded update Buffer or a live Y.Doc. */
  candidate: Buffer | Uint8Array | Y.Doc;
  /** Latest persisted `Revision.body` (the protected baseline). Empty / missing → no baseline. */
  baselineBody: string | null | undefined;
  /**
   * Bypass the desync check entirely. Set by the SAVE path (explicit user
   * intent) so a deliberate empty clear / large deletion always persists.
   */
  allowShrink?: boolean;
}

export interface AntiShrinkVerdict {
  /** `true` when the candidate state is safe to persist. */
  ok: boolean;
  /** Decoded `Y.Text` length of the candidate (chars). */
  candidateChars: number;
  /** Normalized baseline body length (chars). */
  baselineChars: number;
  /** Populated when `ok === false` — a human-readable reason for the warn log. */
  reason?: 'desync-empty';
}

/**
 * Decode the candidate into a `Y.Text` length without mutating the
 * caller's doc. A `Y.Doc` candidate is measured directly (the live doc
 * the caller is about to encode); a Buffer / Uint8Array is applied into
 * a throwaway doc first.
 */
function candidateTextLength(candidate: Buffer | Uint8Array | Y.Doc): number {
  if (candidate instanceof Y.Doc) {
    return candidate.getText(CONTENT_FIELD).length;
  }
  const probe = new Y.Doc();
  try {
    Y.applyUpdate(probe, payloadToUint8Array(candidate));
    return probe.getText(CONTENT_FIELD).length;
  } finally {
    probe.destroy();
  }
}

/**
 * Evaluate the desync guard for an automatic `Page.yjsState` checkpoint.
 * Pure + synchronous so the write paths can call it inline before the
 * `Page.updateOne`. Never throws on a well-formed candidate; a corrupt
 * Buffer surfaces the same `payloadToUint8Array` TypeError as the rest of
 * the pipeline (callers already wrap their writes in try/catch).
 *
 * Rejects ONLY an empty decoded doc over a non-empty baseline body (the
 * desync tell-tale). Returns `ok: true` for everything else.
 */
export function evaluateAntiShrink(input: AntiShrinkInput): AntiShrinkVerdict {
  const candidateChars = candidateTextLength(input.candidate);
  // Mirror the on-load CRLF→LF normalization so a v1-era CRLF body
  // isn't counted as artificially longer than the LF-only Y.Text.
  const baselineChars = (input.baselineBody ?? '').replace(/\r\n?/g, '\n').length;

  if (input.allowShrink) {
    return { ok: true, candidateChars, baselineChars };
  }

  // No baseline to protect (new page, or last body was empty): persisting
  // an empty doc is a no-op-equivalent, not a loss.
  if (baselineChars === 0) {
    return { ok: true, candidateChars, baselineChars };
  }

  // The one desync tell-tale: an empty decoded doc over a non-empty
  // baseline body — about to overwrite real content with nothing. Skip the
  // checkpoint (the no-data-loss reject policy keeps the surviving state +
  // the folded deltas; on-load rebuilds from the body).
  if (candidateChars === 0) {
    return { ok: false, candidateChars, baselineChars, reason: 'desync-empty' };
  }

  // A non-empty doc — including a legitimate large deletion — is the live
  // doc's real content. Persist it durably.
  return { ok: true, candidateChars, baselineChars };
}
