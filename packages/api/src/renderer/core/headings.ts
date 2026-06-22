import type { Heading, Root } from 'mdast';
import { type TocEntryResponse, stripKnownHtmlTags } from '@crowi/api-contract';
import type { PipelineEsmDeps, PipelineMetadata } from '../pipeline';

/**
 * Core renderer transform — extract a flat TOC from heading nodes and
 * stamp each heading with a stable `data.hProperties.id` matching the
 * anchor id (so SSR HTML downstream can use the same id).
 *
 * `meta.toc[].text` holds the RAW heading text (inline HTML included, as
 * authored) — the stored data is never mutated and the web strips the inline
 * HTML out of the label at DISPLAY time via the SAME `stripKnownHtmlTags`
 * helper (shared from `@crowi/api-contract`). The anchor id, on the other
 * hand, is slugged from the STRIPPED text so the in-page hash stays clean and
 * `hProperties.id === '#' + anchorId` (the web jumps using `anchorId`, never a
 * local slugger). Old pages render fine without any migration: their stored
 * id/href stay mutually consistent, the label is cleaned at display, and a
 * re-save upgrades the hash to the clean slug.
 *
 * github-slugger handles dedup (`-1`, `-2`, …) and CJK preservation; it is
 * called exactly once per heading.
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
        // is present in `raw`. We keep that RAW text as the stored TOC label —
        // the web strips known HTML tags out at display time — but slug the
        // anchor id from the STRIPPED text so the in-page hash is clean and
        // matches the heading DOM id (`id == href`).
        const raw = deps.mdastToString(heading).trim();
        if (raw.length === 0) return;
        const stripped = stripKnownHtmlTags(raw).trim();
        // Slug once per heading. A heading that is *only* a known HTML tag
        // (`### <br>`) strips to an empty string; we still stamp a non-empty
        // id from the raw text so the body heading is never given an empty id,
        // but we drop it from the TOC below (no visible label to address).
        const anchorId = slugger.slug(stripped.length > 0 ? stripped : raw);

        // Stamp the heading so any downstream SSR renderer (Phase 3)
        // can use the same id without re-running a slugger.
        const data = (heading.data ?? (heading.data = {})) as { hProperties?: Record<string, unknown> };
        data.hProperties = { ...(data.hProperties ?? {}), id: anchorId };

        // Push a TOC entry only when there is a visible (post-strip) label.
        // A heading that is only an *unknown* tag-like token (`### <int>`)
        // keeps `<int>` as its label and is kept; an HTML-only heading
        // (`### <br>`) collapses to nothing visible and is dropped.
        if (stripped.length > 0) {
          const entry: TocEntryResponse = {
            level: heading.depth,
            text: raw,
            anchorId,
          };
          metadata.toc.push(entry);
        }
        return;
      }

      if (Array.isArray(node.children)) {
        for (const child of node.children) walk(child as { type?: string; children?: unknown[] });
      }
    }
  };
