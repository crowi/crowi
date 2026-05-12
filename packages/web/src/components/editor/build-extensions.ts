import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';

export interface BuildExtensionsProps {
  readonly?: boolean;
  /**
   * Caller-supplied CodeMirror extensions appended after the baseline.
   * Reserved for RFC-0003 Phase 7 where `yCollab(yText, awareness)` is
   * threaded in — this spec intentionally does not import yjs deps.
   */
  extraExtensions?: Extension[];
  /**
   * Invoked on every document change. Kept here (and not as a separate
   * extension owned by the React component) so the entire wiring lives
   * in one builder — both production code and tests assemble the same
   * extension list. The component uses `useEffect` to mount the view
   * with the result of this builder once per session.
   */
  onChange?: (next: string) => void;
}

/**
 * Compute the CodeMirror 6 extension list used by `MarkdownEditor`.
 *
 * Exported as a standalone function so:
 *  1. RFC-0003 Phase 7 can call it with `extraExtensions: [yCollab(...)]`
 *     without forking the editor component.
 *  2. The pure-function part of the editor (which extensions are wired
 *     and in what order) is testable without a DOM — we don't run the
 *     view itself, just verify the produced array.
 *
 * Order rationale:
 *  - `markdown()` first so syntax-highlighting + langauge-aware indent
 *    decisions see the language definition.
 *  - `syntaxHighlighting(defaultHighlightStyle)` second so the tag tree
 *    set up by `markdown()` is themed.
 *  - `history()` + `keymap.of([defaultKeymap, historyKeymap])` next so
 *    the editor has the cross-platform defaults Cmd/Ctrl-Z, etc.
 *  - `readonly` toggle as `EditorState.readOnly.of(true)` when on, so a
 *    no-op (empty array) when off — extensions can be `[]` and unified
 *    flattens them.
 *  - `EditorView.updateListener.of(...)` to bridge document changes
 *    back to React state. We skip the dispatch when no `onChange` is
 *    supplied so build-extensions stays cheap to call from tests.
 *  - `extraExtensions` last so caller-supplied extensions win on
 *    precedence ties (CodeMirror layers later extensions on top).
 */
export function buildExtensions(props: BuildExtensionsProps): Extension[] {
  const { readonly = false, extraExtensions, onChange } = props;
  return [
    markdown(),
    syntaxHighlighting(defaultHighlightStyle),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    readonly ? EditorState.readOnly.of(true) : [],
    onChange
      ? EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange(update.state.doc.toString());
        })
      : [],
    ...(extraExtensions ?? []),
  ];
}
