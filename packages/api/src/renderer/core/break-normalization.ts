import type { Break, Html, Root } from 'mdast';
import { type PhrasingParent, walkPhrasingTree } from './_mdast-walk';
import type { UnifiedTransformPlugin } from './headings';

/**
 * feature-renderer-break-normalization — normalises phrasing-content
 * `html("<br>")` nodes (what `remark-parse` leaves an attribute-less
 * `<br>` as) into canonical mdast `break` nodes, so non-web clients that
 * treat `html` as opaque content (RFC-0023 §4.1) stop showing a visible
 * placeholder for a line break whose meaning is fully known. `break` is
 * an existing v1 wire type (`packages/api-contract/src/schemas/
 * rendered-ast.ts`) — this transform produces no new node shape and
 * needs no contract change.
 *
 * D-1: this is the ONLY normalisation point (parse-after / persist-
 * before). v1 projection and clients never re-interpret `html` as a
 * break themselves — that would either duplicate the same meaning in
 * two stored shapes or push HTML interpretation onto every client,
 * eroding RFC-0023's "HTML is opaque" boundary.
 */

/**
 * D-2 — an attribute-less `<br>` in any spelling CommonMark accepts,
 * ASCII tag-name case-insensitive. CommonMark's open-tag grammar is
 * `<` tagname attributes* whitespace? `/`? `>`, so the whitespace run
 * before the optional slash is unbounded and may contain tabs and
 * newlines: `<br>` / `<br >` / `<br/>` / `<br />` / `<br\t/>` all mean
 * exactly the same line break and a reader cannot tell them apart.
 * Accepting only some of them would leave the rest as a placeholder on
 * non-web clients for no reason a user could name.
 *
 * The class is `[ \t\r\n]`, not `\s`. Measured against remark-parse, those
 * four are the only characters it will carry inside the tag: VT, FF, NBSP,
 * U+2000 and the BOM all make it emit plain text instead, and `\s` would
 * match them — letting a plugin-injected `<br\u00a0>` normalize to a break
 * that no Markdown source can produce.
 *
 * There is deliberately no whitespace class after the slash either: that
 * position is outside the grammar, so `remark-parse` emits `<br/ >` as plain
 * text rather than an `html` node (measured, not inferred). Matching either
 * would claim a shape the parser never hands us.
 *
 * Anchored (`^`/`$`) against the WHOLE `html` node value, so any other
 * text in the same node — leading/trailing content, an attribute, a
 * second tag — disqualifies it. Partial replacement is out of scope:
 * splitting one `html` node into several raises a new position/data-
 * attribution question this feature does not take on.
 */
export const BARE_HTML_BREAK_RE = /^<br[ \t\r\n]*\/?>$/i;

/**
 * D-3 — the block-level phrasing containers a contamination check is
 * scoped to. None of these ever nests inside another (a paragraph is
 * never inside a heading or a table cell, a table cell is never inside
 * a paragraph, …), so the outer walk below can never re-enter
 * `normalizeUnit` on a subtree it already covered.
 */
export const PHRASING_UNIT_TYPES: ReadonlySet<string> = new Set(['paragraph', 'heading', 'tableCell']);

/**
 * D-4 — the registry `childModel: 'phrasing'` parent types, minus
 * `crowiFigure`. A bare `<br>` is replaced only when its DIRECT parent's
 * type is one of these; flow position (`root` / `blockquote` / `listItem`
 * directly) and any unrecognised (e.g. plugin-injected) parent keep the
 * `html` node untouched.
 *
 * `crowiFigure` is excluded because it cannot contain one: `image-attrs`
 * builds it with a single image child, and its standalone predicate
 * requires every non-image sibling to be whitespace-only text, so a
 * paragraph holding an `html` node never becomes a figure. Listing it
 * would be dead scope. The test below derives the rest from the registry,
 * so a newly added phrasing type fails rather than silently losing
 * normalization.
 */
export const BREAK_PARENT_TYPES: ReadonlySet<string> = new Set(['paragraph', 'heading', 'emphasis', 'strong', 'delete', 'link', 'linkReference', 'tableCell']);

function isBareBreakHtml(node: Html): boolean {
  return typeof node.value === 'string' && BARE_HTML_BREAK_RE.test(node.value);
}

function toBreakNode(html: Html): Break {
  return html.position !== undefined ? { type: 'break', position: html.position } : { type: 'break' };
}

/**
 * Pass 1 (D-3) — true iff some `html` node anywhere in `unit`'s phrasing
 * subtree is NOT a bare `<br>`. A single such node (an attribute, another
 * tag, mixed text, a value holding more than one tag…) contaminates the
 * WHOLE unit, so pass 2 must not touch anything in it — this is what
 * keeps a space-preserving wrapper like
 * `<span style="white-space:pre">x<br>y</span>` untouched even though
 * its own `<br>` is otherwise bare.
 *
 * Walks the entire subtree unconditionally rather than short-circuiting
 * on the first contamination — `walkPhrasingTree` has no early-exit —
 * which keeps this a single, simple pass at the cost of not stopping
 * early on the (rare) contaminated case; the transform's O(N) bound
 * counts this as one of the "at most 2 passes per unit".
 */
function hasNonBareHtml(unit: PhrasingParent): boolean {
  let found = false;
  walkPhrasingTree(unit, (node) => {
    for (const child of node.children ?? []) {
      if (child.type === 'html' && !isBareBreakHtml(child)) found = true;
    }
  });
  return found;
}

/**
 * Pass 2 (D-4) — replace every `html` child of an allow-listed parent
 * with a `break` node, in place. Does not re-check `value` — pass 1
 * already proved every `html` node in this unit's subtree is a bare
 * `<br>`, so any `html` found here qualifies by construction.
 */
function replaceBareBreaks(unit: PhrasingParent): void {
  walkPhrasingTree(unit, (node) => {
    if (node.type === undefined || !BREAK_PARENT_TYPES.has(node.type)) return;
    const children = node.children;
    if (!children) return;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.type === 'html') children[i] = toBreakNode(child);
    }
  });
}

function normalizeUnit(unit: PhrasingParent): void {
  if (hasNonBareHtml(unit)) return;
  replaceBareBreaks(unit);
}

/**
 * D-5 — registered LAST in `buildCorePlugins`, right before
 * `remarkBreaks`. `core/index.ts` owns the plugin order and states why
 * each neighbour sits where it does; don't restate it here.
 *
 * Reuses the shared `walkPhrasingTree` (feature-renderer-plugin-
 * boundary's `embed-tags.ts` / `url-inline-expand.ts` walker, already
 * imported for an unrelated purpose by `mention-resolve.ts`) for all
 * three passes — the outer unit search and both of `normalizeUnit`'s
 * passes — rather than a bespoke walker (AC-12). `insideLink` is
 * ignored; skipping into `code` / `inlineCode` is harmless since
 * neither can ever hold an `html` child.
 *
 * The outer walk keeps descending into a unit's own children after
 * `normalizeUnit` has processed it (`walkPhrasingTree` has no way to
 * stop descent from inside `visit`) — harmless because units never
 * nest, so nothing inside one is ever itself `paragraph` / `heading` /
 * `tableCell` again.
 */
export const remarkNormalizeHtmlBreaks: UnifiedTransformPlugin = (_metadata) => (tree: Root) => {
  walkPhrasingTree(tree as PhrasingParent, (node) => {
    if (node.type !== undefined && PHRASING_UNIT_TYPES.has(node.type)) normalizeUnit(node);
  });
};
