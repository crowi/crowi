import type { PipelineEsmDeps, PipelineMetadata } from '../pipeline';
import { remarkCodeBlockLanguages } from './code-blocks';
import { makeRemarkHeadings, type UnifiedTransformPlugin } from './headings';
import { remarkMentions } from './mentions';
import { makeRemarkSyntaxHighlight } from './syntax-highlight';
import { remarkWikiLinks } from './wikilinks';

export type { UnifiedTransformPlugin } from './headings';

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
