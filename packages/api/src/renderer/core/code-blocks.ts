import type { Code, Root } from 'mdast';
import type { PipelineMetadata } from '../pipeline';
import type { UnifiedTransformPlugin } from './headings';

/**
 * Core renderer transform — observe each fenced code block's `lang`
 * tag and aggregate the unique set into `metadata.codeBlockLanguages`.
 * Pure observer, doesn't mutate the AST.
 *
 * Used by the admin UI ("which languages does this wiki need
 * highlighter coverage for?") and by RFC-0002 Phase 3 plugins
 * (`@crowi/plugin-renderer-mermaid` etc.) to decide whether to
 * activate themselves on a given page.
 */
export const remarkCodeBlockLanguages: UnifiedTransformPlugin = (metadata) => (tree) => {
  const langs = new Set<string>();
  walk(tree);
  metadata.codeBlockLanguages = Array.from(langs).sort();

  function walk(node: { type?: string; children?: unknown[]; lang?: string | null }): void {
    if (node.type === 'code') {
      const lang = (node as Code).lang;
      if (lang && lang.trim()) langs.add(lang.trim());
      return;
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) walk(child as { type?: string; children?: unknown[] });
    }
  }
};
