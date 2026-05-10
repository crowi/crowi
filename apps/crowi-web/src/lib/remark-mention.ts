/**
 * Web-side `@username` → mdast `link` transformer. Logically equivalent
 * to the api-side core renderer plugin but independently authored
 * (the api → web boundary intentionally has no shared module). Phase 3
 * will SSR the markdown server-side, dropping this client-side
 * duplicate.
 *
 * Match rules:
 *   - username is `[A-Za-z0-9_-]{1,64}`
 *   - the `@` must be at start-of-string OR after a non-word char
 *     so `me@example.com` does NOT mention `example`
 *   - text inside `code` / `inlineCode` is skipped
 *   - text inside an existing `link` is skipped (no double-linking)
 */

type MdastLikeNode = {
  type?: string;
  value?: string;
  url?: string;
  title?: string | null;
  children?: MdastLikeNode[];
  data?: { hProperties?: Record<string, unknown> };
};

const MENTION_RE = /(^|[^A-Za-z0-9_])@([A-Za-z0-9_-]{1,64})/g;

export const remarkMention = () => (tree: MdastLikeNode) => {
  walk(tree, /* insideLink */ false);

  function walk(node: MdastLikeNode, insideLink: boolean): void {
    if (node.type === 'code' || node.type === 'inlineCode') return;
    if (Array.isArray(node.children)) {
      const isLinkNow = insideLink || node.type === 'link';
      const replaced = isLinkNow ? node.children : transformChildren(node.children);
      node.children = replaced;
      for (const child of replaced) walk(child, isLinkNow);
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
  if (!value.includes('@')) return null;

  const out: MdastLikeNode[] = [];
  let lastIndex = 0;
  let matched = false;
  MENTION_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = MENTION_RE.exec(value)); ) {
    matched = true;
    const [whole, prefix, username] = m;
    const start = m.index;
    const beforeText = value.slice(lastIndex, start) + prefix;
    if (beforeText) out.push({ type: 'text', value: beforeText });
    out.push({
      type: 'link',
      url: `/user/${username}`,
      title: null,
      children: [{ type: 'text', value: `@${username}` }],
      data: { hProperties: { className: 'mention' } },
    });
    lastIndex = start + whole.length;
  }
  if (!matched) return null;
  if (lastIndex < value.length) {
    out.push({ type: 'text', value: value.slice(lastIndex) });
  }
  return out;
}
