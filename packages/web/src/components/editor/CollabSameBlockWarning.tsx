'use client';

import { useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import type { AwarenessState } from '@/lib/use-awareness-states';
import { useAwarenessStates } from '@/lib/use-awareness-states';
import type { CollabAwareness } from '@/lib/use-collab-document';
import { m } from '@paraglide/messages.js';

interface CollabSameBlockWarningProps {
  awareness: CollabAwareness | null;
  yText: Y.Text | null;
  /**
   * The local client's awareness id (= `awareness.clientID`). Pass
   * explicitly so the warning can filter the local peer out of the
   * "other editors" list cleanly without a second `.clientID` round
   * trip through the parent.
   */
  localClientId: number | null | undefined;
}

/**
 * RFC-0003 Phase 8 — controlled visibility indicator for "you are
 * editing the same paragraph as N other peers". Intentionally muted
 * (small text, no border, no icon) — the spec calls for a "subtle
 * sub-text/toast-like" hint, not a blocking warning. Renders `null`
 * when there's nothing to say so it occupies zero footer real estate
 * in the common case.
 *
 * Paragraph approximation: split `yText.toString()` on `\n\n+`. This
 * is a *coarse* Markdown block proxy (list items / blockquote lines /
 * code-block bodies all coalesce into one paragraph if they're not
 * separated by blank lines) but it's right ≥ 95% of the time and
 * costs O(n) of the document, which is cheap compared to running
 * mdast in the hot keystroke path. A future RFC can swap to a real
 * Markdown tokeniser if user research shows the false positives are
 * confusing.
 */
export function CollabSameBlockWarning({ awareness, yText, localClientId }: CollabSameBlockWarningProps) {
  const states = useAwarenessStates(awareness);

  // Mirror Y.Text → React string so paragraph boundaries refresh as
  // the doc grows. We don't need every keystroke — once per Yjs event
  // is enough — but Y.Text.observe is the simplest hook.
  const [text, setText] = useState<string>('');
  useEffect(() => {
    if (!yText) {
      // The `set-state-in-effect` rule fires on the initial clear too,
      // but this is the textbook "external resource swap" pattern —
      // when the Y.Text handle disappears we must drop the stale
      // mirror immediately, otherwise the warning paints against
      // paragraph boundaries from the previous page.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setText('');
      return;
    }
    const emit = () => setText(yText.toString());
    emit();
    yText.observe(emit);
    return () => {
      yText.unobserve(emit);
    };
  }, [yText]);

  // Precompute paragraph boundaries once per text change so each peer
  // lookup is O(log p) instead of an O(n) re-walk. boundaries[i] is
  // the offset of the *start* of the i-th paragraph block; a 0 sentinel
  // is implicit (offset 0 is always paragraph 0).
  const paragraphBoundaries = useMemo(() => computeParagraphBoundaries(text), [text]);

  if (!awareness || !yText || localClientId == null) return null;

  const localState = states.get(localClientId);
  const localOffset = relativeHeadToAbsoluteIndex(localState?.cursor, yText.doc);
  if (localOffset == null) return null;

  const localParagraph = paragraphIndexFromBoundaries(paragraphBoundaries, localOffset);

  // Collect other peers in the same paragraph. We tolerate peers with
  // no `user.name` (fall back to a generic label) but require a
  // resolvable cursor offset so we don't false-positive on a peer who
  // has only published their identity.
  const overlapping: Array<{ clientId: number; name: string }> = [];
  for (const [clientId, state] of states) {
    if (clientId === localClientId) continue;
    const offset = relativeHeadToAbsoluteIndex(state.cursor, yText.doc);
    if (offset == null) continue;
    const peerParagraph = paragraphIndexFromBoundaries(paragraphBoundaries, offset);
    if (peerParagraph !== localParagraph) continue;
    overlapping.push({
      clientId,
      name: state.user?.name?.trim() || m['collab.someone'](),
    });
  }

  if (overlapping.length === 0) return null;

  // Display style: first 3 names listed, anything past 3 collapsed
  // into "and N others". Keep the rendered string deterministic by
  // sorting on clientId — otherwise the order can flicker as the Map
  // re-orders on each `change` event.
  overlapping.sort((a, b) => a.clientId - b.clientId);
  const visible = overlapping.slice(0, 3);
  const rest = overlapping.length - visible.length;
  const names = visible.map((p) => p.name).join(', ');

  const label = rest > 0 ? m['collab.same_block_warning_others']({ names, count: rest }) : m['collab.same_block_warning']({ names });

  return (
    <div role="status" className="text-muted-foreground flex items-center gap-1 text-xs">
      <span aria-hidden="true">·</span>
      <span>{label}</span>
    </div>
  );
}

/**
 * Convert an awareness state's `cursor.head` (Y.RelativePosition JSON)
 * into an absolute Y.Text offset. Returns `null` for missing /
 * unparseable cursors, which the caller treats as "no opinion" so the
 * peer doesn't get filtered.
 *
 * Exported via the function name for unit test sniffability but kept
 * out of the public module surface; it's an internal helper.
 */
function relativeHeadToAbsoluteIndex(cursor: AwarenessState['cursor'], doc: Y.Doc | null | undefined): number | null {
  if (!cursor?.head || !doc) return null;
  try {
    const rel = Y.createRelativePositionFromJSON(cursor.head);
    const abs = Y.createAbsolutePositionFromRelativePosition(rel, doc);
    return abs?.index ?? null;
  } catch {
    return null;
  }
}

/**
 * Build the list of paragraph start offsets — the start of every
 * `\n\n+`-separated chunk after the first. Paragraph 0 always starts
 * at offset 0, so it's left implicit (no entry in the array). Runs of
 * 3+ blank lines collapse to one separator.
 *
 * Computed once per text change via `useMemo`. Each peer's paragraph
 * lookup then does a binary search against this array.
 */
function computeParagraphBoundaries(text: string): number[] {
  const boundaries: number[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\n' && text[i + 1] === '\n') {
      while (i < text.length && text[i] === '\n') i++;
      boundaries.push(i);
      continue;
    }
    i++;
  }
  return boundaries;
}

/**
 * Binary-search the paragraph index that contains `offset`. Returns
 * the count of boundaries strictly less than or equal to `offset` —
 * paragraph 0 covers `[0, boundaries[0])`, paragraph k covers
 * `[boundaries[k-1], boundaries[k])`, the last covers `[…, ∞)`.
 */
function paragraphIndexFromBoundaries(boundaries: number[], offset: number): number {
  let lo = 0;
  let hi = boundaries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (boundaries[mid] <= offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
