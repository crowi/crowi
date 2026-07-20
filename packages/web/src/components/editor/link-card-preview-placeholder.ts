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

function isCardTagParagraph(node: unknown): node is MdastParagraph {
  if (!isRecord(node) || node.type !== 'paragraph' || !Array.isArray(node.children) || node.children.length !== 2) return false;
  const [at, link] = node.children;
  if (!isRecord(at) || at.type !== 'text' || at.value !== '@') return false;
  if (!isRecord(link) || link.type !== 'link' || typeof link.url !== 'string' || !Array.isArray(link.children) || link.children.length !== 1) return false;
  const [label] = link.children;
  return isRecord(label) && label.type === 'text' && label.value === 'card';
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function sourceLineAttribute(node: MdastParagraph): string {
  const line = node.data?.hProperties?.['data-source-line'];
  if (typeof line !== 'number' && typeof line !== 'string') return '';
  const value = String(line);
  return /^\d+$/.test(value) ? ' data-source-line="' + value + '"' : '';
}

function renderPlaceholder(url: string, message: string, sourceLine: string): string {
  return [
    '<figure class="crowi-link-card crowi-link-card-preview"' + sourceLine + '>',
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
 * Converts a standalone `@[card](url)` paragraph in the editor preview to a
 * static card. Preview mode deliberately does not invoke embed renderers, so
 * this never fetches OGP metadata or writes a render cache entry.
 */
export function replaceLinkCardPreviewPlaceholders(renderedAst: unknown, message: string): unknown {
  if (!isMdastRoot(renderedAst)) return renderedAst;

  let changed = false;
  const children = renderedAst.children.map((node) => {
    if (!isCardTagParagraph(node)) return node;
    const link = node.children![1] as MdastLink;
    changed = true;
    return {
      type: 'html',
      value: renderPlaceholder(link.url, message, sourceLineAttribute(node)),
    };
  });

  return changed ? { ...renderedAst, children } : renderedAst;
}
