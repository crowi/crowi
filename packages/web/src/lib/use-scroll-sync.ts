'use client';

import { useEffect, type RefObject } from 'react';
import type { MarkdownEditorHandle } from '@/components/editor/MarkdownEditor';
import { computeScrollProgress, computeSlidingReferenceTarget, isProgressNearEnd, isProgressNearStart } from './scroll-sync-math';

interface UseScrollSyncOptions {
  /**
   * Imperative handle of the CodeMirror editor. The hook reaches into
   * it on each `scroll` event to look up the editor's fractional-line
   * position (editor → preview) or to scroll a target fractional
   * line into view (preview → editor). Pass a stable ref.
   */
  editorRef: RefObject<MarkdownEditorHandle | null>;
  /**
   * Ref to the preview's scroll container — the element with
   * `overflow-auto` that wraps the rendered markdown. The hook reads
   * `data-source-line` markers placed by the server (see
   * `injectSourceLineAnchors` in `page-preview.ts`) inside this
   * element to locate sync targets.
   */
  previewRef: RefObject<HTMLElement | null>;
  /**
   * Toggle the binding. When `false`, no listeners are attached and
   * existing ones are torn down. Used to disable sync on the narrow
   * Tabs layout where editor / preview never coexist on screen.
   */
  enabled: boolean;
}

/**
 * Bidirectional fractional-line scroll sync between a CodeMirror
 * markdown editor and a rendered HTML preview, using a "sliding
 * reference" alignment (see
 * `.feature-state/specs/feature-scroll-sync-sliding-reference.md`):
 * instead of always pinning the mapped line at the viewport TOP on both
 * panes, the alignment height slides continuously from the top
 * (`p=0`) to the bottom (`p=1`) of the DRIVING pane's own viewport as
 * that pane's scroll progress `p` advances. At `p=0` this is
 * top-aligned exactly like before; at `p=1` (typically: appending at
 * the end of a long document) the preview's freshly-rendered bottom
 * stays in view instead of being pushed off-screen by a taller
 * preview.
 *
 * The editor's `getProgressAt(viewportFraction)` returns
 * `{ line, ratio }` where `ratio` is the fractional offset (`0..1`)
 * inside that line's vertical block. Combined as `line + ratio`, this
 * gives a continuous position that stays smooth even while the cursor
 * scrolls through the interior of a long block (code fence / list /
 * table) — pure integer-line sync would snap on each line change.
 *
 * On each scroll, we sample top-level `[data-source-line]` markers
 * the server injects into the preview DOM, then interpolate linearly
 * between adjacent markers to translate `{ line, ratio }` ↔ a
 * content-space y in the preview. `computeSlidingReferenceTarget`
 * (pure, unit-tested in `scroll-sync-math.test.ts`) turns that y plus
 * the driving pane's own progress into the opposite pane's target
 * `scrollTop`, pinning the two ends exactly so sparse anchors near an
 * edge don't leave a gap.
 *
 * **Approximately inverse, not exact**: `previewYForFractionalLine`
 * and `editorFractionalLineForPreviewY` are still exact inverses of
 * each other (the anchor interpolation itself is unchanged), but
 * because forward uses the editor's own progress and reverse uses the
 * preview's own progress, a round-trip (editor → preview → editor) can
 * leave a small residual offset on documents whose two panes have very
 * different scrollable heights — sliding reference intentionally
 * trades the old "exact inverse" guarantee for "keeps the tail
 * visible". This does not cause oscillation: whichever side is being
 * actively scrolled always drives with its own live progress, and the
 * **recursion guard** below absorbs the single reflected scroll on the
 * opposite side.
 *
 * **Recursion guard**: the scroll we trigger on the opposite side
 * would normally fire that side's listener and bounce back. A simple
 * `lock` variable, cleared on the next animation frame, absorbs the
 * bounce. Required `[&_.cm-scroller]:scroll-auto` + `scroll-auto` on
 * the preview container so programmatic scrolls don't animate past
 * the rAF window — see `EditorPane` / `PreviewPane` for those styles.
 *
 * **Invariant**: DOM order of `[data-source-line]` markers ascends
 * monotonically with both source-line number and visual top. The
 * server injects them in `tree.children` order after renderer
 * transforms (see `injectSourceLineAnchors` in `page-preview.ts`).
 * If a future plugin reorders top-level mdast nodes, sync would
 * silently mis-target.
 */
export function useScrollSync({ editorRef, previewRef, enabled }: UseScrollSyncOptions): void {
  useEffect(() => {
    if (!enabled) return;
    const previewScroll = previewRef.current;
    if (!previewScroll) return;

    let lock: 'editor' | 'preview' | null = null;

    type MarkerSnapshot = { sourceLine: number; top: number };
    const snapshotMarkers = (): MarkerSnapshot[] => {
      const marked = previewScroll.querySelectorAll<HTMLElement>('[data-source-line]');
      if (marked.length === 0) return [];
      const containerTop = previewScroll.getBoundingClientRect().top;
      const out: MarkerSnapshot[] = [];
      for (const el of Array.from(marked)) {
        const sourceLine = Number(el.dataset.sourceLine);
        if (!Number.isFinite(sourceLine)) continue;
        // Container-relative y, normalised against current scrollTop so
        // values are stable across scroll positions (rect.top is
        // viewport-relative, not container-internal).
        out.push({ sourceLine, top: el.getBoundingClientRect().top - containerTop + previewScroll.scrollTop });
      }
      return out;
    };

    const previewYForFractionalLine = (line: number, ratio: number): number | null => {
      const markers = snapshotMarkers();
      if (markers.length === 0) return null;
      const fractional = line + ratio;
      if (fractional <= markers[0].sourceLine) return markers[0].top;
      const last = markers[markers.length - 1];
      if (fractional >= last.sourceLine) return last.top;
      // Binary-search the largest marker with sourceLine <= fractional.
      let lo = 0;
      let hi = markers.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (markers[mid].sourceLine <= fractional) lo = mid;
        else hi = mid - 1;
      }
      const a = markers[lo];
      const b = markers[lo + 1];
      if (!b || b.sourceLine === a.sourceLine) return a.top;
      const t = (fractional - a.sourceLine) / (b.sourceLine - a.sourceLine);
      return a.top + (b.top - a.top) * t;
    };

    const editorFractionalLineForPreviewY = (previewY: number): { line: number; ratio: number } | null => {
      const markers = snapshotMarkers();
      if (markers.length === 0) return null;
      if (previewY <= markers[0].top) {
        const sl = markers[0].sourceLine;
        return { line: Math.floor(sl), ratio: sl - Math.floor(sl) };
      }
      const last = markers[markers.length - 1];
      if (previewY >= last.top) {
        return { line: Math.floor(last.sourceLine), ratio: last.sourceLine - Math.floor(last.sourceLine) };
      }
      // Binary-search the largest marker whose top is <= previewY.
      let lo = 0;
      let hi = markers.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (markers[mid].top <= previewY) lo = mid;
        else hi = mid - 1;
      }
      const a = markers[lo];
      const b = markers[lo + 1];
      if (!b || b.top === a.top) {
        return { line: Math.floor(a.sourceLine), ratio: a.sourceLine - Math.floor(a.sourceLine) };
      }
      const t = (previewY - a.top) / (b.top - a.top);
      const fractional = a.sourceLine + (b.sourceLine - a.sourceLine) * t;
      const line = Math.floor(fractional);
      return { line, ratio: fractional - line };
    };

    const onEditorScroll = () => {
      if (lock === 'preview') return;
      lock = 'editor';
      const editorScroll = editorRef.current?.getScrollDOM() ?? null;
      const sourceProgress = editorScroll ? computeScrollProgress(editorScroll.scrollTop, editorScroll.scrollHeight, editorScroll.clientHeight) : 0;
      // Reference point = the fractional line sitting at `sourceProgress`
      // of the EDITOR's own viewport (0 = top, 1 = bottom) — this is the
      // "sliding reference" itself, generalized from the old fixed-top
      // probe. Endpoints are pinned by `computeSlidingReferenceTarget`
      // below without needing a resolved reference line, so skip the DOM
      // snapshot + binary search entirely when pinned — mirrors the
      // symmetric skip in `onPreviewScroll` below.
      let referenceY: number | null = null;
      if (!isProgressNearStart(sourceProgress) && !isProgressNearEnd(sourceProgress)) {
        const prog = editorRef.current?.getProgressAt(sourceProgress) ?? null;
        referenceY = prog ? previewYForFractionalLine(prog.line, prog.ratio) : null;
      }
      const target = computeSlidingReferenceTarget({
        sourceProgress,
        referenceY,
        targetViewportHeight: previewScroll.clientHeight,
        targetMaxScroll: Math.max(0, previewScroll.scrollHeight - previewScroll.clientHeight),
      });
      if (target !== null) previewScroll.scrollTop = target;
      requestAnimationFrame(() => {
        if (lock === 'editor') lock = null;
      });
    };

    const onPreviewScroll = () => {
      if (lock === 'editor') return;
      lock = 'preview';
      const sourceProgress = computeScrollProgress(previewScroll.scrollTop, previewScroll.scrollHeight, previewScroll.clientHeight);
      if (isProgressNearStart(sourceProgress) || isProgressNearEnd(sourceProgress)) {
        // Symmetric endpoint pin: bypass the anchor lookup entirely (a
        // sparsely-anchored document shouldn't keep the editor from
        // reaching its true top/bottom) and set the editor's own
        // scrollTop directly via the live scroll element.
        const editorScroll = editorRef.current?.getScrollDOM() ?? null;
        if (editorScroll) {
          editorScroll.scrollTop = isProgressNearStart(sourceProgress) ? 0 : Math.max(0, editorScroll.scrollHeight - editorScroll.clientHeight);
        }
      } else {
        // Reference point = the fractional line sitting at `sourceProgress`
        // of the PREVIEW's own viewport, mirroring the editor→preview
        // direction above.
        const referenceY = previewScroll.scrollTop + sourceProgress * previewScroll.clientHeight;
        const prog = editorFractionalLineForPreviewY(referenceY);
        if (prog) editorRef.current?.scrollToLineProgressAt(prog.line, prog.ratio, sourceProgress);
      }
      requestAnimationFrame(() => {
        if (lock === 'preview') lock = null;
      });
    };

    // Editor → preview: the CodeMirror `.cm-scroller` element is *replaced*
    // whenever the collab wrapper remounts the inner view (Y.Text becomes
    // ready, StrictMode, page swap, …), so binding to a captured element
    // silently goes dead after the ~100ms handshake. Instead listen on
    // `document` in the capture phase — scroll events don't bubble but
    // ancestor capture listeners still receive them — and match the event
    // against the *live* scroll element each time. This survives any view
    // recreation without the caller having to signal remounts.
    const onEditorScrollCapture = (e: Event) => {
      if (e.target !== editorRef.current?.getScrollDOM()) return;
      onEditorScroll();
    };
    document.addEventListener('scroll', onEditorScrollCapture, { capture: true, passive: true });
    previewScroll.addEventListener('scroll', onPreviewScroll, { passive: true });
    return () => {
      document.removeEventListener('scroll', onEditorScrollCapture, { capture: true });
      previewScroll.removeEventListener('scroll', onPreviewScroll);
    };
  }, [editorRef, previewRef, enabled]);
}
