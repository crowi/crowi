import { escapeHtml } from '@/lib/sanitise-snippet';

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

function sourceLineAttribute(node: MdastParagraph): string {
  const line = node.data?.hProperties?.['data-source-line'];
  if (typeof line !== 'number' && typeof line !== 'string') return '';
  const value = String(line);
  return /^\d+$/.test(value) ? ' data-source-line="' + value + '"' : '';
}

function renderPlaceholder(url: string, message: string, sourceLine: string): string {
  return [
    '<figure class="crowi-link-card"' + sourceLine + '>',
    '<div class="crowi-link-card-preview-surface">',
    '<div class="crowi-link-card-body">',
    '<div class="crowi-link-card-title">' + escapeHtml(url) + '</div>',
    '<div class="crowi-link-card-preview-message">' + escapeHtml(message) + '</div>',
    '</div>',
    '</div>',
    '</figure>',
  ].join('');
}

/**
 * Replaces every `@[card](url)` triple among a paragraph's DIRECT
 * children with a static placeholder, preserving any surrounding text
 * on either side (`applyLinkCardConversion` in
 * `link-card-affordance-extension.ts` only replaces the bare-URL span
 * it found, so a mid-sentence conversion — "See @[card](url) below" —
 * leaves the card tag as one triple among several paragraph children,
 * not the paragraph's sole content). Does NOT recurse into nested
 * phrasing content (emphasis/strong wrapping the triple) — the
 * realistic case this preview affordance needs to cover is the
 * top-level conversion `applyLinkCardConversion` itself produces,
 * which never nests the triple inside other inline markup.
 */
function replaceCardTagsInChildren(children: unknown[], message: string, sourceLine: string): { changed: boolean; children: unknown[] } {
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
      out.push({ type: 'html', value: renderPlaceholder(next.url, message, sourceLine) });
      i += 2;
      continue;
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
export function replaceLinkCardPreviewPlaceholders(renderedAst: unknown, message: string): unknown {
  if (!isMdastRoot(renderedAst)) return renderedAst;

  let changed = false;
  const children = renderedAst.children.map((node) => {
    if (!isMdastParagraph(node)) return node;
    const { changed: paragraphChanged, children: newChildren } = replaceCardTagsInChildren(node.children ?? [], message, sourceLineAttribute(node));
    if (!paragraphChanged) return node;
    changed = true;
    // A paragraph whose entire content was one triple degenerates to a
    // single `html` child — return that child directly (unwrapped) so
    // it renders as the block-level `<figure>` the placeholder markup
    // is, rather than nesting a block element inside a `<p>`.
    return newChildren.length === 1 ? newChildren[0] : { ...node, children: newChildren };
  });

  return changed ? { ...renderedAst, children } : renderedAst;
}
