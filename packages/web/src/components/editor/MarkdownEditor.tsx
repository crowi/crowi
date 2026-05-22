'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { buildExtensions } from './build-extensions';

export interface MarkdownEditorProps {
  value: string;
  /**
   * Collab mode only. When supplied, the initial document is read from
   * this callback **inside the mount effect** instead of from `value`.
   *
   * This closes a race for the realtime editor: `value` is captured at
   * render time, but the underlying Y.Text can receive a Hocuspocus
   * sync delta between render and the (passive) mount effect. Reading
   * the content in the effect guarantees the `EditorState` doc matches
   * Y.Text at the exact instant `yCollab`'s `ySyncPlugin` starts
   * observing it — `ySyncPlugin` only applies *future* deltas, so any
   * content already present at attach time must be in the initial doc
   * or it never renders.
   *
   * Its presence also marks the document as externally owned: the
   * `value`-sync effect is disabled so it can't clobber the shared
   * Y.Text (yCollab owns dispatch).
   */
  getInitialDoc?: () => string;
  /**
   * Document-change listener. Optional so RFC-0003 Phase 7's collab
   * wrapper can mount the editor with Y.Text-driven dispatch and skip
   * the update-listener that would otherwise fire on every yCollab
   * dispatch.
   */
  onChange?: (next: string) => void;
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
  /**
   * RFC-0003 Phase 7: suppress CodeMirror's `history()` + `historyKeymap`.
   * Set to `true` when the caller supplies a `yCollab(yText, awareness,
   * { undoManager })` extension so undo/redo operate at the Yjs delta
   * layer (= self-only) instead of stacking against the raw doc string.
   * Default `false` preserves single-user behaviour for non-collab
   * callers.
   */
  disableHistory?: boolean;
  /**
   * RFC-0004 Phase 6: enable the paste handler (URL smart-link + image
   * upload). Requires the owning `pageId` so an image paste can upload
   * to the page. Read once at mount (paste behaviour is page-scoped and
   * does not change for the editor's lifetime); omit for bare mounts.
   */
  paste?: { pageId: string };
  /**
   * RFC-0004 Phase 7: enable the drag-and-drop upload handler. Like
   * `paste`, requires the owning `pageId` and is read once at mount.
   * The handler is read-only-aware at drop time (it checks
   * `EditorState.readOnly`), so it does not need to be reconfigured
   * when the `readonly` prop flips. Omit for bare mounts.
   */
  dnd?: { pageId: string };
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
  const { value, getInitialDoc, onChange, readonly, extraExtensions, className, 'aria-label': ariaLabel, disableHistory, paste, dnd } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Collab mode is fixed for a mounted instance's lifetime (the collab
  // wrapper remounts via `key` when the session swaps), so capturing
  // `getInitialDoc` once at mount is correct — and required, since the
  // caller passes a fresh arrow identity every render.
  const getInitialDocRef = useRef(getInitialDoc);

  // Stable refs for callbacks so the mount effect can fire once. Without
  // these the editor would tear down + remount on every parent render
  // where the inline `onChange` closure changes identity, blowing away
  // selection / undo history.
  const onChangeRef = useRef(onChange);
  const readonlyRef = useRef<boolean>(readonly ?? false);
  const disableHistoryRef = useRef<boolean>(disableHistory ?? false);
  // Paste / D&D config is read once at mount; `pageId` does not change
  // for an editor session, so neither needs a sync effect.
  const pasteRef = useRef<{ pageId: string } | undefined>(paste);
  const dndRef = useRef<{ pageId: string } | undefined>(dnd);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    readonlyRef.current = readonly ?? false;
  }, [readonly]);
  useEffect(() => {
    disableHistoryRef.current = disableHistory ?? false;
  }, [disableHistory]);

  // Reconfigurable slots:
  //
  //   - `extra` lets the collab wrapper inject `yCollab(yText, awareness)`
  //     after the Hocuspocus handshake (~100 ms after mount). The
  //     editor stays mounted but the extension list hot-swaps.
  //   - `readonly` toggles the doc's writability without rebuilding the
  //     view. The same wrapper flips this off once Y.Text has been
  //     hydrated from the server (= editor goes from "pending readonly"
  //     to "live writable").
  //
  // Without compartments either slot would be frozen at mount-time and
  // the realtime flow couldn't transition the editor into a writable
  // state once the doc arrived.
  const extraCompartmentRef = useRef<Compartment>(new Compartment());
  const readonlyCompartmentRef = useRef<Compartment>(new Compartment());
  const readonlyExtension = (on: boolean): Extension => (on ? EditorState.readOnly.of(true) : []);

  // Mount the EditorView once. Initial doc comes from `value` at mount
  // time; subsequent external updates flow through the sync effect below.
  useEffect(() => {
    const parent = containerRef.current;
    if (!parent) return;
    // Wire the update listener only when the mount-time caller supplied
    // an `onChange`. The collab wrapper omits it so yCollab's own
    // dispatches don't fan out through a no-op listener.
    const onChangeAtMount = onChangeRef.current;
    const state = EditorState.create({
      // Collab mode reads the doc from `getInitialDoc()` here in the
      // effect so it reflects Y.Text at the exact moment `yCollab`
      // attaches — see the `getInitialDoc` prop docs.
      doc: getInitialDocRef.current ? getInitialDocRef.current() : value,
      extensions: [
        buildExtensions({
          // `readonly` is intentionally omitted here — the compartment
          // below owns its lifecycle.
          disableHistory: disableHistoryRef.current,
          onChange: onChangeAtMount ? (next) => onChangeRef.current?.(next) : undefined,
          paste: pasteRef.current,
          dnd: dndRef.current,
        }),
        readonlyCompartmentRef.current.of(readonlyExtension(readonlyRef.current)),
        extraCompartmentRef.current.of(extraExtensions ?? []),
      ],
    });
    const view = new EditorView({ state, parent });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Intentionally empty deps: see comment above about teardown cost.
    // `value` / `readonly` / `extraExtensions` flow through the dedicated
    // sync effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hot-swap the caller-supplied extensions whenever the parent updates
  // them. `Compartment.reconfigure` rebuilds only that slice of the
  // extension tree — no view rebuild, no selection / history loss.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: extraCompartmentRef.current.reconfigure(extraExtensions ?? []),
    });
  }, [extraExtensions]);

  // Reconfigure the readonly slot when the caller flips the prop. Same
  // shape as the extra-extensions hot-swap above.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readonlyCompartmentRef.current.reconfigure(readonlyExtension(readonly ?? false)),
    });
  }, [readonly]);

  // Sync `value` prop → editor doc when they diverge. Echo guard:
  // skip the dispatch when the buffers already match, otherwise the
  // updateListener would push the same string back through `onChange`.
  // Selection is preserved across the corrective dispatch so that a
  // racing parent-state-driven sync doesn't collapse the user's
  // current cursor / selection range.
  useEffect(() => {
    // Collab mode: yCollab owns the document. `value` is not
    // authoritative, and pushing it in here would clobber (or, when
    // `value=''`, delete) the shared Y.Text content.
    if (getInitialDocRef.current) return;
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
