import { createHash } from 'node:crypto';
import type { Code, Html, Root, RootContent } from 'mdast';
import type { CodeBlockInfo, CodeBlockRenderer, EmbedFragment, EmbedInput, EmbedRenderer, RenderContext, RenderResult } from '@crowi/plugin-api';
import { cachedRender, type MongoCacheStorage, scopeForPlugin } from '../cache';
import { createAuthContextStub, type RendererRegistryImpl } from '../registry';

/**
 * Phase 6 plugin-dispatch transform — async post-processor that walks
 * the mdast tree for `code` nodes whose `lang` matches a registered
 * `CodeBlockRenderer` and replaces them with `html` nodes carrying the
 * rendered output. Routes through the same `cachedRender` SWR wrapper
 * as embed-tags so PlantUML (the first user) gets cache + error caching
 * + size-limit fallback for free.
 *
 * Ordering note: this runs AFTER the unified `runSync` phase, which
 * already executed the bundled `syntax-highlight` plugin. Shiki only
 * rewrites code nodes whose `lang` is in its bundled set; the Phase 6
 * users (`plantuml`, future `mermaid`, `katex` math is NOT a code
 * block — it's `math` / `inlineMath` nodes) are not in the shiki
 * bundled list, so the `code` node survives untouched into this
 * dispatch step. No ordering surgery is needed inside the unified
 * pipeline itself.
 *
 * The walker is block-level (recurses into root / blockquote / listItem
 * / etc.) because fenced code blocks are block-level constructs. Inline
 * code (`inlineCode`) is intentionally NOT visited — those are
 * phrasing-level and never carry a `lang` tag.
 */

export interface CodeBlockDispatchDeps {
  cache: MongoCacheStorage;
  pageId: string;
}

export const makeCodeBlockDispatch =
  (registry: RendererRegistryImpl, ctx: RenderContext, deps: CodeBlockDispatchDeps) =>
  async (tree: Root): Promise<void> => {
    if (!registry.hasCodeBlockRenderers()) return;
    const candidates = collectCandidates(tree, registry);
    if (candidates.length === 0) return;

    await Promise.all(
      candidates.map(async (candidate) => {
        const registration = registry.getCodeBlockRenderer(candidate.lang);
        if (!registration) return; // defensive — collectCandidates already filtered
        const scopedCtx: RenderContext = {
          ...ctx,
          cache: scopeForPlugin(deps.cache, registration.plugin),
          auth: createAuthContextStub(),
        };
        const adaptor = codeBlockAsEmbedRenderer(registration.renderer);
        // We re-pack the code-block info into the EmbedInput shape so
        // the shared `cachedRender` path can route it. The adaptor
        // unpacks lang from `tag` and source from `url` on the render
        // side — internal abstraction leak, but contained here.
        const input: EmbedInput = {
          tag: candidate.lang,
          url: candidate.source,
          pageId: deps.pageId,
        };
        const rendered = await cachedRender(deps.cache, registration.plugin, adaptor, input, scopedCtx);
        candidate.replacementHtml = rendered.html;
      }),
    );

    // Rewrite each parent's children in-place. Multiple matches in
    // the same parent are spliced together so indices stay stable.
    for (const group of groupByParent(candidates)) {
      group.parent.children = rewriteChildren(group.parent.children, group.matches);
    }
  };

interface MutableParent {
  type?: string;
  children?: RootContent[];
}

interface Candidate {
  /** Parent node containing the `code` candidate. */
  parent: MutableParent & { children: RootContent[] };
  /** Index of the `code` node in parent.children. */
  codeIndex: number;
  lang: string;
  source: string;
  /** Filled in after the async render. */
  replacementHtml?: string;
}

/**
 * Block-level walker that finds `code` nodes whose `lang` has a
 * registered renderer. Recurses into any block container with a
 * `children` array — root, blockquote, list, listItem, etc. — but
 * skips phrasing-only nodes (no point descending into them; fenced
 * code is never inside a paragraph / link / etc.).
 */
function collectCandidates(tree: Root, registry: RendererRegistryImpl): Candidate[] {
  const out: Candidate[] = [];
  walkBlocks(tree as MutableParent, (parent) => {
    const children = parent.children;
    if (!children) return;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.type !== 'code') continue;
      const code = child as Code;
      const lang = (code.lang ?? '').trim();
      if (!lang) continue;
      const registration = registry.getCodeBlockRenderer(lang);
      if (!registration) continue;
      out.push({
        parent: parent as Candidate['parent'],
        codeIndex: i,
        lang,
        source: code.value ?? '',
      });
    }
  });
  return out;
}

function walkBlocks(node: MutableParent, visit: (parent: MutableParent & { children: RootContent[] }) => void): void {
  if (!Array.isArray(node.children)) return;
  visit(node as MutableParent & { children: RootContent[] });
  for (const child of node.children) {
    // `code` and `inlineCode` are leaves — no descent. `html` is also
    // a leaf. Everything else may carry block children we want to
    // visit (blockquote, listItem, list, root).
    if (child.type === 'code' || child.type === 'inlineCode' || child.type === 'html') continue;
    walkBlocks(child as unknown as MutableParent, visit);
  }
}

/**
 * Adapt a `CodeBlockRenderer` to the `EmbedRenderer` shape that
 * `cachedRender` expects. Mirrors `url-inline-expand.ts:ruleAsRenderer`.
 * The cacheVersion / reservation / computeEmbedKey flow through; the
 * key compute pulls lang + source out of the synthetic EmbedInput.
 */
function codeBlockAsEmbedRenderer(cb: CodeBlockRenderer): EmbedRenderer {
  return {
    cacheVersion: cb.cacheVersion,
    reservation: cb.reservation,
    computeEmbedKey: (input: EmbedInput) => {
      // Default: hash the code-block info. Plugin override consults
      // CodeBlockInfo shape, not EmbedInput, so we unpack first.
      const info: CodeBlockInfo = { lang: input.tag, source: input.url };
      if (cb.computeEmbedKey) return cb.computeEmbedKey(info);
      return defaultCodeBlockEmbedKey(info);
    },
    async render(input, ctx) {
      const info: CodeBlockInfo = { lang: input.tag, source: input.url };
      const result = await cb.render(info, ctx);
      // The plugin may return either a bare `EmbedFragment` (html +
      // assets) or a full `RenderResult` (with ttlSec / error). The
      // `error` field is the discriminator — pass `RenderResult`
      // through verbatim so error caching applies, otherwise wrap the
      // fragment as a successful RenderResult with the default code-
      // block TTL (1h).
      if (isRenderResult(result)) return result;
      const fragment = result as EmbedFragment;
      return { html: fragment.html, assets: fragment.assets, ttlSec: 60 * 60 };
    },
  };
}

function isRenderResult(value: EmbedFragment | RenderResult): value is RenderResult {
  // `'error' in value` would mis-classify a fragment with an explicit
  // `error: undefined` property; check actual presence instead.
  const candidate = value as Partial<RenderResult>;
  return candidate.error !== undefined || typeof candidate.ttlSec === 'number';
}

function defaultCodeBlockEmbedKey(info: CodeBlockInfo): string {
  const json = JSON.stringify({ lang: info.lang, source: info.source });
  return createHash('sha256').update(json).digest('hex');
}

/**
 * Group matched candidates by reference-identical parent and sort each
 * group by child index so the splice walks left-to-right. Drops
 * candidates the dispatch did not fill in (`replacementHtml` missing).
 */
function groupByParent(candidates: Candidate[]): Array<{ parent: Candidate['parent']; matches: Candidate[] }> {
  const groups = new Map<Candidate['parent'], Candidate[]>();
  for (const c of candidates) {
    if (!c.replacementHtml) continue;
    const list = groups.get(c.parent) ?? [];
    list.push(c);
    groups.set(c.parent, list);
  }
  return Array.from(groups.entries()).map(([parent, matches]) => ({
    parent,
    matches: matches.slice().sort((a, b) => a.codeIndex - b.codeIndex),
  }));
}

function rewriteChildren(children: RootContent[], matches: Candidate[]): RootContent[] {
  const byIndex = new Map(matches.map((m) => [m.codeIndex, m]));
  const out: RootContent[] = [];
  for (let i = 0; i < children.length; i++) {
    const match = byIndex.get(i);
    if (!match) {
      out.push(children[i]);
      continue;
    }
    const html: Html = { type: 'html', value: match.replacementHtml ?? '' };
    out.push(html);
  }
  return out;
}
