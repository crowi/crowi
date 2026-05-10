/**
 * Web-side `[[…]]` → mdast `link` transformer. Logically equivalent to
 * the api-side core renderer plugin but independently authored so the
 * api → web boundary stays clean (no shared module). Phase 3 will SSR
 * the markdown server-side and this client-side duplicate is dropped.
 *
 * Supported shapes:
 *   - `[[Page]]`              → link to `Page`, display `Page`
 *   - `[[/path/to/page]]`     → link to `/path/to/page`, display same
 *   - `[[Page|Display]]`      → link to `Page`, display `Display`
 *   - `[[Page#section]]`      → link to `Page#section`, display same
 *
 * Targets that don't start with `/` get class `wikilink-broken` and
 * `href="#"` so they render as dimmed text without leaving the page.
 */

// Inline mdast subset — keeps the plugin dep-free (matches the shape
// of `buildRemarkHeadingIds` in page-content.tsx).
type MdastLikeNode = {
  type?: string;
  value?: string;
  url?: string;
  title?: string | null;
  children?: MdastLikeNode[];
  data?: { hProperties?: Record<string, unknown> };
};

const WIKILINK_RE = /\[\[([^[\]\n]{1,256})\]\]/g;

export const remarkWikiLink = () => (tree: MdastLikeNode) => {
  walk(tree);

  function walk(node: MdastLikeNode): void {
    if (node.type === 'code' || node.type === 'inlineCode') return;
    if (Array.isArray(node.children)) {
      const replaced = transformChildren(node.children);
      node.children = replaced;
      for (const child of replaced) walk(child);
    }
  }
};

function transformChildren(children: MdastLikeNode[]): MdastLikeNode[] {
  const out: MdastLikeNode[] = [];
  for (const child of children) {
    if (child.type !== 'text' || typeof child.value !== 'string') {
      out.push(child);
      continue;
    }
    const expanded = expandText(child.value);
    if (expanded === null) out.push(child);
    else out.push(...expanded);
  }
  return out;
}

function expandText(value: string): MdastLikeNode[] | null {
  if (!value.includes('[[')) return null;

  const out: MdastLikeNode[] = [];
  let lastIndex = 0;
  let matched = false;
  WIKILINK_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = WIKILINK_RE.exec(value)); ) {
    matched = true;
    const [whole, raw] = m;
    const start = m.index;
    if (start > lastIndex) {
      out.push({ type: 'text', value: value.slice(lastIndex, start) });
    }
    out.push(toLinkNode(raw));
    lastIndex = start + whole.length;
  }
  if (!matched) return null;
  if (lastIndex < value.length) {
    out.push({ type: 'text', value: value.slice(lastIndex) });
  }
  return out;
}

function toLinkNode(raw: string): MdastLikeNode {
  const trimmed = raw.trim();
  const pipeAt = trimmed.indexOf('|');
  let target: string;
  let display: string;
  if (pipeAt >= 0) {
    target = trimmed.slice(0, pipeAt).trim();
    display = trimmed.slice(pipeAt + 1).trim();
  } else {
    target = trimmed;
    display = trimmed;
  }
  const valid = target.startsWith('/');
  return {
    type: 'link',
    url: valid ? target : '#',
    title: null,
    children: [{ type: 'text', value: display }],
    data: valid ? undefined : { hProperties: { className: 'wikilink-broken' } },
  };
}
