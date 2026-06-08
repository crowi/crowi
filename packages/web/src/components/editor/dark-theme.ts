import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

/**
 * Dark editor theme for the Crowi `MarkdownEditor` (dark-mode feature,
 * Phase 2).
 *
 * The editor's baseline (`build-extensions.ts`) wires
 * `syntaxHighlighting(defaultHighlightStyle)`, which targets light
 * backgrounds. CodeMirror has no built-in dark theme and we don't carry
 * `@codemirror/theme-one-dark` as a dependency, so we define a minimal
 * one here: an `EditorView.theme({...}, { dark: true })` for the chrome
 * (surface / cursor / selection / gutter) plus a matching
 * `HighlightStyle` for markdown syntax tokens.
 *
 * Colours are aligned with the app's `.dark` tokens (slate-ish surface,
 * github-dark-leaning token hues) so the editor reads as part of the
 * dark UI rather than a foreign widget. We keep this deliberately small —
 * full re-theming is out of scope; this just has to be legible.
 *
 * Applied via a CodeMirror `Compartment` in `MarkdownEditor`, reconfigured
 * from `useTheme()` (`next-themes` `resolvedTheme`) so it tracks the app
 * theme without a view rebuild.
 */

const darkBackground = '#0f172a';
const darkSurface = '#111827';
const darkForeground = '#e2e8f0';
const darkCursor = '#e2e8f0';
const darkSelection = '#1e3a5f';
const darkGutterForeground = '#64748b';
const darkComment = '#64748b';
// Markdown syntax marks (`#`, `**`, `` ` ``, `>`, list bullets). Tagged
// `processingInstruction` by @lezer/markdown; kept lighter than `darkComment`
// so the markup stays visible on the dark surface instead of sinking in.
const darkMark = '#94a3b8';
const darkAccent = '#7dd3fc';
const darkString = '#9ece6a';
const darkKeyword = '#f472b6';
const darkHeading = '#93c5fd';
const darkLink = '#7dd3fc';

const editorDarkTheme = EditorView.theme(
  {
    '&': {
      color: darkForeground,
      backgroundColor: darkBackground,
    },
    '.cm-content': {
      caretColor: darkCursor,
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: darkCursor,
    },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: darkSelection,
    },
    '.cm-activeLine': {
      backgroundColor: 'rgba(148, 163, 184, 0.06)',
    },
    '.cm-gutters': {
      backgroundColor: darkSurface,
      color: darkGutterForeground,
      border: 'none',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'rgba(148, 163, 184, 0.08)',
    },
    '.cm-tooltip': {
      backgroundColor: darkSurface,
      border: '1px solid rgba(148, 163, 184, 0.2)',
      color: darkForeground,
    },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: darkSelection,
      color: darkForeground,
    },
  },
  { dark: true },
);

const editorDarkHighlightStyle = HighlightStyle.define([
  { tag: t.heading, color: darkHeading, fontWeight: 'bold' },
  { tag: t.strong, color: darkForeground, fontWeight: 'bold' },
  { tag: t.emphasis, color: darkForeground, fontStyle: 'italic' },
  { tag: [t.link, t.url], color: darkLink, textDecoration: 'underline' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: darkComment, fontStyle: 'italic' },
  { tag: [t.keyword, t.modifier, t.operatorKeyword], color: darkKeyword },
  { tag: [t.string, t.special(t.string)], color: darkString },
  { tag: [t.number, t.bool, t.atom], color: darkAccent },
  { tag: [t.propertyName, t.attributeName], color: darkAccent },
  { tag: [t.monospace], color: darkAccent },
  { tag: t.contentSeparator, color: darkComment },
  // Syntax marks: heading `#`, emphasis `*`/`**`, code `` ` ``, quote `>`,
  // list bullets. Without this they fall back to the light-oriented
  // `defaultHighlightStyle` and disappear against the dark background.
  { tag: [t.processingInstruction, t.meta], color: darkMark },
]);

/**
 * Dark editor extension bundle: chrome theme + syntax highlight style.
 */
export const editorDarkExtension: Extension = [editorDarkTheme, syntaxHighlighting(editorDarkHighlightStyle)];

/**
 * Resolve the editor theme extension for the current app theme.
 *
 * `next-themes`' `resolvedTheme` is `'dark'` only when the effective
 * theme is dark (`'dark'` chosen, or `'system'` + OS dark). Anything else
 * (light, or `undefined` before mount) returns `[]` so the baseline
 * `defaultHighlightStyle` (light) keeps applying.
 */
export function editorThemeExtension(resolvedTheme: string | undefined): Extension {
  return resolvedTheme === 'dark' ? editorDarkExtension : [];
}
