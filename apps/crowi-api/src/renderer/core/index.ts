import type { PipelineEsmDeps, PipelineMetadata } from '../pipeline';
import { remarkCodeBlockLanguages } from './code-blocks';
import { makeRemarkHeadings, type UnifiedTransformPlugin } from './headings';
import { remarkMentions } from './mentions';
import { remarkWikiLinks } from './wikilinks';

export type { UnifiedTransformPlugin } from './headings';

/**
 * Build the bundled core renderer transform plugins, in their fixed
 * order (headings → wikilinks → mentions → code-blocks). The pipeline
 * prepends these to the registry's external plugins on every run.
 *
 * Bound to the loaded ESM deps because `headings` needs
 * `GithubSlugger` + `mdast-util-to-string`'s `toString` and neither
 * can be statically imported from CJS.
 */
export function buildCorePlugins(deps: PipelineEsmDeps): UnifiedTransformPlugin[] {
  return [makeRemarkHeadings(deps), remarkWikiLinks, remarkMentions, remarkCodeBlockLanguages];
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
