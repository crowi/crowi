import type { PhrasingContent } from 'mdast';

/**
 * Shared walker types + helpers for the Phase 4 dispatch transforms
 * (`embed-tags.ts` and `url-inline-expand.ts`). Both visit phrasing
 * trees, skip into `code` / `inlineCode`, and group candidate matches
 * by their parent so the rewrite can splice multiple replacements into
 * the same children array in one pass.
 */

export interface PhrasingParent {
  type?: string;
  children?: PhrasingContent[];
}

export interface ParentChildren {
  children: PhrasingContent[];
}

/**
 * Pre-order walk that mirrors the phrasing-parent shape. Skips into
 * `code` / `inlineCode` (they have no phrasing children to collect
 * from), and tracks whether we are currently inside a `link` so callers
 * can avoid double-linking.
 */
export function walkPhrasingTree(root: PhrasingParent, visit: (node: PhrasingParent, insideLink: boolean) => void): void {
  go(root, false);

  function go(node: PhrasingParent, insideLink: boolean): void {
    if (node.type === 'code' || node.type === 'inlineCode') return;
    if (!Array.isArray(node.children)) return;
    visit(node, insideLink);
    const childInsideLink = insideLink || node.type === 'link';
    for (const child of node.children) {
      go(child as PhrasingParent, childInsideLink);
    }
  }
}

/**
 * Group rewrite candidates by reference-identical parent, drop entries
 * that the dispatch step did not fill in (neither `replacementHtml` nor
 * the RFC-0023 effective-result `replacement` present), and sort
 * matches by their child index so the splice step can walk the parent's
 * children left-to-right without re-indexing.
 */
export function groupByParent<C extends { parent: ParentChildren; replacementHtml?: string; replacement?: { html: string } }>(
  candidates: C[],
  indexOf: (c: C) => number,
): Array<{ parent: ParentChildren; matches: C[] }> {
  const groups = new Map<ParentChildren, C[]>();
  for (const c of candidates) {
    if (!c.replacementHtml && !c.replacement) continue;
    const list = groups.get(c.parent) ?? [];
    list.push(c);
    groups.set(c.parent, list);
  }
  return Array.from(groups.entries()).map(([parent, matches]) => ({
    parent,
    matches: matches.slice().sort((a, b) => indexOf(a) - indexOf(b)),
  }));
}
