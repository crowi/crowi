import type { Html, Link, PhrasingContent, Root, Text } from 'mdast';
import type { EmbedInput, RenderContext } from '@crowi/plugin-api';
import { cachedRender, type MongoCacheStorage, normalizeRenderResult, scopeForPlugin } from '../cache';
import { createAuthContextStub, type RendererRegistryImpl } from '../registry';
import { type ParentChildren, groupByParent, walkPhrasingTree } from './_mdast-walk';

/**
 * Phase 4 plugin-dispatch transform — async post-processor that
 * detects `@[tag](url)` and, when `tag` matches a registered embed
 * renderer, replaces the construct with an `html` node containing the
 * renderer's `RenderResult.html` (after SWR + cache resolution).
 *
 * Important parse subtlety: CommonMark / GFM does NOT see
 * `@[tag](url)` as one token. The parser splits it into THREE mdast
 * nodes:
 *
 *   text node "@"  +  link(url='url', children=[text 'tag'])  +  text node "<rest>"
 *
 * — because `[label](url)` is just an inline link, and the leading
 * `@` is unrelated trailing text. So we walk **sibling triples** of
 * (text, link, text) instead of regex-scanning text values. When we
 * see:
 *
 *   1. text node whose value ends with `@`,
 *   2. immediately followed by a link node with children matching
 *      `[text:'tag']` where tag is `[A-Za-z0-9_-]{1,64}`, and
 *   3. the link's url is non-empty (anything is accepted; plugin
 *      validates per-renderer),
 *
 * AND there is a registered embed renderer for that tag, we splice in
 * the rendered html and trim the trailing `@` off the previous text
 * node. Unregistered tags pass through as `@` + `[tag](url)` (a plain
 * inline link), matching the RFC plain-text fallback.
 *
 * Note: this triple-match deliberately matches *more* than just the
 * literal `@[tag](url)` substring — it also catches cases where the
 * link's url contains escape sequences (`@[t](a%20b)`) that would
 * have broken a regex on the raw text. The cost is that an author
 * who writes `[tag](url)` with a trailing `@` immediately before it
 * (`text ending in @ ` followed by `[t](u)`) will trigger a match
 * even if the visual intent wasn't an embed. Tests + real-world use
 * will tell us if this is too aggressive; the alternative would be
 * a `remark-parse` pre-pass to recognise the `@[...](…)` token, but
 * that requires shipping a forked extension.
 *
 * Skipped node types: `code`, `inlineCode` (verbatim) — the walker
 * does not descend into them.
 */
const TAG_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface EmbedTagDispatchDeps {
  cache: MongoCacheStorage;
  pageId: string;
}

/**
 * Build the async post-processor. Returns a function that walks the
 * transformed mdast tree, finds embed-tag triples, and rewrites them
 * in-place with rendered html nodes.
 */
export const makeEmbedTagDispatch =
  (registry: RendererRegistryImpl, ctx: RenderContext, deps: EmbedTagDispatchDeps) =>
  async (tree: Root): Promise<void> => {
    const candidates = collectCandidates(tree, registry);
    if (candidates.length === 0) return;

    await Promise.all(
      candidates.map(async (candidate) => {
        const registration = registry.getEmbedTag(candidate.tag);
        if (!registration) return; // defensive — collectCandidates filtered
        const scopedCtx: RenderContext = {
          ...ctx,
          cache: scopeForPlugin(deps.cache, registration.plugin),
          auth: createAuthContextStub(),
        };
        const input: EmbedInput = {
          tag: candidate.tag,
          url: candidate.url,
          pageId: deps.pageId,
        };
        if (registration.renderer.shouldBypassCache?.(input)) {
          // Skip `CacheStorage` entirely for this dispatch — no `get`,
          // no `set` — per `EmbedRenderer.shouldBypassCache`'s contract
          // (a renderer-declared runtime-policy toggle, e.g. link-card's
          // `security:linkCardEnabled`, needs a literal zero-cache-access
          // guarantee, not just zero I/O inside `render()`).
          const { html } = await normalizeRenderResult(() => registration.renderer.render(input, scopedCtx), registration.renderer.reservation);
          candidate.replacementHtml = html;
          return;
        }
        const rendered = await cachedRender(deps.cache, registration.plugin, registration.renderer, input, scopedCtx);
        candidate.replacementHtml = rendered.html;
      }),
    );

    // Apply rewrites per parent. Each parent may contain multiple
    // triples — we rebuild its children list in one pass.
    for (const group of groupByParent(candidates, (c) => c.linkIndex)) {
      group.parent.children = rewriteChildren(group.parent.children, group.matches);
    }
  };

interface Candidate {
  /** Parent node containing the (text, link, …) sequence. */
  parent: ParentChildren;
  /** Index of the leading text node (the one that ends in `@`). */
  textBeforeIndex: number;
  /** Index of the link node (text.length === textBeforeIndex + 1). */
  linkIndex: number;
  tag: string;
  url: string;
  /** Filled in after the async render resolves. */
  replacementHtml?: string;
}

function collectCandidates(tree: Root, registry: RendererRegistryImpl): Candidate[] {
  const out: Candidate[] = [];
  walkPhrasingTree(tree as ParentChildren, (node, insideLink) => {
    if (insideLink) return;
    const children = node.children as PhrasingContent[];
    // Sibling-triple scan for (text-ending-in-`@`, link, …)
    for (let i = 0; i < children.length - 1; i++) {
      const prev = children[i];
      const next = children[i + 1];
      if (prev.type !== 'text') continue;
      if (next.type !== 'link') continue;
      const text = prev as Text;
      if (!text.value.endsWith('@')) continue;
      const link = next as Link;
      const linkChildren = link.children ?? [];
      if (linkChildren.length !== 1) continue;
      const inner = linkChildren[0];
      if (inner.type !== 'text') continue;
      const tag = (inner as Text).value;
      if (!TAG_NAME_RE.test(tag)) continue;
      const url = link.url;
      if (!url) continue;
      if (!registry.getEmbedTag(tag)) continue;
      out.push({
        parent: node as ParentChildren,
        textBeforeIndex: i,
        linkIndex: i + 1,
        tag,
        url,
      });
    }
  });
  return out;
}

/**
 * Rebuild `children` by walking it left-to-right and rewriting each
 * matched (text-ending-in-`@`, link) pair into (text-with-`@`-stripped,
 * html-node). All other children pass through.
 */
function rewriteChildren(children: PhrasingContent[], matches: Candidate[]): PhrasingContent[] {
  const byLinkIndex = new Map(matches.map((m) => [m.linkIndex, m]));
  const out: PhrasingContent[] = [];

  let i = 0;
  while (i < children.length) {
    const next = i + 1 < children.length ? children[i + 1] : null;
    const matchOnNext = next ? byLinkIndex.get(i + 1) : undefined;
    if (matchOnNext && matchOnNext.textBeforeIndex === i) {
      const leadingText = children[i] as Text;
      const stripped = leadingText.value.slice(0, -1); // drop the trailing `@`
      if (stripped) {
        out.push({ type: 'text', value: stripped });
      }
      const html: Html = { type: 'html', value: matchOnNext.replacementHtml ?? '' };
      out.push(html as unknown as PhrasingContent);
      i += 2;
      continue;
    }
    out.push(children[i]);
    i++;
  }
  return out;
}
