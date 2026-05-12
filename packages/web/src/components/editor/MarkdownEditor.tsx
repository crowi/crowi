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
    }),
    [],
  );

  return <div ref={containerRef} className={className} aria-label={ariaLabel} role="textbox" aria-multiline="true" />;
});
