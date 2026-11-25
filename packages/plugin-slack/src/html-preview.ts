import { createJiti } from 'jiti';

/** Max code points of description / visible text shown on the card. */
export const HTML_EXCERPT_MAX_CHARS = 300;

/**
 * Upper bound on raw HTML handed to parse5. Artifacts can be several MiB;
 * the title / description live in `<head>` and the excerpt only needs the
 * first few hundred visible characters.
 */
export const HTML_SOURCE_SCAN_CHARS = 200_000;

export interface HtmlPreview {
  title: string | null;
  description: string | null;
  text: string | null;
}

/** Minimal shape of parse5's default tree adapter nodes. */
interface HtmlNode {
  nodeName: string;
  tagName?: string;
  childNodes?: HtmlNode[];
  attrs?: { name: string; value: string }[];
  value?: string;
}

type ParseFn = (html: string) => HtmlNode;

let parseCache: ParseFn | null = null;

// parse5 is ESM-only; load it lazily via jiti so wikis that never see an
// HTML page do not pay for it.
export function loadParse5(): ParseFn {
  if (parseCache) return parseCache;
  const jiti = createJiti(__filename, { interopDefault: true });
  const mod = jiti('parse5') as { parse: ParseFn };
  parseCache = mod.parse;
  return parseCache;
}

const SKIP_TAGS = new Set(['style', 'script', 'noscript', 'template', 'svg', 'math']);

const BREAK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'td',
  'th',
  'tr',
  'ul',
]);

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string): string {
  const points = Array.from(text);
  if (points.length <= HTML_EXCERPT_MAX_CHARS) return text;
  return `${points.slice(0, HTML_EXCERPT_MAX_CHARS).join('').trimEnd()}…`;
}

function findElement(node: HtmlNode, tag: string): HtmlNode | null {
  if (node.tagName === tag) return node;
  for (const child of node.childNodes ?? []) {
    const found = findElement(child, tag);
    if (found) return found;
  }
  return null;
}

function textOf(node: HtmlNode): string {
  let out = '';
  for (const child of node.childNodes ?? []) {
    if (child.nodeName === '#text') out += child.value ?? '';
  }
  return out;
}

function findDescription(head: HtmlNode): string | null {
  const walk = (node: HtmlNode): string | null => {
    if (node.tagName === 'meta') {
      const attrs = node.attrs ?? [];
      const name = attrs.find((a) => a.name === 'name');
      if (name && name.value.trim().toLowerCase() === 'description') {
        const content = collapse(attrs.find((a) => a.name === 'content')?.value ?? '');
        return content || null;
      }
    }
    for (const child of node.childNodes ?? []) {
      const found = walk(child);
      if (found !== null) return found;
    }
    return null;
  };
  return walk(head);
}

function collectText(body: HtmlNode): string {
  const parts: string[] = [];
  const walk = (node: HtmlNode): void => {
    for (const child of node.childNodes ?? []) {
      if (child.nodeName === '#text') {
        parts.push(child.value ?? '');
        continue;
      }
      const tag = child.tagName;
      if (!tag) continue;
      if (SKIP_TAGS.has(tag)) continue;
      const isBreak = BREAK_TAGS.has(tag);
      if (isBreak) parts.push(' ');
      walk(child);
      if (isBreak) parts.push(' ');
    }
  };
  walk(body);
  return collapse(parts.join(''));
}

/**
 * Pull the title, meta description and visible-text head out of an HTML
 * document. Throws if parse5 cannot be loaded or fails; the caller decides
 * the fallback.
 */
export function extractHtmlPreview(html: string): HtmlPreview {
  const source = html.length > HTML_SOURCE_SCAN_CHARS ? html.slice(0, HTML_SOURCE_SCAN_CHARS) : html;
  const doc = loadParse5()(source);
  const root = findElement(doc, 'html') ?? doc;
  const head = findElement(root, 'head');
  const body = findElement(root, 'body');

  const titleEl = head ? findElement(head, 'title') : null;
  const title = titleEl ? collapse(textOf(titleEl)) : '';
  const description = head ? findDescription(head) : null;
  const text = body ? collectText(body) : '';

  return {
    title: title || null,
    description: description ? clip(description) : null,
    text: text ? clip(text) : null,
  };
}
