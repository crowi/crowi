import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { autocompleteExtension } from './autocomplete-extension';
import { pasteHandler } from './paste-handler';

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
  /**
   * RFC-0003 Phase 7 — suppress CodeMirror's `history()` extension +
   * `historyKeymap`. When `yCollab` is supplied via `extraExtensions`,
   * its `Y.UndoManager` replaces the editor's local history stack so
   * undo / redo operate on Yjs deltas (= self-only, remote-edit aware)
   * instead of the raw doc string. Two histories living in parallel
   * would otherwise let Cmd/Ctrl-Z rewind through remote edits and
   * desync the Y.Text from the EditorView's doc. Default `false` keeps
   * the editor-foundation behaviour untouched for non-collab callers.
   */
  disableHistory?: boolean;
  /**
   * RFC-0004 Phase 5 — enable the `@username` / `[[page]]` autocomplete
   * extension. Default `true` so every editor surface gets completion;
   * tests / bare mounts that don't want network-backed sources can
   * pass `false`.
   */
  autocomplete?: boolean;
  /**
   * RFC-0004 Phase 6 — enable the paste handler (URL smart-link +
   * image-blob upload). Requires the owning `pageId` so an image paste
   * can upload to the page. Omit (the default) for bare mounts / tests
   * that have no page context — the editor then uses CodeMirror's
   * default paste only.
   */
  paste?: { pageId: string };
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
 *  - `autocompleteExtension()` after the markdown language so its
 *    completion source can read the markdown syntax tree (suppression
 *    contexts), before `extraExtensions` so a caller can still layer.
 *  - `extraExtensions` last so caller-supplied extensions win on
 *    precedence ties (CodeMirror layers later extensions on top).
 */
export function buildExtensions(props: BuildExtensionsProps): Extension[] {
  const { readonly = false, extraExtensions, onChange, disableHistory = false, autocomplete = true, paste } = props;
  return [
    markdown(),
    syntaxHighlighting(defaultHighlightStyle),
    autocomplete ? autocompleteExtension() : [],
    // RFC-0004 Phase 6 — paste handler (URL smart-link + image upload).
    // Placed before `extraExtensions` so a caller-supplied paste handler
    // (none today) could still take precedence; a no-op `[]` when the
    // caller passes no page context.
    paste ? pasteHandler({ pageId: paste.pageId }) : [],
    // RFC-0003 Phase 7: skip the built-in undo stack + its keymap when
    // a Yjs `UndoManager` is taking over via `extraExtensions`. The
    // `defaultKeymap` is kept (it carries cursor / selection / line
    // editing bindings that are doc-shape agnostic and harmless).
    disableHistory ? [] : history(),
    keymap.of([...defaultKeymap, ...(disableHistory ? [] : historyKeymap)]),
    readonly ? EditorState.readOnly.of(true) : [],
    onChange
      ? EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange(update.state.doc.toString());
        })
      : [],
    ...(extraExtensions ?? []),
  ];
}
