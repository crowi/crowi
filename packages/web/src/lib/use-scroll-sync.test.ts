import type { RefObject } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarkdownEditorHandle } from '@/components/editor/MarkdownEditor';
import { SLIDING_REFERENCE_EPSILON } from './scroll-sync-math';
import { useScrollSync } from './use-scroll-sync';

// ---------------------------------------------------------------------------
// DOM helpers — jsdom performs no real layout, so `scrollHeight` /
// `clientHeight` and `getBoundingClientRect` need explicit overrides per
// element under test. `scrollTop` is natively stateful in jsdom (a real
// getter/setter pair), so it's set directly.
// ---------------------------------------------------------------------------

function setPaneSize(el: HTMLElement, { scrollHeight, clientHeight }: { scrollHeight: number; clientHeight: number }) {
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
}

/**
 * A `[data-source-line]` marker whose visual `top` tracks `container`'s live
 * `scrollTop`, the way a real laid-out element would: `contentY` is a fixed
 * content-space position, and the rect reported to `getBoundingClientRect`
 * shifts up as the container scrolls down — matching the real DOM parallax
 * `use-scroll-sync.ts`'s `snapshotMarkers` relies on to recover `contentY`.
 */
function addMarker(container: HTMLElement, sourceLine: number, contentY: number): HTMLElement {
  const el = document.createElement('div');
  el.dataset.sourceLine = String(sourceLine);
  el.getBoundingClientRect = () =>
    ({
      top: contentY - container.scrollTop,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      x: 0,
      y: contentY - container.scrollTop,
      toJSON: () => ({}),
    }) as DOMRect;
  container.appendChild(el);
  return el;
}

type MockHandle = MarkdownEditorHandle & { scrollToLineProgressAt: ReturnType<typeof vi.fn<(line: number, ratio: number, viewportFraction: number) => void>> };

function makeEditorHandle(scrollDOM: HTMLElement, getProgressAt: (fraction: number) => { line: number; ratio: number } | null, lineCount = 100): MockHandle {
  return {
    insertAtCursor: vi.fn(() => 0),
    focusEnd: vi.fn(),
    getScrollDOM: () => scrollDOM,
    getLineCount: () => lineCount,
    getProgressAt: vi.fn(getProgressAt),
    scrollToLineProgressAt: vi.fn<(line: number, ratio: number, viewportFraction: number) => void>(),
  };
}

// A tiny simulated document: 3 evenly-spaced top-level markers at source
// lines 0 / 50 / 100, laid out at preview content-space y 0 / 5000 / 10000
// (the preview renders much taller than the editor — the whole point of
// sliding reference). `getProgressAt(fraction)` maps the editor's own
// viewport fraction onto the same 0..100 line grid, so the two panes agree
// on where "50% through the document" is.
const PREVIEW_SCROLL_HEIGHT = 12000;
const PREVIEW_CLIENT_HEIGHT = 800;
const PREVIEW_MAX = PREVIEW_SCROLL_HEIGHT - PREVIEW_CLIENT_HEIGHT; // 11200
const EDITOR_SCROLL_HEIGHT = 3000;
const EDITOR_CLIENT_HEIGHT = 800;
const EDITOR_MAX = EDITOR_SCROLL_HEIGHT - EDITOR_CLIENT_HEIGHT; // 2200

function getProgressAt(fraction: number): { line: number; ratio: number } {
  const clamped = Math.max(0, Math.min(1, fraction));
  const fractional = clamped * 100;
  const line = Math.floor(fractional);
  return { line, ratio: fractional - line };
}

describe('useScrollSync — sliding reference', () => {
  let editorScrollDOM: HTMLElement;
  let previewContainer: HTMLElement;
  let editorRef: RefObject<MockHandle | null>;
  let previewRef: RefObject<HTMLElement | null>;

  beforeEach(() => {
    editorScrollDOM = document.createElement('div');
    setPaneSize(editorScrollDOM, { scrollHeight: EDITOR_SCROLL_HEIGHT, clientHeight: EDITOR_CLIENT_HEIGHT });
    document.body.appendChild(editorScrollDOM);

    previewContainer = document.createElement('div');
    setPaneSize(previewContainer, { scrollHeight: PREVIEW_SCROLL_HEIGHT, clientHeight: PREVIEW_CLIENT_HEIGHT });
    document.body.appendChild(previewContainer);
    addMarker(previewContainer, 0, 0);
    addMarker(previewContainer, 50, 5000);
    addMarker(previewContainer, 100, 10000);

    editorRef = { current: makeEditorHandle(editorScrollDOM, getProgressAt) };
    previewRef = { current: previewContainer };
  });

  afterEach(() => {
    editorScrollDOM.remove();
    previewContainer.remove();
  });

  function scrollEditorTo(scrollTop: number) {
    editorScrollDOM.scrollTop = scrollTop;
    act(() => {
      editorScrollDOM.dispatchEvent(new Event('scroll'));
    });
  }

  function scrollPreviewTo(scrollTop: number) {
    previewContainer.scrollTop = scrollTop;
    act(() => {
      previewContainer.dispatchEvent(new Event('scroll'));
    });
  }

  it('does nothing when disabled', () => {
    renderHook(() => useScrollSync({ editorRef, previewRef, enabled: false }));
    scrollEditorTo(EDITOR_MAX);
    expect(previewContainer.scrollTop).toBe(0);
  });

  describe('forward (editor -> preview)', () => {
    it('aligns top-to-top when the editor is at scrollTop 0 (regression: legacy behaviour)', () => {
      renderHook(() => useScrollSync({ editorRef, previewRef, enabled: true }));
      scrollEditorTo(0);
      expect(previewContainer.scrollTop).toBe(0);
      // Pinned endpoint: the anchor lookup (DOM snapshot + binary search) is
      // skipped entirely, mirroring the reverse direction's pin skip below.
      expect(editorRef.current?.getProgressAt).not.toHaveBeenCalled();
    });

    it('aligns bottom-to-bottom when the editor reaches its max scrollTop', () => {
      renderHook(() => useScrollSync({ editorRef, previewRef, enabled: true }));
      scrollEditorTo(EDITOR_MAX);
      expect(previewContainer.scrollTop).toBe(PREVIEW_MAX);
      expect(editorRef.current?.getProgressAt).not.toHaveBeenCalled();
    });

    it('aligns the reference line at the same proportional viewport height at p=0.5 (center-to-center)', () => {
      renderHook(() => useScrollSync({ editorRef, previewRef, enabled: true }));
      scrollEditorTo(EDITOR_MAX / 2); // p = 0.5 exactly
      // fractional line 50 -> preview content y 5000; target = 5000 - 0.5*800
      expect(previewContainer.scrollTop).toBe(5000 - 0.5 * PREVIEW_CLIENT_HEIGHT);
    });

    it('degenerates to progress 0 (top-aligned) when the editor pane cannot scroll', () => {
      setPaneSize(editorScrollDOM, { scrollHeight: EDITOR_CLIENT_HEIGHT, clientHeight: EDITOR_CLIENT_HEIGHT });
      renderHook(() => useScrollSync({ editorRef, previewRef, enabled: true }));
      expect(() => scrollEditorTo(0)).not.toThrow();
      expect(previewContainer.scrollTop).toBe(0);
    });
  });

  describe('reverse (preview -> editor)', () => {
    it('pins the editor to scrollTop 0 when the preview is at its top', () => {
      renderHook(() => useScrollSync({ editorRef, previewRef, enabled: true }));
      editorScrollDOM.scrollTop = 999; // start away from 0 so the pin is observable
      scrollPreviewTo(0);
      expect(editorScrollDOM.scrollTop).toBe(0);
      expect(editorRef.current?.scrollToLineProgressAt).not.toHaveBeenCalled();
    });

    it('pins the editor to its own max scrollTop when the preview is at its max', () => {
      renderHook(() => useScrollSync({ editorRef, previewRef, enabled: true }));
      scrollPreviewTo(PREVIEW_MAX);
      expect(editorScrollDOM.scrollTop).toBe(EDITOR_MAX);
      expect(editorRef.current?.scrollToLineProgressAt).not.toHaveBeenCalled();
    });

    it('at an intermediate position, drives the editor with the matching fractional line and echoes the viewport fraction', () => {
      renderHook(() => useScrollSync({ editorRef, previewRef, enabled: true }));
      scrollPreviewTo(PREVIEW_MAX / 2); // p = 0.5 exactly
      expect(editorRef.current?.scrollToLineProgressAt).toHaveBeenCalledTimes(1);
      const [line, ratio, viewportFraction] = editorRef.current?.scrollToLineProgressAt.mock.calls[0] as [number, number, number];
      // referenceY = scrollTop + 0.5*clientHeight = PREVIEW_MAX/2 + 400, which
      // sits strictly between the markers at fractional line 50 and 100.
      expect(line + ratio).toBeGreaterThan(50);
      expect(line + ratio).toBeLessThan(100);
      expect(viewportFraction).toBeCloseTo(0.5, 5);
    });

    it('degenerates to progress 0 (pins to editor top) when the preview pane cannot scroll', () => {
      setPaneSize(previewContainer, { scrollHeight: PREVIEW_CLIENT_HEIGHT, clientHeight: PREVIEW_CLIENT_HEIGHT });
      renderHook(() => useScrollSync({ editorRef, previewRef, enabled: true }));
      editorScrollDOM.scrollTop = 999;
      expect(() => scrollPreviewTo(0)).not.toThrow();
      expect(editorScrollDOM.scrollTop).toBe(0);
      expect(editorRef.current?.scrollToLineProgressAt).not.toHaveBeenCalled();
    });
  });

  describe('recursion guard (no oscillation)', () => {
    it('absorbs a reflected preview scroll fired while the editor->preview lock is still held', () => {
      renderHook(() => useScrollSync({ editorRef, previewRef, enabled: true }));
      scrollEditorTo(EDITOR_MAX / 2);
      const previewScrollTopAfterForward = previewContainer.scrollTop;

      // Simulate the browser's own reflected 'scroll' event firing on the
      // preview BEFORE the next animation frame clears the lock — this must
      // be a no-op (early return), not a reflex back into the editor.
      act(() => {
        previewContainer.dispatchEvent(new Event('scroll'));
      });

      expect(editorRef.current?.scrollToLineProgressAt).not.toHaveBeenCalled();
      expect(previewContainer.scrollTop).toBe(previewScrollTopAfterForward);
    });

    it('absorbs a reflected editor scroll fired while the preview->editor lock is still held', () => {
      renderHook(() => useScrollSync({ editorRef, previewRef, enabled: true }));
      // Give the editor pane a non-trivial, non-pinned scrollTop so a
      // leaked reflex would visibly move the preview to a computably
      // different position, not coincidentally land on the same spot.
      editorScrollDOM.scrollTop = EDITOR_MAX / 4;
      scrollPreviewTo(PREVIEW_MAX / 2);
      const previewScrollTopAfterReverse = previewContainer.scrollTop; // untouched by reverse sync

      act(() => {
        editorScrollDOM.dispatchEvent(new Event('scroll'));
      });

      // Blocked by the lock: the reflected event must not drive a forward
      // sync (which would have overwritten previewContainer.scrollTop).
      expect(previewContainer.scrollTop).toBe(previewScrollTopAfterReverse);
    });
  });

  it('removes its listeners on unmount', () => {
    const { unmount } = renderHook(() => useScrollSync({ editorRef, previewRef, enabled: true }));
    unmount();
    scrollEditorTo(EDITOR_MAX);
    expect(previewContainer.scrollTop).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Regression: the document TAIL — the stretch of source lines after the last
// `[data-source-line]` anchor. Anchors are only injected on top-level mdast
// nodes (`injectSourceLineAnchors`, 1-based `position.start.line`), so a
// trailing list / paragraph contributes ONE anchor at its first line while
// the editor keeps scrolling through the rest of its lines plus CodeMirror's
// bottom padding. Reported symptom: scrolling the editor down through that
// tail made the preview drift back UP and then snap down at the very end.
// ---------------------------------------------------------------------------
describe('useScrollSync — tail past the last anchor', () => {
  const LINE_COUNT = 100;
  // Last anchor at line 80 (e.g. the `- hoge` line of a trailing list), while
  // the editor's own scroll range runs to fractional line LINE_COUNT + 1.
  const LAST_ANCHOR_LINE = 80;
  const LAST_ANCHOR_TOP = 8000;

  let editorScrollDOM: HTMLElement;
  let previewContainer: HTMLElement;
  let editorRef: RefObject<MockHandle | null>;
  let previewRef: RefObject<HTMLElement | null>;

  /**
   * 1-based counterpart of the outer suite's probe: `p=0` lands on line 1 and
   * `p=1` on `LINE_COUNT + 1` (the real `getProgressAt` clamps `ratio` to 1 on
   * the last line when the probe falls into the editor's bottom padding).
   */
  function getProgressAt(fraction: number): { line: number; ratio: number } {
    const fractional = 1 + Math.max(0, Math.min(1, fraction)) * LINE_COUNT;
    const line = Math.floor(fractional);
    return { line, ratio: fractional - line };
  }

  beforeEach(() => {
    editorScrollDOM = document.createElement('div');
    setPaneSize(editorScrollDOM, { scrollHeight: EDITOR_SCROLL_HEIGHT, clientHeight: EDITOR_CLIENT_HEIGHT });
    document.body.appendChild(editorScrollDOM);

    previewContainer = document.createElement('div');
    setPaneSize(previewContainer, { scrollHeight: PREVIEW_SCROLL_HEIGHT, clientHeight: PREVIEW_CLIENT_HEIGHT });
    document.body.appendChild(previewContainer);
    addMarker(previewContainer, 1, 0);
    addMarker(previewContainer, 50, 5000);
    addMarker(previewContainer, LAST_ANCHOR_LINE, LAST_ANCHOR_TOP);

    editorRef = { current: makeEditorHandle(editorScrollDOM, getProgressAt, LINE_COUNT) };
    previewRef = { current: previewContainer };
  });

  afterEach(() => {
    editorScrollDOM.remove();
    previewContainer.remove();
  });

  function previewScrollTopForEditorProgress(p: number): number {
    editorScrollDOM.scrollTop = p * EDITOR_MAX;
    act(() => {
      editorScrollDOM.dispatchEvent(new Event('scroll'));
    });
    return previewContainer.scrollTop;
  }

  it('never scrolls the preview backwards while the editor scrolls forwards through the tail', () => {
    renderHook(() => useScrollSync({ editorRef, previewRef, enabled: true }));

    const samples: { p: number; top: number }[] = [];
    for (let step = 0; step <= 100; step++) {
      const p = step / 100;
      samples.push({ p, top: previewScrollTopForEditorProgress(p) });
    }

    const regressions = samples.filter((s, i) => i > 0 && s.top < samples[i - 1].top - 0.5);
    expect(regressions).toEqual([]);
  });

  it('reaches the preview bottom continuously instead of snapping at the last moment', () => {
    renderHook(() => useScrollSync({ editorRef, previewRef, enabled: true }));

    // Probe just OUTSIDE the pin zone: inside it the endpoint pin already
    // returns the exact bottom, which would hide the discontinuity the pin
    // itself creates. The step from there to the pinned end must be small —
    // a large delta is exactly the visible "ガクッ" jump.
    const nearEnd = previewScrollTopForEditorProgress(1 - 2 * SLIDING_REFERENCE_EPSILON);
    const atEnd = previewScrollTopForEditorProgress(1);
    expect(atEnd).toBe(PREVIEW_MAX);
    expect(atEnd - nearEnd).toBeLessThan(0.02 * PREVIEW_MAX);
  });

  it('drives the editor past the last anchor when the preview scrolls into its tail (reverse direction)', () => {
    renderHook(() => useScrollSync({ editorRef, previewRef, enabled: true }));

    // `editorFractionalLineForPreviewY` shared the same clamp, so a preview
    // position inside the tail used to resolve to the LAST ANCHOR's line and
    // strand the editor there however far the preview scrolled.
    previewContainer.scrollTop = 0.95 * PREVIEW_MAX;
    act(() => {
      previewContainer.dispatchEvent(new Event('scroll'));
    });

    expect(editorRef.current?.scrollToLineProgressAt).toHaveBeenCalledTimes(1);
    const [line, ratio] = editorRef.current?.scrollToLineProgressAt.mock.calls[0] as [number, number, number];
    expect(line + ratio).toBeGreaterThan(LAST_ANCHOR_LINE);
  });

  it('keeps the tail visible: an edit near the document end shows the preview end', () => {
    renderHook(() => useScrollSync({ editorRef, previewRef, enabled: true }));

    // Editing a few lines above the very bottom leaves the editor slightly
    // short of its max scroll (trailing padding). The preview must still have
    // its own tail on screen, not be parked ~4000px above it.
    const top = previewScrollTopForEditorProgress(0.97);
    expect(top).toBeGreaterThan(PREVIEW_MAX - PREVIEW_CLIENT_HEIGHT);
  });
});
