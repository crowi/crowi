import type { Root } from 'mdast';
import type { RenderContext } from '@crowi/plugin-api';
import type { MongoCacheStorage } from '../cache';
import type { PipelineEsmDeps, PipelineMetadata } from '../pipeline';
import type { RendererRegistryImpl } from '../registry';
import { remarkCodeBlockLanguages } from './code-blocks';
import { makeCodeBlockDispatch } from './code-block-dispatch';
import { makeEmbedTagDispatch } from './embed-tags';
import { makeRemarkHeadings, type UnifiedTransformPlugin } from './headings';
import { remarkMentions } from './mentions';
import { makeRemarkSyntaxHighlight } from './syntax-highlight';
import { makeUrlInlineExpandDispatch } from './url-inline-expand';
import { remarkWikiLinks } from './wikilinks';

export type { UnifiedTransformPlugin } from './headings';
export { makeCodeBlockDispatch } from './code-block-dispatch';
export { makeEmbedTagDispatch } from './embed-tags';
export { makeUrlInlineExpandDispatch } from './url-inline-expand';

/**
 * Build the bundled core renderer transform plugins, in their fixed
 * order (headings → wikilinks → mentions → code-blocks → syntax-
 * highlight). The pipeline prepends these to the registry's external
 * plugins on every run.
 *
 * Order rationale:
 *   - headings runs first so the slugger sees pristine heading text
 *     before any text rewrite (wikilinks / mentions inside headings
 *     would otherwise change the visible label).
 *   - wikilinks + mentions next, both walking text nodes and skipping
 *     inside code / inlineCode.
 *   - code-blocks (the lang aggregator) runs BEFORE syntax-highlight
 *     because the latter rewrites `code` nodes into `html`, after
 *     which the aggregator would no longer find them.
 *   - syntax-highlight runs last among core plugins so wikilinks /
 *     mentions / heading anchors are already stamped by the time the
 *     AST gets persisted.
 *
 * Bound to the loaded ESM deps because `headings` needs
 * `GithubSlugger` + `mdast-util-to-string`'s `toString` and
 * `syntax-highlight` needs `shiki`; neither can be statically
 * imported from CJS.
 */
export function buildCorePlugins(deps: PipelineEsmDeps): UnifiedTransformPlugin[] {
  return [makeRemarkHeadings(deps), remarkWikiLinks, remarkMentions, remarkCodeBlockLanguages, makeRemarkSyntaxHighlight(deps)];
}

/**
 * Test-only convenience: bind the core plugins to the deps and run
 * each one in order against a fresh `metadata` bag. Bypasses the
 * unified processor, which is useful for unit tests that don't want
 * to wait on dynamic imports of unified.
 *
 * Production code path is `runPipeline` in pipeline.ts.
 */
export function runCorePluginsDirectly(deps: PipelineEsmDeps, tree: unknown, metadata: PipelineMetadata): void {
  for (const plugin of buildCorePlugins(deps)) {
    const transformer = plugin(metadata);
    transformer(tree as Parameters<ReturnType<UnifiedTransformPlugin>>[0]);
  }
}

/**
 * Build the Phase 4 + 6 plugin-dispatch transforms — async post-
 * processors that run AFTER `runSync` because they need to call cache
 * I/O + plugin `render()` (both async).
 *
 * Order: embed-tags first, url-inline-expand second, code-block-
 * dispatch third. Each walks the tree once and rewrites matched
 * nodes in-place. Each no-ops when its respective registry is empty.
 *
 * Code-block-dispatch runs last on purpose: PlantUML / Mermaid output
 * SHOULD NOT contain `@[tag](url)` or bare-URL constructs that earlier
 * dispatchers would re-process, but putting code-block-dispatch last
 * makes that defensive ordering explicit — the new `html` node it
 * produces is opaque to the earlier walkers, which only operate on
 * phrasing content / autolinks.
 */
export function buildPluginDispatchPlugins(
  registry: RendererRegistryImpl,
  ctx: RenderContext,
  deps: { cache: MongoCacheStorage; pageId: string },
): Array<(tree: Root) => Promise<void>> {
  return [makeEmbedTagDispatch(registry, ctx, deps), makeUrlInlineExpandDispatch(registry, ctx, deps), makeCodeBlockDispatch(registry, ctx, deps)];
}
