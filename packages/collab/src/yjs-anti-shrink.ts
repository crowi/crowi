import * as Y from 'yjs';
import { CONTENT_FIELD } from './yjs-doc';
import { payloadToUint8Array } from './yjs-payload';

/**
 * Shared anti-shrink guard for every `Page.yjsState` write path
 * (RFC editor-preview-reliability §1B). The three write sites —
 * `save-flow.ts` (save), `compaction.ts` (store-only fast path + full
 * merge) and `on-store-document.ts` (delegates to compaction) — all
 * route through here before persisting an encoded Y.Doc so a doc that
 * has been emptied (or catastrophically shrunk) can never silently
 * overwrite the last good `Page.yjsState`.
 *
 * Why a decoded-length check and NOT a `Buffer.length` check:
 * `Y.encodeStateAsUpdate` of an *empty* doc still returns a non-empty
 * Buffer (observed `[0,0]`), so the binary length tells us nothing
 * about whether the document carries content. We must decode the
 * candidate state into a throwaway Y.Doc and measure the `Y.Text`
 * length to know if it is empty.
 *
 * Comparison baseline: the latest `Revision.body` length. We compare
 * the decoded `Y.Text` length against the body length (after the same
 * CRLF→LF normalization `on-load-document` applies when seeding, so a
 * v1-era CRLF body doesn't read as "longer" by one char per line and
 * trip a false shrink). When the candidate is empty OR shrinks by at
 * least `SHRINK_REJECT_RATIO` relative to the baseline body, the write
 * is rejected — unless the caller passes `allowShrink: true`, which is
 * the single sanctioned bypass for an explicit "clear all" gesture.
 */

/**
 * Reject a write when the decoded doc is at most this fraction of the
 * baseline body length. 0.5 = "rejected once the doc drops to ≤ 50% of
 * the last persisted body" (spec §1B target). A brand-new short page
 * has no baseline (body length 0), so this only ever fires once there
 * is real content to protect.
 */
export const SHRINK_REJECT_RATIO = 0.5;

/**
 * Minimum baseline body length before the ratio guard engages. Tiny
 * docs (a few characters) routinely fluctuate by more than 50% during
 * normal editing — guarding them would be all false positives and no
 * protection. The empty-doc check (below) still applies regardless of
 * baseline size, so this only relaxes the *ratio* arm.
 */
export const SHRINK_MIN_BASELINE_CHARS = 40;

export interface AntiShrinkInput {
  /** Candidate state about to be written, either an encoded update Buffer or a live Y.Doc. */
  candidate: Buffer | Uint8Array | Y.Doc;
  /** Latest persisted `Revision.body` (the protected baseline). Empty / missing → no baseline. */
  baselineBody: string | null | undefined;
  /**
   * Set when the write originates from an explicit "clear all" gesture
   * (the only sanctioned way to persist an empty / heavily-shrunk doc).
   * Skips the guard entirely.
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
  reason?: 'empty' | 'shrunk';
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
 * Evaluate the anti-shrink guard for a `Page.yjsState` write. Pure +
 * synchronous so all three write paths can call it inline before the
 * `Page.updateOne`. Never throws on a well-formed candidate; a corrupt
 * Buffer surfaces the same `payloadToUint8Array` TypeError as the rest
 * of the pipeline (callers already wrap their writes in try/catch).
 */
export function evaluateAntiShrink(input: AntiShrinkInput): AntiShrinkVerdict {
  const candidateChars = candidateTextLength(input.candidate);
  // Mirror the on-load CRLF→LF normalization so a v1-era CRLF body
  // isn't counted as artificially longer than the LF-only Y.Text.
  const baselineChars = (input.baselineBody ?? '').replace(/\r\n?/g, '\n').length;

  if (input.allowShrink) {
    return { ok: true, candidateChars, baselineChars };
  }

  // No baseline to protect (new page, or last body was empty): only an
  // empty candidate over a non-empty baseline is dangerous, and there
  // is no non-empty baseline here, so anything is fine.
  if (baselineChars === 0) {
    return { ok: true, candidateChars, baselineChars };
  }

  // Empty doc over a non-empty baseline — the silent-clear path the
  // spec calls out. Always reject (the `allowShrink` bypass above is
  // the only way an intentional clear gets through).
  if (candidateChars === 0) {
    return { ok: false, candidateChars, baselineChars, reason: 'empty' };
  }

  // Ratio arm only engages once there is enough baseline that a >50%
  // drop is meaningful rather than normal small-doc churn.
  if (baselineChars >= SHRINK_MIN_BASELINE_CHARS && candidateChars <= baselineChars * SHRINK_REJECT_RATIO) {
    return { ok: false, candidateChars, baselineChars, reason: 'shrunk' };
  }

  return { ok: true, candidateChars, baselineChars };
}
