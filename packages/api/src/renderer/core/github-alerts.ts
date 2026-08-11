import type { Blockquote, PhrasingContent, Root, RootContent, Text } from 'mdast';
import type { Position } from 'unist';
import type { UnifiedTransformPlugin } from './headings';

/**
 * Core renderer transform — retypes a document-root block quote whose
 * FIRST PHYSICAL SOURCE LINE is a GitHub Alerts marker (`> [!NOTE]` …)
 * into a Crowi-owned `crowiAlert` flow container.
 *
 * Marker recognition is deliberately anchored on the RAW `body`, not on
 * the parsed `text.value`: the parser normalises away exactly the
 * distinctions that decide whether an author wrote a marker or wrote
 * text that merely looks like one. `\[!NOTE]` and `&#91;!NOTE]` both
 * de-escape to the literal value `[!NOTE]`, and a hard-break marker line
 * (`> [!NOTE]··`) drops its trailing spaces — so a value-only check
 * would promote inputs GitHub itself leaves as an ordinary quote. The
 * raw line is therefore the authority and `text.value` only corroborates
 * the variant token.
 *
 * The subtree is left COMPLETELY untouched: the marker `text`, the line
 * delimiter (which `remarkBreaks` later turns into a `break`) and the
 * paragraph all survive into the stored AST. That is what lets every
 * consumer that does not know `crowiAlert` — the `X-Crowi-Ast-Version: 1`
 * projection (`sanitize-ast.ts`), a web bundle deployed before this
 * feature (via the fixed `data.hName: 'blockquote'` hint
 * `mdast-util-to-hast` honours) — keep showing exactly today's literal
 * block quote. Only the new web handler skips the marker at RENDER time.
 *
 * Keeping the children identical also preserves the raw-source
 * invariants the later core transforms rely on: `raw-space-links.ts`
 * re-slices the run's `body` by each text node's `position` and
 * correlates matches by ordinal, so a rewritten/split marker text node
 * would desync it.
 *
 * Known accepted limitation: because this runs in the core phase, a
 * plugin that registers `addNodeRenderer('blockquote', …)` or walks
 * `blockquote` in its own unified transform no longer sees an alerted
 * quote (dispatch matches the FINAL `node.type`). No bundled plugin
 * targets `blockquote` today. If one ever does, the fix is to record the
 * raw-line decision here and retype after `runNodeRenderers` instead of
 * introducing that two-phase complexity now.
 */

export const GITHUB_ALERT_VARIANTS = ['note', 'tip', 'important', 'warning', 'caution'] as const;
export type CrowiAlertVariant = (typeof GITHUB_ALERT_VARIANTS)[number];

/**
 * The marker line as it appears in the RAW source, block-quote
 * decoration included. Whitespace after `>` and after the marker is
 * GitHub-compatible canonical form; the trailing `(?:\r\n|\n|\r)` is
 * what rejects `> [!NOTE] body` (same-line content) and a marker line
 * that merely ends the document.
 *
 * Anchored rather than sticky: a sticky matcher would have to carry
 * `lastIndex` across candidates, i.e. module-global mutable state in a
 * transform whose whole contract is to be request-local and pure.
 */
export const GITHUB_ALERT_MARKER_LINE_RE = new RegExp(`^>[ \\t]*\\[!(${GITHUB_ALERT_VARIANTS.join('|')})\\][ \\t]*(?:\\r\\n|\\n|\\r)`, 'i');

/**
 * The single physical source line starting at `offset`, its terminator
 * included — so the anchored matcher above sees the whole line and
 * nothing beyond it, without copying the (potentially megabyte-sized)
 * rest of the body. A `\r` alone is enough of a terminator to accept:
 * whether the line ended with `\r` or `\r\n` cannot change the verdict.
 */
function firstRawLine(body: string, offset: number): string {
  const lf = body.indexOf('\n', offset);
  const cr = body.indexOf('\r', offset);
  const end = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
  return end < 0 ? body.slice(offset) : body.slice(offset, end + 1);
}

/** The same marker as the PARSER left it — the leading run of the first text node, corroborating the raw-line variant. */
const MARKER_VALUE_RE: Record<CrowiAlertVariant, RegExp> = Object.fromEntries(
  GITHUB_ALERT_VARIANTS.map((variant) => [variant, new RegExp(`^\\[!${variant}\\](?:$|\\r\\n|\\n|\\r)`, 'i')]),
) as Record<CrowiAlertVariant, RegExp>;

/**
 * An `html` node that carries nothing a browser ever paints: comments
 * and doctypes only. `mdast-util-to-hast` emits these as `raw` nodes,
 * which `hast-util-to-jsx-runtime` drops — so they must not count as
 * alert body content even though the intermediate hast still has them.
 */
const COMMENT_OR_DOCTYPE_ONLY_RE = /^\s*(?:<!--[\s\S]*?-->|<!doctype[^>]*>)+\s*$/i;

/**
 * The Crowi-owned flow container. `data.hName` is fixed so any consumer
 * without a `crowiAlert` handler converts it as a standard blockquote
 * rather than falling into `mdast-util-to-hast`'s unknown-node path.
 * `position` only ever exists inside the pipeline — `serializeMdast`
 * strips it before persistence / response.
 */
interface CrowiAlertNode {
  type: 'crowiAlert';
  variant: CrowiAlertVariant;
  children: Blockquote['children'];
  data?: Blockquote['data'];
  position?: Position;
}

function isText(node: PhrasingContent | undefined): node is Text {
  return node?.type === 'text';
}

/** Phrasing content that survives to the rendered DOM (an all-whitespace text run or a comment-only `html` does not). */
function isRenderablePhrasing(node: PhrasingContent): boolean {
  if (node.type === 'text') return node.value.trim() !== '';
  if (node.type === 'html') return !COMMENT_OR_DOCTYPE_ONLY_RE.test(node.value);
  return true;
}

/**
 * Flow content that survives to the rendered DOM. `definition` and
 * `footnoteDefinition` are `ignore` handlers in `mdast-util-to-hast`'s
 * own handler contract — they contribute markup elsewhere on the page
 * (or nowhere), never inside this quote.
 */
function isRenderableFlow(node: RootContent): boolean {
  if (node.type === 'definition' || node.type === 'footnoteDefinition') return false;
  if (node.type === 'html') return !COMMENT_OR_DOCTYPE_ONLY_RE.test(node.value);
  return true;
}

/**
 * The alert replacement for one root child, or `null` to keep the node
 * exactly as it is.
 *
 * The "renderable body" rule is decided inline and entirely on mdast: a
 * quote whose only content is the marker — or the marker plus nodes
 * nothing ever paints — stays an ordinary block quote, marker text
 * included. It reads the marker length matched just above rather than
 * re-deriving it, so the marker is matched exactly once per candidate.
 */
function tryCreateGithubAlert(node: RootContent, body: string): CrowiAlertNode | null {
  if (node.type !== 'blockquote') return null;
  const [markerParagraph, ...rest] = node.children;
  if (markerParagraph?.type !== 'paragraph') return null;
  const markerText = markerParagraph.children[0];
  if (!isText(markerText)) return null;
  // Cheap reject before touching the raw body at all: every marker the
  // matchers below can accept starts with these two characters, so an
  // ordinary block quote costs one `startsWith` rather than a line slice.
  if (!markerText.value.startsWith('[!')) return null;

  const offset = node.position?.start.offset;
  if (offset === undefined) return null;
  const rawMatch = GITHUB_ALERT_MARKER_LINE_RE.exec(firstRawLine(body, offset));
  if (!rawMatch) return null;

  const variant = rawMatch[1].toLowerCase() as CrowiAlertVariant;
  const valueMatch = MARKER_VALUE_RE[variant].exec(markerText.value);
  if (!valueMatch) return null;

  const markerLength = valueMatch[0].length;
  // A marker that consumed its entire text node was written with a
  // trailing hard break, so the `break` right after it is the delimiter
  // itself rather than body content.
  const afterMarker = markerLength === markerText.value.length && markerParagraph.children[1]?.type === 'break' ? 2 : 1;
  const hasBody =
    markerText.value.slice(markerLength).trim() !== '' || markerParagraph.children.slice(afterMarker).some(isRenderablePhrasing) || rest.some(isRenderableFlow);
  if (!hasBody) return null;

  return {
    type: 'crowiAlert',
    variant,
    children: node.children,
    data: { ...node.data, hName: 'blockquote' },
    ...(node.position ? { position: node.position } : {}),
  };
}

/**
 * Factory bound to the run's raw `body` (the recognition authority
 * above). Slots into `buildCorePlugins` right after
 * `makeFrontmatterPlugin` and BEFORE everything else: the raw-line check
 * is only sound while every `position` still describes the pristine
 * source, which no external plugin transform can be assumed to maintain,
 * and the marker delimiter must still be a line ending rather than the
 * `break` node `remarkBreaks` makes of it later.
 *
 * Only DIRECT `Root.children` are considered: a marker inside a list
 * item, an ordinary quote or another alert stays literal text.
 */
export const makeGithubAlertsPlugin =
  (body: string): UnifiedTransformPlugin =>
  (_metadata) =>
  (tree: Root) => {
    tree.children = tree.children.map((child) => (tryCreateGithubAlert(child, body) as RootContent | null) ?? child);
  };
