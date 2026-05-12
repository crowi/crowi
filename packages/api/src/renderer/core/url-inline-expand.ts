import type { Html, Link, PhrasingContent, Root } from 'mdast';
import type { EmbedInput, EmbedRenderer, InlineExpansion, RenderContext, UrlInlineExpansionRule } from '@crowi/plugin-api';
import { cachedRender, type MongoCacheStorage, scopeForPlugin } from '../cache';
import { createAuthContextStub, type RendererRegistryImpl } from '../registry';
import { type ParentChildren, groupByParent, walkPhrasingTree } from './_mdast-walk';

/**
 * Phase 4 plugin-dispatch transform — async post-processor that finds
 * bare URLs in paragraph-level content and, for each registered
 * `UrlInlineExpansionRule`, tries to expand them inline.
 *
 * Bare URL identification: GFM autolink (`https://example.com`) is
 * parsed by remark-gfm into a `link` node whose single text child has
 * the same URL as the `link.url`. That shape — a link whose href ===
 * its visible label — is what this transform targets. Inline-link
 * targets with a different label (`[label](url)`) are NOT expanded
 * (the author chose a label and we respect it).
 *
 * Expansion order: registered expanders are tried in registration
 * order; the first `'replaced'` wins. All `'unchanged'` means no
 * change.
 *
 * The expansion itself is routed through `cachedRender` so SWR + size
 * limits + error caching all apply uniformly. We wrap each
 * `UrlInlineExpansionRule` in an ephemeral `EmbedRenderer` shape so
 * the same code path handles both `@[tag](url)` and bare-URL embeds.
 */

const URL_EXPAND_PSEUDO_TAG = '__url-inline-expand__';

export interface UrlExpandDispatchDeps {
  cache: MongoCacheStorage;
  pageId: string;
}

export const makeUrlInlineExpandDispatch =
  (registry: RendererRegistryImpl, ctx: RenderContext, deps: UrlExpandDispatchDeps) =>
  async (tree: Root): Promise<void> => {
    const expanders = registry.getUrlInlineExpanders();
    if (expanders.length === 0) return;

    const candidates = collectAutolinks(tree);
    if (candidates.length === 0) return;

    await Promise.all(
      candidates.map(async (candidate) => {
        for (let idx = 0; idx < expanders.length; idx++) {
          const { plugin, rule } = expanders[idx];
          if (!matchesRule(rule, candidate.url)) continue;
          const adaptor = ruleAsRenderer(rule);
          const scopedCtx: RenderContext = {
            ...ctx,
            cache: scopeForPlugin(deps.cache, plugin),
            auth: createAuthContextStub(),
          };
          // Encode the expander index into the synthetic `tag` so two
          // expanders from the same plugin (same cacheVersion + same
          // pluginName) do NOT share a cache slot. Without this they
          // would collide on `(pluginName, pluginCacheVersion, pageId,
          // sha256({tag, url}))` and the second expander's call would
          // be served from the first's cached output.
          const input: EmbedInput = {
            tag: `${URL_EXPAND_PSEUDO_TAG}#${idx}`,
            url: candidate.url,
            pageId: deps.pageId,
          };
          // `cachedRender` resolves expand() through SWR + error
          // cache. The returned html is empty when expand() said
          // 'unchanged'; we fall through to the next expander in that
          // case.
          const rendered = await cachedRender(deps.cache, plugin, adaptor, input, scopedCtx);
          if (rendered.html && rendered.html.length > 0) {
            candidate.replacementHtml = rendered.html;
            return;
          }
        }
      }),
    );

    for (const parent of groupByParent(candidates, (c) => c.linkIndex)) {
      parent.parent.children = spliceLinks(parent.parent.children, parent.matches);
    }
  };

interface AutolinkCandidate {
  parent: ParentChildren;
  /** Index of the `link` node in parent.children. */
  linkIndex: number;
  url: string;
  /** Filled in after the async render. Empty string means no expander wanted it. */
  replacementHtml?: string;
}

function collectAutolinks(tree: Root): AutolinkCandidate[] {
  const out: AutolinkCandidate[] = [];
  walkPhrasingTree(tree as ParentChildren, (node, insideLink) => {
    if (insideLink) return;
    const children = node.children as PhrasingContent[];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.type !== 'link') continue;
      const link = child as Link;
      if (!isAutolinkShape(link)) continue;
      out.push({
        parent: node as ParentChildren,
        linkIndex: i,
        url: link.url,
      });
    }
  });
  return out;
}

/**
 * A "bare URL" link is one where the visible label equals the href.
 * GFM autolink produces exactly this shape (`https://example.com` →
 * `link(url='https://example.com', children=[text('https://example.com')])`).
 * Inline links with custom labels (`[label](url)`) have a different
 * shape and are intentionally not expanded.
 */
function isAutolinkShape(link: Link): boolean {
  if (!link.url) return false;
  const children = link.children ?? [];
  if (children.length !== 1) return false;
  const only = children[0];
  if (only.type !== 'text') return false;
  return only.value === link.url;
}

function matchesRule(rule: UrlInlineExpansionRule, url: string): boolean {
  if (typeof rule.match === 'function') return rule.match(url);
  return rule.match.test(url);
}

/**
 * Adapt a `UrlInlineExpansionRule` to the `EmbedRenderer` shape that
 * `cachedRender` expects. The `RenderResult.html` is empty when
 * `expand` returned `'unchanged'` — the caller falls through to the
 * next expander in that case.
 */
function ruleAsRenderer(rule: UrlInlineExpansionRule): EmbedRenderer {
  return {
    cacheVersion: rule.cacheVersion,
    async render(input, ctx) {
      const result: InlineExpansion = await rule.expand(input.url, ctx);
      if (result.kind === 'unchanged') {
        // Use a short fresh-TTL so a registered expander re-evaluates
        // soon (its match function might depend on dynamic config).
        return { html: '', ttlSec: 60 };
      }
      // `result` is RenderResult shape (minus `kind`).
      const { kind: _ignored, ...renderResult } = result;
      return renderResult;
    },
  };
}

function spliceLinks(children: PhrasingContent[], matches: AutolinkCandidate[]): PhrasingContent[] {
  // Replace each matched link node with an html node containing the
  // expanded html. Other children pass through untouched.
  const byIndex = new Map(matches.map((m) => [m.linkIndex, m]));
  const out: PhrasingContent[] = [];
  for (let i = 0; i < children.length; i++) {
    const match = byIndex.get(i);
    if (!match) {
      out.push(children[i]);
      continue;
    }
    const html: Html = { type: 'html', value: match.replacementHtml ?? '' };
    out.push(html as unknown as PhrasingContent);
  }
  return out;
}
