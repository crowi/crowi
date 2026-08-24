import type { RenderContext } from '@crowi/plugin-api';
import type { Root } from 'mdast';
import type { MongoCacheStorage } from '../cache';
import type { PipelineEsmDeps } from '../pipeline';
import type { RendererRegistryImpl } from '../registry';
import { remarkNormalizeHtmlBreaks } from './break-normalization';
import { makeCodeBlockDispatch } from './code-block-dispatch';
import { remarkCodeBlockLanguages } from './code-blocks';
import { makeEmbedTagDispatch } from './embed-tags';
import { makeFrontmatterPlugin } from './frontmatter';
import { makeGithubAlertsPlugin } from './github-alerts';
import { makeRemarkHeadings, type UnifiedTransformPlugin } from './headings';
import { remarkImageAttrs } from './image-attrs';
import { remarkMentions } from './mentions';
import { makeRawSpaceLinkRecovery } from './raw-space-links';
import { makeRemarkSyntaxHighlight } from './syntax-highlight';
import { makeUrlInlineExpandDispatch } from './url-inline-expand';
import { remarkWikiLinks } from './wikilinks';

export {
  type CodeBlockDispatchDeps,
  hasPendingRenderMarker,
  makeCodeBlockDispatch,
  makePreviewCodeBlockDispatch,
  type PreviewCodeBlockDispatchDeps,
  redispatchPendingCodeBlocks,
} from './code-block-dispatch';
export { makeEmbedTagDispatch } from './embed-tags';
export type { UnifiedTransformPlugin } from './headings';
export { type MentionUsernameResolver, makeMentionResolve } from './mention-resolve';
export {
  type AcquireRenderSlotOptions,
  acquireRenderSlot,
  RenderAdmissionAbortedError,
  RenderAdmissionQueueOverflowError,
  type RenderPriority,
  type RenderSlotTicket,
} from './render-admission';
export { makeUrlInlineExpandDispatch } from './url-inline-expand';

/**
 * Build the bundled core renderer transform plugins, in their fixed
 * order (frontmatter → github-alerts → headings → raw-space-links →
 * image-attrs → wikilinks → mentions → code-blocks → syntax-highlight →
 * break-normalization). The pipeline prepends these to the registry's
 * external plugins on every run.
 *
 * Order rationale:
 *   - frontmatter (feature-renderer-frontmatter §D-3) runs FIRST,
 *     before any other transform, so a document-leading `yaml` node
 *     (produced by the `remarkFrontmatter` parser extension in
 *     `pipeline.ts`, §D-2) is always replaced with `crowiFrontmatter` /
 *     `code` before headings/wikilinks/mentions/`remarkBreaks` could
 *     ever see it.
 *   - github-alerts runs right after it, and before every
 *     content-rewriting transform, because it decides whether a root
 *     block quote is a GitHub Alerts callout by re-reading the run's
 *     raw `body` at that quote's own `position` — a check that is only
 *     sound while `position` still describes pristine source, and while
 *     the marker's line delimiter is still a line ending rather than
 *     the `break` node `remarkBreaks` makes of it. It only ever retypes
 *     the outer `blockquote` to `crowiAlert`; the child subtree (marker
 *     text included) is passed on completely unchanged, so every later
 *     transform sees exactly what it would have seen without it.
 *   - headings runs next so the slugger sees pristine heading text
 *     before any text rewrite (wikilinks / mentions inside headings
 *     would otherwise change the visible label).
 *   - raw-space-links (feature-page-link-space-paths Phase 2) runs
 *     right after headings, BEFORE every other content-rewriting
 *     transform, so it always sees pristine `text` nodes straight from
 *     `processor.parse(body)` with accurate, untouched `position`
 *     offsets — it needs those to slice the raw `body` for its escape
 *     check (see `raw-space-links.ts`). Running it any later risks a
 *     text node whose `.value` a prior transform already mutated
 *     in-place without updating `.position` (e.g. `remarkImageAttrs`
 *     trims a leading attribute block from a text node's `.value` but
 *     keeps its original `.position`), which would desync the raw
 *     slice from the de-escaped value.
 *   - image-attrs (RFC-0015) runs next, BEFORE wikilinks/mentions, so
 *     the `{...}` attribute-block text immediately following an image
 *     is still an intact, unsplit text node when it scans for the
 *     block — wikilinks/mentions rewrite text nodes on their own
 *     patterns and would otherwise fragment it first. raw-space-links
 *     running before this is safe: it only ever splits a text node
 *     AROUND a matched `[label](/a b)` run, always leaving any
 *     unmatched leading text (including a `{...}` block) intact as its
 *     own untouched sibling.
 *   - wikilinks + mentions next, both walking text nodes and skipping
 *     inside code / inlineCode.
 *   - code-blocks (the lang aggregator) runs BEFORE syntax-highlight
 *     because the latter rewrites `code` nodes into `html`, after
 *     which the aggregator would no longer find them.
 *   - syntax-highlight runs before break-normalization: its output is
 *     a large, attribute-bearing `html` node at flow position, well
 *     outside break-normalization's phrasing-unit scope, so ordering
 *     between the two never changes either one's result — but syntax-
 *     highlight must still run before ANY transform that could see a
 *     `code` node so wikilinks / mentions / heading anchors are
 *     already stamped by the time the AST gets persisted.
 *   - break-normalization (feature-renderer-break-normalization §D-5)
 *     runs LAST among core plugins, right before `remarkBreaks`
 *     (`pipeline.ts`): it turns a bare `<br>` `html` node into a
 *     canonical `break` inside an uncontaminated `paragraph` /
 *     `heading` / `tableCell` phrasing subtree. It must run AFTER
 *     GitHub Alerts (which keys its marker-vs-body decision on the
 *     child at index 1 still being `html`, not yet `break`) and after
 *     headings / raw-space-links (both need pristine pre-rewrite
 *     `position` / text), and it must run BEFORE `remarkBreaks` / emoji
 *     / every external transform so those observe the canonical
 *     `break` a bare `<br>` normalizes to instead of raw HTML.
 *
 * Bound to the loaded ESM deps because `headings` needs
 * `GithubSlugger` + `mdast-util-to-string`'s `toString` and
 * `syntax-highlight` needs `shiki`; neither can be statically
 * imported from CJS. `body` is threaded through separately (not part
 * of `PipelineEsmDeps`, which is process-wide-cacheable — `body` is
 * per-run) so `raw-space-links.ts` can bind it via its own factory.
 */
export function buildCorePlugins(deps: PipelineEsmDeps, body: string): UnifiedTransformPlugin[] {
  return [
    makeFrontmatterPlugin,
    makeGithubAlertsPlugin(body),
    makeRemarkHeadings(deps),
    makeRawSpaceLinkRecovery(body),
    remarkImageAttrs,
    remarkWikiLinks,
    remarkMentions,
    remarkCodeBlockLanguages,
    makeRemarkSyntaxHighlight(deps),
    remarkNormalizeHtmlBreaks,
  ];
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
