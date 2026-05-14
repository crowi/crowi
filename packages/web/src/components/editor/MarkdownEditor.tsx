'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { Extension } from '@codemirror/state';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { buildExtensions } from './build-extensions';

export interface MarkdownEditorProps {
  value: string;
  onChange: (next: string) => void;
  readonly?: boolean;
  /**
   * Phase 7 (RFC-0003) hook for `yCollab(yText, awareness)`. Caller-
   * supplied extensions are flushed onto the end of `buildExtensions`
   * output. We intentionally keep this as a CodeMirror `Extension[]`
   * rather than a higher-level wrapper so realtime can layer cleanly.
   */
  extraExtensions?: Extension[];
  /** Forwarded to the wrapper `<div>` for layout / shadcn theming. */
  className?: string;
  /** Optional aria-label for the editor surface. */
  'aria-label'?: string;
}

export interface MarkdownEditorHandle {
  /**
   * Insert `snippet` at the current cursor position and focus the
   * editor. Returns the resulting cursor offset so callers (e.g.
   * `AttachmentInsertButton`) can verify the dispatch without poking
   * at internals.
   */
  insertAtCursor(snippet: string): number;
  /**
   * The scrollable DOM element CodeMirror owns (`view.scrollDOM`).
   * Exposed so the scroll-sync hook can attach a `scroll` listener
   * without depending on internal CodeMirror APIs at the callsite.
   * Returns `null` when the view hasn't mounted yet.
   */
  getScrollDOM(): HTMLElement | null;
  /**
   * The 1-based source line anchored at the top of the editor's
   * visible viewport, plus the fractional offset (`0..1`) inside that
   * line's vertical block. Combining the two gives a continuous
   * "fractional line" (`line + ratio`) so scroll-sync stays smooth
   * across long blocks (code fences, multi-line lists) instead of
   * snapping each time the top-line integer changes.
   *
   * Returns `null` if the view hasn't mounted.
   */
  getTopProgress(): { line: number; ratio: number } | null;
  /**
   * Scroll the editor so `line` (1-based) sits at the top of the
   * viewport, offset by `ratio` (`0..1`) of that line block's height.
   * Pairs with `getTopProgress()` for symmetric preview→editor sync.
   * No-op if `line` is out of document bounds or values are non-finite.
   */
  scrollToLineProgress(line: number, ratio: number): void;
}

/**
 * Controlled CodeMirror 6 wrapper. Owns a single `EditorView` mounted
 * once per session (no `@uiw/react-codemirror` indirection — RFC-0003
 * Phase 7 needs raw access to dispatch yCollab updates). The view is
 * the source of truth between renders; `value` only sets the initial
 * doc and corrects drift when the parent state changes externally.
 *
 * Echo avoidance: on every render we compare `value` against
 * `view.state.doc.toString()` and only dispatch a replace transaction
 * when they differ. Without this guard, the `onChange` listener would
 * re-fire for our own dispatches and produce a render loop.
 */
export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(function MarkdownEditor(props, ref) {
  const { value, onChange, readonly, extraExtensions, className, 'aria-label': ariaLabel } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Stable refs for callbacks so the mount effect can fire once. Without
  // these the editor would tear down + remount on every parent render
  // where the inline `onChange` closure changes identity, blowing away
  // selection / undo history.
  const onChangeRef = useRef(onChange);
  const extraExtensionsRef = useRef<Extension[] | undefined>(extraExtensions);
  const readonlyRef = useRef<boolean>(readonly ?? false);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    extraExtensionsRef.current = extraExtensions;
  }, [extraExtensions]);
  useEffect(() => {
    readonlyRef.current = readonly ?? false;
  }, [readonly]);

  // Mount the EditorView once. Initial doc comes from `value` at mount
  // time; subsequent external updates flow through the sync effect below.
  useEffect(() => {
    const parent = containerRef.current;
    if (!parent) return;
    const state = EditorState.create({
      doc: value,
      extensions: buildExtensions({
        readonly: readonlyRef.current,
        extraExtensions: extraExtensionsRef.current,
        onChange: (next) => onChangeRef.current?.(next),
      }),
    });
    const view = new EditorView({ state, parent });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Intentionally empty deps: see comment above about teardown cost.
    // `value` is synced via the next effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync `value` prop → editor doc when they diverge. Echo guard:
  // skip the dispatch when the buffers already match, otherwise the
  // updateListener would push the same string back through `onChange`.
  // Selection is preserved across the corrective dispatch so that a
  // racing parent-state-driven sync doesn't collapse the user's
  // current cursor / selection range.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      selection: view.state.selection,
    });
  }, [value]);

  useImperativeHandle(
    ref,
    () => ({
      insertAtCursor(snippet) {
        const view = viewRef.current;
        if (!view) return 0;
        const from = view.state.selection.main.head;
        const cursorAfter = from + snippet.length;
        view.dispatch({
          changes: { from, insert: snippet },
          selection: { anchor: cursorAfter },
        });
        view.focus();
        return cursorAfter;
      },
      getScrollDOM() {
        return viewRef.current?.scrollDOM ?? null;
      },
      getTopProgress() {
        const view = viewRef.current;
        if (!view) return null;
        const editorRect = view.scrollDOM.getBoundingClientRect();
        const probeY = editorRect.top + 1;
        // `posAtCoords` is reliable here — we probe the visible
        // top of the editor, which is always inside the rendered
        // viewport that CodeMirror lays out.
        const pos = view.posAtCoords({ x: editorRect.left + view.defaultCharacterWidth, y: probeY });
        if (pos == null) return null;
        const block = view.lineBlockAt(pos);
        // `documentTop + block.top` gives the block's screen-coord y
        // regardless of whether CM has currently rendered the block
        // (`coordsAtPos` returns `null` for off-viewport positions,
        // which silently corrupts the `ratio` math when fallback
        // kicks in). Mixing one CM value (`documentTop`, screen
        // coord of the document's top) with one document coord
        // (`block.top`) is the project-blessed pattern.
        const blockScreenTop = view.documentTop + block.top;
        const ratio = block.height > 0 ? (probeY - blockScreenTop) / block.height : 0;
        return {
          line: view.state.doc.lineAt(block.from).number,
          ratio: Math.max(0, Math.min(1, ratio)),
        };
      },
      scrollToLineProgress(line, ratio) {
        const view = viewRef.current;
        if (!view) return;
        if (!Number.isFinite(line) || !Number.isFinite(ratio)) return;
        const total = view.state.doc.lines;
        const clampedLine = Math.max(1, Math.min(line, total));
        const clampedRatio = Math.max(0, Math.min(1, ratio));
        const pos = view.state.doc.line(clampedLine).from;
        const block = view.lineBlockAt(pos);
        const editorTop = view.scrollDOM.getBoundingClientRect().top;
        // Same `documentTop + block.top` trick as `getTopProgress` —
        // critical when the target line is currently far from the
        // viewport (preview→editor for a big jump). `coordsAtPos`
        // would return `null` there and the fallback to `editorTop`
        // produced a positive `delta` that scrolled the wrong way.
        const blockScreenTop = view.documentTop + block.top;
        // Relative scroll: shift the scroller by (where the block is
        // now relative to the editor top) + (the in-block offset).
        const delta = blockScreenTop - editorTop + block.height * clampedRatio;
        view.scrollDOM.scrollTop += delta;
      },
    }),
    [],
  );

  return <div ref={containerRef} className={className} aria-label={ariaLabel} role="textbox" aria-multiline="true" />;
});
