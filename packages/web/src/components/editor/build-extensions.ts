import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { autocompleteExtension } from './autocomplete-extension';
import { dropHandler } from './drop-handler';
import { imageAffordanceExtension } from './image-affordance-extension';
import { linkCardAffordanceExtension } from './link-card-affordance-extension';
import { listKeymap } from './list-keymap';
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
  /**
   * RFC-0004 Phase 7 — enable the drag-and-drop upload handler. Like
   * `paste`, requires the owning `pageId` for the upload's
   * write-permission check. D&D is read-only-aware at drop time
   * (`EditorState.readOnly`), so the same builder output works for both
   * the writable and the cap-reached read-only editor. Omit for bare
   * mounts / tests with no page context.
   */
  dnd?: { pageId: string };
  /**
   * feature-renderer-plugin-boundary Phase 3 — gate the link-card
   * conversion affordance on the `link-card` app-info capability
   * (`useAppInfo().data?.capabilities.includes('link-card')`, admin
   * Security `security:linkCardEnabled` toggle, default-on). `undefined`
   * / omitted behaves like `true` (the caller hasn't resolved the
   * capability yet, or doesn't care) — same optimistic-default-on
   * pattern the toggle itself uses server-side.
   */
  linkCardEnabled?: boolean;
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
 *  - `markdown({ addKeymap: false })` first so syntax-highlighting +
 *    langauge-aware indent decisions see the language definition.
 *    `addKeymap: false` opts out of the upstream `markdownKeymap`
 *    (Backspace's markup-aware delete + a `Prec.high` Enter that would
 *    otherwise shadow `listKeymap`'s Enter below) — see the inline
 *    comment at the `markdown(...)` call.
 *  - `syntaxHighlighting(defaultHighlightStyle)` second so the tag tree
 *    set up by `markdown()` is themed.
 *  - `history()` + `keymap.of([listKeymap, defaultKeymap, historyKeymap])`
 *    next so the editor has the cross-platform defaults Cmd/Ctrl-Z, etc.
 *    `listKeymap` (RFC-0005) is listed first so its Enter / Tab bindings
 *    win over `defaultKeymap`'s — `keymap` tries higher-precedence
 *    bindings first and falls through on a `false` return, so the Tab
 *    bindings only intercept Tab when the cursor is inside a markdown
 *    list (otherwise the editor's default focus-move Tab is preserved).
 *  - `readonly` toggle as `EditorState.readOnly.of(true)` when on, so a
 *    no-op (empty array) when off — extensions can be `[]` and unified
 *    flattens them.
 *  - `EditorView.updateListener.of(...)` to bridge document changes
 *    back to React state. We skip the dispatch when no `onChange` is
 *    supplied so build-extensions stays cheap to call from tests.
 *  - `autocompleteExtension()` after the markdown language so its
 *    completion source can read the markdown syntax tree (suppression
 *    contexts), before `extraExtensions` so a caller can still layer.
 *  - `pasteHandler` / `dropHandler` after autocomplete and before
 *    `extraExtensions` — both attach DOM event handlers, so ordering vs
 *    autocomplete is immaterial, but keeping them before
 *    `extraExtensions` lets a caller still override.
 *  - `imageAffordanceExtension()` (RFC-0015 §D13) — the image
 *    display-attribute hover/focus tooltip. A built-in (not threaded
 *    through `extraExtensions`) so both the normal and collaborative
 *    editor get it without a new prop; it reads `EditorState.readOnly`
 *    itself (same source as `dropHandler`'s suppression), so ordering
 *    relative to the `readonly` facet below is immaterial.
 *  - `linkCardAffordanceExtension()` — the bare-URL <-> `@[card](url)`
 *    conversion tooltip. Same built-in / always-on / self-gating-on-
 *    readonly pattern as `imageAffordanceExtension()` immediately
 *    above; ordering between the two is immaterial (they never target
 *    overlapping syntax spans). feature-renderer-plugin-boundary
 *    Phase 3 — gated on `linkCardEnabled` (default `true`) so a
 *    disabled `security:linkCardEnabled` admin toggle also suppresses
 *    the editor's own `@[card](url)` conversion affordance.
 *  - `extraExtensions` last so caller-supplied extensions win on
 *    precedence ties (CodeMirror layers later extensions on top).
 */
export function buildExtensions(props: BuildExtensionsProps): Extension[] {
  const { readonly = false, extraExtensions, onChange, disableHistory = false, autocomplete = true, paste, dnd, linkCardEnabled = true } = props;
  return [
    // `addKeymap: false` opts out of the upstream `markdownKeymap`
    // (Backspace → `deleteMarkupBackward`, `Prec.high` Enter →
    // `insertNewlineContinueMarkup`) — Crowi owns its own Enter / Tab /
    // Shift-Tab bindings below (`listKeymap`), and letting the upstream
    // `Prec.high` Enter through was shadowing `continueListMarkup`'s
    // tight continuation. Backspace now falls through to
    // `defaultKeymap`'s `deleteCharBackward` (plain one-character
    // delete, readonly-guarded) instead of the markup-aware upstream
    // command, which no longer strips a list marker or a blockquote's
    // `> ` when pressed right after it.
    markdown({ addKeymap: false }),
    syntaxHighlighting(defaultHighlightStyle),
    // Soft-wrap long lines instead of scrolling horizontally. A wiki
    // editor is prose-first, so a textarea-like wrap reads far better
    // than an off-screen overflow — especially on mobile, where a
    // horizontal scroll to reach the end of a paragraph is painful.
    EditorView.lineWrapping,
    autocomplete ? autocompleteExtension() : [],
    // RFC-0004 Phase 6 — paste handler (URL smart-link + image upload).
    // Placed before `extraExtensions` so a caller-supplied paste handler
    // (none today) could still take precedence; a no-op `[]` when the
    // caller passes no page context.
    paste ? pasteHandler({ pageId: paste.pageId }) : [],
    // RFC-0004 Phase 7 — drag-and-drop upload handler. Independent of
    // the paste handler (different DOM events) and likewise a no-op `[]`
    // without a page context. Read-only suppression is decided per drop
    // from `EditorState.readOnly`, so this needs no readonly prop.
    dnd ? dropHandler({ pageId: dnd.pageId }) : [],
    // RFC-0015 §D13 — image display-attribute affordance, always on
    // (no opt-out prop — it's read-only-aware on its own, mirroring
    // `dropHandler`'s pattern, so there's no bare-mount case it needs
    // to be excluded from).
    imageAffordanceExtension(),
    // Link-card conversion affordance (bare URL <-> `@[card](url)`) —
    // same "always on, read-only-aware on its own" pattern as
    // `imageAffordanceExtension()` immediately above, now gated on the
    // `link-card` capability (feature-renderer-plugin-boundary Phase 3).
    linkCardEnabled ? linkCardAffordanceExtension() : [],
    // RFC-0003 Phase 7: skip the built-in undo stack + its keymap when
    // a Yjs `UndoManager` is taking over via `extraExtensions`. The
    // `defaultKeymap` is kept (it carries cursor / selection / line
    // editing bindings that are doc-shape agnostic and harmless).
    disableHistory ? [] : history(),
    // RFC-0005: `listKeymap` first so its Enter (tight list continuation,
    // fixing the loose-list blank-line bug) and Tab / Shift-Tab (list
    // indent / dedent) bindings take precedence; each falls through to
    // `defaultKeymap` when it returns `false` (cursor not in a list).
    keymap.of([...listKeymap, ...defaultKeymap, ...(disableHistory ? [] : historyKeymap)]),
    readonly ? EditorState.readOnly.of(true) : [],
    onChange
      ? EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange(update.state.doc.toString());
        })
      : [],
    ...(extraExtensions ?? []),
  ];
}
