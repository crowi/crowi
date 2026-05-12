import type { Heading, Root } from 'mdast';
import type { TocEntryResponse } from '@crowi/api-contract';
import type { PipelineEsmDeps, PipelineMetadata } from '../pipeline';

/**
 * Core renderer transform — extract a flat TOC from heading nodes and
 * stamp each heading with a stable `data.hProperties.id` matching the
 * anchor id (so SSR HTML downstream can use the same id).
 *
 * github-slugger handles dedup (`-1`, `-2`, …) and CJK preservation.
 *
 * The factory takes the ESM deps because `github-slugger` /
 * `mdast-util-to-string` are ESM-only and cannot be statically
 * imported from `apps/crowi-api` (CJS). It returns a unified plugin
 * that accepts `metadata` as its option.
 */
export type UnifiedTransformPlugin = (metadata: PipelineMetadata) => (tree: Root) => void;

export const makeRemarkHeadings =
  (deps: PipelineEsmDeps): UnifiedTransformPlugin =>
  (metadata) =>
  (tree) => {
    const slugger = new deps.GithubSlugger();
    walk(tree);

    function walk(node: { type?: string; children?: unknown[] }): void {
      if (node.type === 'heading') {
        const heading = node as Heading;
        const text = deps.mdastToString(heading).trim();
        const anchorId = slugger.slug(text);
        const entry: TocEntryResponse = {
          level: heading.depth,
          text,
          anchorId,
        };
        metadata.toc.push(entry);

        // Stamp the heading so any downstream SSR renderer (Phase 3)
        // can use the same id without re-running a slugger.
        const data = (heading.data ?? (heading.data = {})) as { hProperties?: Record<string, unknown> };
        data.hProperties = { ...(data.hProperties ?? {}), id: anchorId };
        return;
      }

      if (Array.isArray(node.children)) {
        for (const child of node.children) walk(child as { type?: string; children?: unknown[] });
      }
    }
  };
