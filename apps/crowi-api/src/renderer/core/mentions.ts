import type { Link, PhrasingContent, Root, Text } from 'mdast';
import type { MentionResponse } from '@crowi/api-contract';
import type { PipelineMetadata } from '../pipeline';
import type { UnifiedTransformPlugin } from './headings';

/**
 * Core renderer transform — detect `@username` inside text nodes,
 * replace each match with a link node (`/user/<username>`), and push
 * the username into `metadata.mentions`.
 *
 * The matcher is intentionally narrow:
 *   - username is `[A-Za-z0-9_-]{1,64}`
 *   - the `@` must be at start-of-string OR after a non-word char
 *     (so `me@example.com` does NOT mention `example`)
 *   - text inside `code` / `inlineCode` is skipped
 *   - text already inside a `link` is skipped (don't double-link)
 *
 * Phase 2 does NOT verify the user exists — that's left to Phase 3 if
 * we decide to add an existence check at all (open question in spec).
 */

// `(^|[^A-Za-z0-9_])@([A-Za-z0-9_-]{1,64})` with the prefix preserved
// so we can rebuild the leading text accurately.
const MENTION_RE = /(^|[^A-Za-z0-9_])@([A-Za-z0-9_-]{1,64})/g;

export const remarkMentions: UnifiedTransformPlugin = (metadata) => (tree) => {
  walk(tree, /* insideLink */ false);

  function walk(node: { type?: string; children?: unknown[] }, insideLink: boolean): void {
    if (node.type === 'code' || node.type === 'inlineCode') return;
    if (Array.isArray(node.children)) {
      const isLinkNow = insideLink || node.type === 'link';
      const replaced = isLinkNow ? (node.children as PhrasingContent[]) : transformChildren(node.children as PhrasingContent[], metadata);
      node.children = replaced;
      for (const child of replaced) walk(child as { type?: string; children?: unknown[] }, isLinkNow);
    }
  }
};

function transformChildren(children: PhrasingContent[], metadata: PipelineMetadata): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  for (const child of children) {
    if (child.type !== 'text') {
      out.push(child);
      continue;
    }
    out.push(...expandText(child as Text, metadata));
  }
  return out;
}

function expandText(textNode: Text, metadata: PipelineMetadata): PhrasingContent[] {
  const value = textNode.value;
  if (!value || !value.includes('@')) return [textNode];

  const out: PhrasingContent[] = [];
  let lastIndex = 0;
  MENTION_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = MENTION_RE.exec(value)); ) {
    const [matched, prefix, username] = m;
    const start = m.index;
    // The prefix character (if any) is part of the match; emit it
    // as plain text and start the link at `@`.
    const beforeText = value.slice(lastIndex, start) + prefix;
    if (beforeText) out.push({ type: 'text', value: beforeText });

    metadata.mentions.push({ username });
    out.push(toMentionLink(username));
    lastIndex = start + matched.length;
  }
  if (lastIndex === 0) return [textNode];
  if (lastIndex < value.length) {
    out.push({ type: 'text', value: value.slice(lastIndex) });
  }
  return out;
}

function toMentionLink(username: string): Link {
  return {
    type: 'link',
    url: `/user/${username}`,
    title: null,
    children: [{ type: 'text', value: `@${username}` }],
    data: { hProperties: { className: 'mention' } },
  };
}
