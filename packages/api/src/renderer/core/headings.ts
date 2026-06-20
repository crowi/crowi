import type { Heading, Root } from 'mdast';
import type { TocEntryResponse } from '@crowi/api-contract';
import { stripKnownHtmlTags } from 'src/util/html-elements';
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
 * imported from `packages/api` (CJS). It returns a unified plugin
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
        // `mdast-util-to-string` defaults to `includeHtml: true`, so raw inline
        // markup inside a heading (e.g. `### <font color="…">Workspace</font>`)
        // is present in `raw`. We then strip ONLY *known* HTML tags via
        // `stripKnownHtmlTags`, so the raw `<font …>` / `</font>` markup does
        // not leak into `meta.toc.text` while a non-tag token that merely looks
        // like a tag (`### Using List<int> in C#`) is preserved verbatim.
        const raw = deps.mdastToString(heading).trim();
        const text = stripKnownHtmlTags(raw).trim();
        // A heading that is *only* a known HTML tag (`### <br>`) collapses to an
        // empty label after the strip. Such an entry carries no usable anchor or
        // text (the slug of `''` is `''`), and `Revision.meta.toc` requires
        // a non-empty `text` / `anchorId`, so we drop it from the TOC
        // entirely rather than persist an unaddressable empty row. A heading
        // that is only an *unknown* tag-like token (`### <int>`) keeps `<int>`
        // as its literal label.
        if (text.length === 0) return;
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
