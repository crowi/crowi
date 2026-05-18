import type { Link, PhrasingContent, Root, Text } from 'mdast';
import { type PhrasingParent, walkPhrasingTree } from './_mdast-walk';

/**
 * Phase 2 plugin-dispatch transform — async post-processor that, after
 * `runSync`, demotes `@username` mention link nodes whose username does
 * NOT belong to a real user back to plain text.
 *
 * Why a post-`runSync` dispatch transform instead of teaching
 * `remarkMentions` itself: `remarkMentions` is a synchronous unified
 * plugin that only receives the metadata bag — it has no DB access by
 * design. Username existence is an I/O concern, so it lives in the same
 * async dispatch layer as the embed-tag / url-inline-expand transforms.
 *
 * The flow:
 *   1. `remarkMentions` (sync core transform) turns EVERY `@username`
 *      into a `link` node with `data.hProperties.className === 'mention'`
 *      and pushes the username into `metadata.mentions`.
 *   2. This transform collects those link nodes, batch-resolves the
 *      distinct usernames with a single `User.find({ username: { $in } })`
 *      query (no per-mention N+1), and replaces link nodes whose username
 *      is unknown with a `text` node `@username`.
 *
 * `metadata.mentions` is intentionally left untouched — it is the input
 * to the mention-notification dispatch (`registerMentionDispatch`), which
 * is out of scope for this phase. Only the rendered AST link nodes are
 * demoted.
 *
 * Only runs in `mode: 'save'`: the resolved AST is persisted as the
 * revision's `renderedAst`, so read / view paths reuse it without
 * re-resolving. The caller (`runPipeline`) gates on mode + resolver
 * presence.
 */

/** Batch existence resolver: maps a username list to the subset that exists. */
export type MentionUsernameResolver = (usernames: string[]) => Promise<Set<string>>;

interface MentionLinkMatch {
  /** Parent node owning the link node in its `children` array. */
  parent: { children: PhrasingContent[] };
  /** Index of the link node within `parent.children`. */
  index: number;
  /** The mentioned username (without the leading `@`). */
  username: string;
}

/**
 * Build the async post-processor. Returns a function that walks the
 * transformed mdast tree, finds mention link nodes, and rewrites the
 * unknown-user ones in-place into plain text nodes.
 */
export const makeMentionResolve =
  (resolver: MentionUsernameResolver) =>
  async (tree: Root): Promise<void> => {
    const matches = collectMentionLinks(tree);
    if (matches.length === 0) return;

    const distinctUsernames = [...new Set(matches.map((m) => m.username))];
    const existing = await resolver(distinctUsernames);

    // Demote unknown-user mention links to plain text in-place. Indices
    // stay valid because a link node is swapped for exactly one text
    // node (1:1 replacement, no splice).
    for (const match of matches) {
      if (existing.has(match.username)) continue;
      const textNode: Text = { type: 'text', value: `@${match.username}` };
      match.parent.children[match.index] = textNode;
    }
  };

/**
 * Collect every mention link node (a `link` with
 * `data.hProperties.className === 'mention'`) together with its parent +
 * index so the rewrite can swap it without re-walking the tree.
 */
function collectMentionLinks(tree: Root): MentionLinkMatch[] {
  const out: MentionLinkMatch[] = [];
  walkPhrasingTree(tree as PhrasingParent, (node) => {
    const children = node.children;
    if (!children) return;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (!isMentionLink(child)) continue;
      const username = mentionUsername(child);
      if (username === null) continue;
      out.push({ parent: { children }, index: i, username });
    }
  });
  return out;
}

function isMentionLink(node: PhrasingContent): node is Link {
  if (node.type !== 'link') return false;
  // `mdast`'s `LinkData` does not declare `hProperties`, but the
  // headings / wikilinks / mentions core transforms stamp it (it is the
  // `mdast-util-to-hast` channel for HTML props). Read it through a
  // narrowed view.
  const data = node.data as { hProperties?: { className?: unknown } } | undefined;
  return data?.hProperties?.className === 'mention';
}

/**
 * Recover the username from a mention link. `remarkMentions` builds the
 * link's single child as `text` with value `@username`; we strip the
 * leading `@`. Returns `null` for an unexpected shape (defensive — leaves
 * the node as a link).
 */
function mentionUsername(link: Link): string | null {
  const child = link.children[0];
  if (!child || child.type !== 'text') return null;
  const value = child.value;
  if (!value.startsWith('@')) return null;
  return value.slice(1);
}
