import { unwrapRenderedAst } from '@crowi/api-contract';

/** Local mdast node `render-mdast.ts` turns into the fixed card `span` structure. */
export interface CrowiLinkCardPreviewNode {
  type: 'crowiLinkCardPreview';
  url: string;
  message: string;
  sourceLine?: number;
}

interface MdastText {
  type: 'text';
  value: string;
}

interface MdastLink {
  type: 'link';
  url: string;
  children?: unknown[];
}

interface MdastParagraph {
  type: 'paragraph';
  children?: unknown[];
  data?: { hProperties?: Record<string, unknown> };
}

interface MdastRoot {
  type: 'root';
  children: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMdastRoot(value: unknown): value is MdastRoot {
  return isRecord(value) && value.type === 'root' && Array.isArray(value.children);
}

function isMdastParagraph(value: unknown): value is MdastParagraph {
  return isRecord(value) && value.type === 'paragraph' && Array.isArray(value.children);
}

/**
 * True for a text node ending in a bare `@` — CommonMark splits
 * `@[card](url)` into a (text, link, text) sibling triple (the `@` has
 * no relation to the link syntax that follows it), same split the
 * server-side matcher documents in `embed-tags.ts`'s doc comment.
 */
function isAtSuffixedText(node: unknown): node is MdastText {
  return isRecord(node) && node.type === 'text' && typeof node.value === 'string' && node.value.endsWith('@');
}

/** True for the `[card](url)` link half of the triple. */
function isCardTagLink(node: unknown): node is MdastLink {
  if (!isRecord(node) || node.type !== 'link' || typeof node.url !== 'string' || !Array.isArray(node.children) || node.children.length !== 1) return false;
  const [label] = node.children;
  return isRecord(label) && label.type === 'text' && label.value === 'card';
}

/** The preview stamps `data-source-line` on top-level nodes; only a positive integer is carried over. */
function sourceLineOf(node: MdastParagraph): number | undefined {
  const line = node.data?.hProperties?.['data-source-line'];
  const value = typeof line === 'number' ? line : typeof line === 'string' && /^\d+$/.test(line) ? Number(line) : undefined;
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
}

function createPreviewNode(url: string, message: string, sourceLine: number | undefined): CrowiLinkCardPreviewNode {
  return sourceLine === undefined ? { type: 'crowiLinkCardPreview', url, message } : { type: 'crowiLinkCardPreview', url, message, sourceLine };
}

/**
 * Replaces every `@[card](url)` triple among `children` with a static
 * placeholder, preserving any surrounding text on either side
 * (`applyLinkCardConversion` in `link-card-affordance-extension.ts` only
 * replaces the bare-URL span it found, so a mid-sentence conversion —
 * "See @[card](url) below" — leaves the card tag as one triple among
 * several paragraph children, not the paragraph's sole content).
 * Recurses into any child that itself carries a `children` array
 * (emphasis/strong/delete wrapping the triple) — `@[tag](url)` is general
 * Markdown syntax a user can hand-type anywhere, not only via the
 * affordance's own conversion action.
 */
function replaceCardTagsInChildren(children: unknown[], message: string, sourceLine: number | undefined): { changed: boolean; children: unknown[] } {
  let changed = false;
  const out: unknown[] = [];
  let i = 0;
  while (i < children.length) {
    const node = children[i];
    const next = children[i + 1];
    if (isAtSuffixedText(node) && isCardTagLink(next)) {
      changed = true;
      const prefix = node.value.slice(0, -1);
      if (prefix.length > 0) out.push({ ...node, value: prefix });
      out.push(createPreviewNode(next.url, message, sourceLine));
      i += 2;
      continue;
    }
    if (isRecord(node) && Array.isArray(node.children)) {
      const nested = replaceCardTagsInChildren(node.children, message, sourceLine);
      if (nested.changed) {
        changed = true;
        out.push({ ...node, children: nested.children });
        i += 1;
        continue;
      }
    }
    out.push(node);
    i += 1;
  }
  return { changed, children: out };
}

/**
 * Converts every `@[card](url)` triple in the editor preview's
 * top-level paragraphs to a static card. Preview mode deliberately
 * does not invoke embed renderers, so this never fetches OGP metadata
 * or writes a render cache entry.
 */
export function replaceLinkCardPreviewPlaceholders(renderedAstValue: unknown, message: string): unknown {
  // RFC-0023 §14 — route the read through the defensive
  // `unwrapRenderedAst` normaliser (no-op for the bare Root the web
  // receives in normal operation).
  const renderedAst = unwrapRenderedAst(renderedAstValue);
  if (!isMdastRoot(renderedAst)) return renderedAst;

  let changed = false;
  const children = renderedAst.children.map((node) => {
    if (!isMdastParagraph(node)) return node;
    const { changed: paragraphChanged, children: newChildren } = replaceCardTagsInChildren(node.children ?? [], message, sourceLineOf(node));
    if (!paragraphChanged) return node;
    changed = true;
    // A paragraph whose entire content was one triple degenerates to a
    // single preview-node child — return that child directly (unwrapped) rather
    // than a `<p>` wrapping the CSS-block-styled placeholder, matching the
    // saved card's own top-level (non-`<p>`-wrapped) placement.
    return newChildren.length === 1 ? newChildren[0] : { ...node, children: newChildren };
  });

  return changed ? { ...renderedAst, children } : renderedAst;
}
