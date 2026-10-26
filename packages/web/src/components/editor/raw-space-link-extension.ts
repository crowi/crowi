import { highlightingFor, syntaxTree } from '@codemirror/language';
import { type EditorState, type Extension, RangeSetBuilder } from '@codemirror/state';
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { isRawSpaceLinkRecoverable, scanRawSpaceLinkGrammar } from '@crowi/api-contract';
import { tags } from '@lezer/highlight';

/**
 * Colours `[label](/path with spaces)` like a normal link. CommonMark does not
 * parse that shape as a link, so the editor's Lezer tree leaves `(/path ...)`
 * as plain text, while the renderer recovers it as a link. The grammar and the
 * accept/reject rules come from `@crowi/api-contract` (shared with the
 * renderer); the structural exclusions (code, HTML, existing links, ...) are
 * decided here against the Lezer tree, because the renderer decides them
 * against its own mdast.
 */

export interface RawSpaceLinkSpan {
  /** `[` */
  from: number;
  /** just after `)` */
  to: number;
  /** just after `(` */
  destinationFrom: number;
  /** just before `)` */
  destinationTo: number;
}

/** Nodes a candidate may overlap and still be a link in the renderer. */
const ALLOWED_NODES = new Set([
  'Document',
  'Paragraph',
  'Blockquote',
  'BulletList',
  'OrderedList',
  'ListItem',
  'ATXHeading1',
  'ATXHeading2',
  'ATXHeading3',
  'ATXHeading4',
  'ATXHeading5',
  'ATXHeading6',
  'SetextHeading1',
  'SetextHeading2',
  // The renderer resolves escapes and character references into the same text node, so a label containing them is still recovered.
  'LinkMark',
  'Escape',
  'Entity',
]);

/** Whether the Lezer tree leaves the candidate `[s, e)` as plain inline text (apart from the `[label]` reference-link shape Lezer always produces). */
function isPlainTextInTree(state: EditorState, s: number, e: number, labelLength: number): boolean {
  let ok = true;
  syntaxTree(state).iterate({
    from: s,
    to: e,
    enter(node) {
      if (!ok) return false;
      // `iterate` also visits nodes that merely touch the range.
      if (node.to <= s || node.from >= e) return false;
      if (ALLOWED_NODES.has(node.name)) return;
      // Lezer does not match reference definitions, so it always reports `[label]` as a reference-style Link.
      if (node.name === 'Link' && node.from === s && node.to === s + labelLength + 2) return;
      ok = false;
      return false;
    },
  });
  return ok;
}

export function findRawSpaceLinkSpans(state: EditorState, ranges: readonly { from: number; to: number }[]): RawSpaceLinkSpan[] {
  const treeLength = syntaxTree(state).length;
  const clamped = ranges.map((r) => ({ from: r.from, to: Math.min(r.to, treeLength) })).filter((r) => r.from < r.to);
  const doc = state.doc;
  const seenLines = new Set<number>();
  const spans: RawSpaceLinkSpan[] = [];

  for (const range of clamped) {
    for (let line = doc.lineAt(range.from); ; line = doc.line(line.number + 1)) {
      if (!seenLines.has(line.from)) {
        seenLines.add(line.from);
        for (const m of scanRawSpaceLinkGrammar(line.text)) {
          if (!isRawSpaceLinkRecoverable(line.text, m, { source: line.text, start: m.start })) continue;
          const from = line.from + m.start;
          const to = line.from + m.end;
          if (to > treeLength) continue;
          if (!clamped.some((r) => from < r.to && to > r.from)) continue;
          if (!isPlainTextInTree(state, from, to, m.label.length)) continue;
          spans.push({ from, to, destinationFrom: from + m.label.length + 3, destinationTo: to - 1 });
        }
      }
      if (line.to >= range.to || line.number >= doc.lines) break;
    }
  }
  return spans.sort((a, b) => a.from - b.from);
}

/** The same classes Lezer's `LinkMark` / `URL` nodes get, resolved against whichever highlighter is active. */
export function buildRawSpaceLinkDecorations(state: EditorState, ranges: readonly { from: number; to: number }[]): DecorationSet {
  const markClass = highlightingFor(state, [tags.link, tags.processingInstruction]);
  const urlClass = highlightingFor(state, [tags.link, tags.url]);
  const marks = markClass ? Decoration.mark({ class: markClass }) : null;
  const url = urlClass ? Decoration.mark({ class: urlClass }) : null;
  const builder = new RangeSetBuilder<Decoration>();
  for (const span of findRawSpaceLinkSpans(state, ranges)) {
    if (marks) builder.add(span.destinationFrom - 1, span.destinationFrom, marks);
    if (url) builder.add(span.destinationFrom, span.destinationTo, url);
    if (marks) builder.add(span.destinationTo, span.to, marks);
  }
  return builder.finish();
}

export function rawSpaceLinkExtension(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildRawSpaceLinkDecorations(view.state, view.visibleRanges);
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state) ||
          update.transactions.some((tr) => tr.reconfigured)
        ) {
          this.decorations = buildRawSpaceLinkDecorations(update.view.state, update.view.visibleRanges);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}
