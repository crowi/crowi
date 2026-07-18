import { createHash } from 'node:crypto';
import type { CodeBlockInfo, CodeBlockRenderer, EmbedFragment, EmbedInput, EmbedRenderer, RenderContext, RenderResult } from '@crowi/plugin-api';
import type { Code, Html, Root, RootContent } from 'mdast';
import {
  cachedRender,
  cachedRenderOrPending,
  dispatchLimitPlaceholder,
  errorPlaceholder,
  type MongoCacheStorage,
  normalizeRenderResult,
  scopeForPlugin,
} from '../cache';
import { createAuthContextStub, type RendererRegistryImpl } from '../registry';
import { acquireRenderSlot, type RenderSlotTicket } from './render-admission';

/**
 * feature-plugin-renderer-mermaid spec §5 classification C / §6 — max
 * admission-gated (`admissionControl`-declaring) code-block dispatches
 * per single pipeline run (save or page-less preview). Enforced in
 * `collectCandidates`, BEFORE any candidate touches `cachedRender` /
 * `cachedRenderOrPending` / `acquireRenderSlot` — the 51st+ such
 * candidate never reaches the cache or the admission queue at all.
 */
export const MAX_ADMISSION_DISPATCH_COUNT = 50;

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
        if (candidate.overDispatchLimit) {
          // Classification C — never touches `cachedRender` /
          // `cachedRenderOrPending` / `acquireRenderSlot`, and therefore
          // never writes to `PluginRenderCache`. Built directly so a
          // per-position (not per-source) result is possible: the same
          // source can succeed at position 10 and hit this limit at
          // position 60 within the same page, without the two competing
          // over a single cache slot.
          candidate.replacementHtml = dispatchLimitPlaceholder(MAX_ADMISSION_DISPATCH_COUNT, registration.renderer.reservation);
          return;
        }
        const { scopedCtx, adaptor, input } = buildDispatchContext(registration, candidate, ctx, deps);
        // feature-plugin-renderer-mermaid spec §5/§6 — only registrations
        // that declare `admissionControl` (today, only Mermaid) go
        // through the admission-aware `cachedRenderOrPending`. Everyone
        // else (PlantUML / KaTeX / ...) keeps calling plain `cachedRender`
        // unchanged, so today's behaviour is byte-identical for them.
        if (registration.renderer.admissionControl) {
          const outcome = await cachedRenderOrPending(deps.cache, registration.plugin, adaptor, input, scopedCtx, { priority: 'high' });
          if (outcome.kind === 'pending') {
            // Deliberately do NOT set `candidate.replacementHtml` —
            // `groupByParent` drops candidates without one, so
            // `rewriteChildren` leaves the original `code` node in
            // place. Mark it so the read path (`redispatchPendingCode
            // Blocks`) knows to retry it later without re-scanning the
            // whole tree for admission-declaring langs.
            candidate.markPending = true;
            return;
          }
          candidate.replacementHtml = outcome.html;
          return;
        }
        const rendered = await cachedRender(deps.cache, registration.plugin, adaptor, input, scopedCtx);
        candidate.replacementHtml = rendered.html;
      }),
    );

    // Rewrite each parent's children in-place. Multiple matches in
    // the same parent are spliced together so indices stay stable.
    for (const group of groupByParent(candidates)) {
      group.parent.children = rewriteChildren(group.parent.children, group.matches);
    }
    // Stamp `data.renderPending = true` on the still-`code` nodes
    // that hit an infra failure under admission. Runs AFTER the
    // replace-in-place pass above (which already left these nodes
    // untouched) so the index into `parent.children` is still valid —
    // `rewriteChildren` never removes/reorders non-replaced entries.
    for (const candidate of candidates) {
      if (!candidate.markPending) continue;
      const node = candidate.parent.children[candidate.codeIndex] as Code & { data?: Record<string, unknown> };
      if (!node || node.type !== 'code') continue; // defensive — should always still be the original code node
      node.data = { ...node.data, renderPending: true };
    }
  };

export type PreviewCodeBlockDispatchDeps = Pick<CodeBlockDispatchDeps, 'cache'>;

/**
 * feature-plugin-renderer-mermaid spec §7 items 2-6 — the page-less
 * (editor live-preview) sibling of `makeCodeBlockDispatch`. Reuses
 * `collectCandidates` / `walkBlocks` / `groupByParent` UNMODIFIED (the
 * classification-C dispatch cap they already enforce applies uniformly
 * regardless of `pageId`, spec §6), but only dispatches candidates whose
 * registration opts into `previewPolicy: 'server-render'` — every other
 * registration (PlantUML, and any future default-policy
 * `CodeBlockRenderer`) is left exactly as `makeCodeBlockDispatch` would
 * have found it: a bare `code` node, matching today's preview behaviour.
 *
 * Never touches `cachedRender` / `cachedRenderOrPending` — each
 * server-render candidate goes through `renderCodeBlockForPreview`
 * instead (`../cache`), so no `PluginRenderCache` row is ever written
 * for preview content, and no `pending`-marker bookkeeping applies
 * (nothing here is ever retried on a later read — every preview call is
 * a fresh one-shot render of the caller's current draft).
 */
export const makePreviewCodeBlockDispatch =
  (registry: RendererRegistryImpl, ctx: RenderContext, deps: PreviewCodeBlockDispatchDeps) =>
  async (tree: Root): Promise<void> => {
    if (!registry.hasCodeBlockRenderers()) return;
    const candidates = collectCandidates(tree, registry).filter(
      (candidate) => registry.getCodeBlockRenderer(candidate.lang)?.renderer.previewPolicy === 'server-render',
    );
    if (candidates.length === 0) return;

    await Promise.all(
      candidates.map(async (candidate) => {
        const registration = registry.getCodeBlockRenderer(candidate.lang);
        if (!registration) return; // defensive — the filter above already did this same lookup
        if (candidate.overDispatchLimit) {
          // Classification C (spec §5/§6) — same fixed placeholder, and
          // the same "never touches render()/acquireRenderSlot" guarantee,
          // as the save path's over-limit candidates.
          candidate.replacementHtml = dispatchLimitPlaceholder(MAX_ADMISSION_DISPATCH_COUNT, registration.renderer.reservation);
          return;
        }
        const scopedCtx = scopedRenderContext(ctx, deps.cache, registration.plugin);
        candidate.replacementHtml = await renderCodeBlockForPreview(
          registration.renderer,
          { lang: candidate.lang, source: candidate.source },
          scopedCtx,
          candidate.startLine,
          registration.plugin,
        );
      }),
    );

    for (const group of groupByParent(candidates)) {
      group.parent.children = rewriteChildren(group.parent.children, group.matches);
    }
  };

/**
 * Non-persistent sibling of `cachedRender` (`../cache`) for the editor
 * live-preview dispatch path (feature-plugin-renderer-mermaid spec §7
 * item 5). `makePreviewCodeBlockDispatch` above calls this once per
 * `previewPolicy: 'server-render'` candidate INSTEAD OF `cachedRender` /
 * `cachedRenderOrPending` — preview never reads or writes
 * `PluginRenderCache` (spec invariant: a live keystroke must never
 * persist a row for content that may never be saved).
 *
 * Reproduces exactly the two pieces of `cachedRender` preview still
 * needs, without the persistence step:
 *   1. admission-gated `render()` invocation — same `acquireRenderSlot`
 *      / `ticket.release()` wrapping `../cache`'s
 *      `renderUnderAdmissionAndStore` uses, always `priority: 'low'`
 *      (preview never outranks save/read in the wait queue, spec §6).
 *      `pluginName` MUST be the same `registration.plugin` value the
 *      save path keys its pool with — a divergent key would silently
 *      give preview jobs their own uncontended pool (pinned by the
 *      "shares the SAME admission pool" test below).
 *   2. the same exception → `{code:'unknown'}` / `RenderResult.error` →
 *      `errorPlaceholder` normalisation `../cache`'s `normalizeRenderResult`
 *      applies — imported and called here directly (not reimplemented)
 *      so a thrown `render()` and a returned `RenderResult.error`
 *      produce BYTE-IDENTICAL placeholder html to the save path (pinned
 *      by the two "error normalisation parity" tests below).
 *
 * Preview failures fall under classification A (the plugin itself
 * already returns a `RenderResult.error` / fixed placeholder html) or
 * classification B (admission rejection / a thrown `render()`) — spec
 * §7 item 5's closing line is explicit that preview does not get a
 * third failure kind of its own.
 *
 * `startLine`, when a number, wraps the resolved HTML in
 * `<div data-source-line="N">…</div>` — the scroll-sync anchor
 * `injectSourceLineAnchors` (`hono/handlers/page-preview.ts`) cannot
 * reach a `code` → `html` replacement node (see that function's doc
 * comment), so this is the one place left that can still attach it
 * (spec §7 item 6).
 */
export async function renderCodeBlockForPreview(
  cb: CodeBlockRenderer,
  info: CodeBlockInfo,
  ctx: RenderContext,
  startLine: number | undefined,
  pluginName: string,
): Promise<string> {
  let ticket: RenderSlotTicket | undefined;
  if (cb.admissionControl) {
    try {
      ticket = await acquireRenderSlot({
        pluginName,
        actor: ctx.actor,
        priority: 'low',
        signal: ctx.signal,
        admissionControl: cb.admissionControl,
      });
    } catch {
      // Queue overflow, or ctx.signal aborted while queued. There is no
      // persisted "pending" marker to fall back to in preview (nothing
      // is written), so this degrades to the same fixed placeholder a
      // thrown render() gets below — classification B, normalised the
      // same way `../cache`'s `normalizeRenderResult` normalises an
      // infra failure.
      return wrapWithSourceLine(errorPlaceholder('unknown', cb.reservation), startLine);
    }
  }

  try {
    const { html } = await normalizeRenderResult(() => cb.render(info, ctx), cb.reservation);
    return wrapWithSourceLine(html, startLine);
  } finally {
    ticket?.release();
  }
}

/** spec §7 item 6 — wrap the resolved HTML in the scroll-sync anchor div when a source line is known. */
function wrapWithSourceLine(html: string, startLine: number | undefined): string {
  if (typeof startLine !== 'number') return html;
  return `<div data-source-line="${startLine}">${html}</div>`;
}

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
  /**
   * feature-plugin-renderer-mermaid spec §7 item 2 — the original `code`
   * node's `position.start.line`, filled in unconditionally by
   * `collectCandidates` (the save path never reads it; the preview path,
   * `makePreviewCodeBlockDispatch` below, uses it to embed the
   * `data-source-line` scroll-sync anchor directly into the replacement
   * HTML string, see `renderCodeBlockForPreview`'s doc comment for why).
   */
  startLine?: number;
  /** Filled in after the async render. */
  replacementHtml?: string;
  /** feature-plugin-renderer-mermaid §5 — set when `cachedRenderOrPending` returned `{ kind: 'pending' }`. */
  markPending?: boolean;
  /** feature-plugin-renderer-mermaid §5 classification C — the Nth+1 (N=`MAX_ADMISSION_DISPATCH_COUNT`) admission-gated candidate in this pipeline run. */
  overDispatchLimit?: boolean;
}

/**
 * Block-level walker that finds `code` nodes whose `lang` has a
 * registered renderer. Recurses into any block container with a
 * `children` array — root, blockquote, list, listItem, etc. — but
 * skips phrasing-only nodes (no point descending into them; fenced
 * code is never inside a paragraph / link / etc.).
 *
 * Also enforces the classification-C dispatch-count cap (spec §5/§6/§7):
 * `admissionDispatchCount` counts candidates whose registration declares
 * `admissionControl` (the save-path admission-queue gate, §6) OR
 * `previewPolicy: 'server-render'` (the preview-path opt-in, §7) — today
 * (Mermaid only) these two are always declared together, so the union is
 * behaviourally identical to either condition alone for the shipped
 * plugin set, but the union closes a real gap: a future
 * `previewPolicy: 'server-render'` registration that does NOT declare
 * `admissionControl` would call `cb.render()` directly in
 * `renderCodeBlockForPreview` with no admission gate (see that function's
 * doc comment), so the diagram-count cap is the ONLY thing bounding how
 * many times such a renderer runs in one pipeline execution — counting
 * it only on `admissionControl` presence would let it dispatch
 * unboundedly in preview. The (`MAX_ADMISSION_DISPATCH_COUNT` + 1)th such
 * candidate onward is flagged `overDispatchLimit` here, at collection
 * time — before any cache or admission I/O happens for it. This is a
 * distinct concern from `registration.renderer.admissionControl`'s OTHER
 * job, deciding `cachedRenderOrPending` vs. plain `cachedRender` in
 * `makeCodeBlockDispatch` below — that routing decision stays keyed on
 * `admissionControl` alone (spec §5).
 */
function collectCandidates(tree: Root, registry: RendererRegistryImpl): Candidate[] {
  const out: Candidate[] = [];
  let admissionDispatchCount = 0;
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
      let overDispatchLimit = false;
      if (registration.renderer.admissionControl || registration.renderer.previewPolicy === 'server-render') {
        admissionDispatchCount += 1;
        overDispatchLimit = admissionDispatchCount > MAX_ADMISSION_DISPATCH_COUNT;
      }
      out.push({
        parent: parent as Candidate['parent'],
        codeIndex: i,
        lang,
        source: code.value ?? '',
        startLine: code.position?.start?.line,
        overDispatchLimit,
      });
    }
  });
  return out;
}

/**
 * Plugin-scoped `RenderContext` (per-plugin cache view + auth stub) that
 * every dispatch path — `buildDispatchContext` below (page-bound save /
 * redispatch) and `makePreviewCodeBlockDispatch` (page-less preview) —
 * needs before calling into plugin code.
 */
function scopedRenderContext(ctx: RenderContext, cache: MongoCacheStorage, plugin: string): RenderContext {
  return { ...ctx, cache: scopeForPlugin(cache, plugin), auth: createAuthContextStub() };
}

/**
 * Shared by `makeCodeBlockDispatch` / `redispatchPendingCodeBlocks` — build
 * the per-candidate `RenderContext` (via `scopedRenderContext`), the
 * `CodeBlockRenderer` → `EmbedRenderer` adaptor, and the re-packed
 * `EmbedInput` (see `codeBlockAsEmbedRenderer`'s doc comment for why lang/
 * source travel as `tag`/`url`) a `cachedRender` / `cachedRenderOrPending`
 * call needs. Both callers pass their own candidate shape through the
 * `{ lang, source }` view, since that is all this needs.
 */
function buildDispatchContext(
  registration: { plugin: string; renderer: CodeBlockRenderer },
  candidate: { lang: string; source: string },
  ctx: RenderContext,
  deps: CodeBlockDispatchDeps,
): { scopedCtx: RenderContext; adaptor: EmbedRenderer; input: EmbedInput } {
  const scopedCtx = scopedRenderContext(ctx, deps.cache, registration.plugin);
  const adaptor = codeBlockAsEmbedRenderer(registration.renderer);
  const input: EmbedInput = { tag: candidate.lang, url: candidate.source, pageId: deps.pageId };
  return { scopedCtx, adaptor, input };
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
    // feature-plugin-renderer-mermaid spec §6 — `cachedRenderOrPending`
    // is written against the `EmbedRenderer` shape and branches on
    // `renderer.admissionControl`; without copying it through here it
    // would always see `undefined` and silently fall back to plain
    // `cachedRender` behaviour for every admission-declaring plugin.
    admissionControl: cb.admissionControl,
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

/**
 * Cheap pre-check: does `tree` contain any `code` node carrying
 * `data.renderPending === true`? Used by `computeRevisionRenderArtifactsAsync`
 * (`packages/api/src/util/page-response.ts`) to skip the (rare) redispatch
 * path entirely for the overwhelming majority of reads. No registry
 * lookup / async work here — pure tree walk.
 */
export function hasPendingRenderMarker(tree: Root): boolean {
  let found = false;
  walkBlocks(tree as MutableParent, (parent) => {
    if (found) return;
    const children = parent.children;
    if (!children) return;
    for (const child of children) {
      if (child.type !== 'code') continue;
      const code = child as Code & { data?: { renderPending?: boolean } };
      if (code.data?.renderPending === true) {
        found = true;
        return;
      }
    }
  });
  return found;
}

interface PendingCandidate {
  parent: MutableParent & { children: RootContent[] };
  codeIndex: number;
  lang: string;
  source: string;
}

function collectPendingCandidates(tree: Root): PendingCandidate[] {
  const out: PendingCandidate[] = [];
  walkBlocks(tree as MutableParent, (parent) => {
    const children = parent.children;
    if (!children) return;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.type !== 'code') continue;
      const code = child as Code & { data?: { renderPending?: boolean } };
      if (code.data?.renderPending !== true) continue;
      const lang = (code.lang ?? '').trim();
      if (!lang) continue;
      out.push({ parent: parent as PendingCandidate['parent'], codeIndex: i, lang, source: code.value ?? '' });
    }
  });
  return out;
}

/**
 * Limited redispatch for the read path (spec §5, second bullet): retry
 * ONLY the `code` nodes still carrying `data.renderPending`,
 * routed through `cachedRenderOrPending` with `priority: 'high'` (never
 * plain `cachedRender` — a retry that is STILL failing must not get
 * cached as a fresh error, see cache/index.ts's doc comment). Does not
 * touch any other node and never re-runs the full parse/transform
 * pipeline; callers are expected to have already checked
 * `hasPendingRenderMarker(tree)` before paying for this walk.
 *
 * Mutates `tree` in place (matching `makeCodeBlockDispatch`'s own
 * convention) and reports whether anything actually changed, so the
 * caller can decide whether the mutated tree needs to be treated as a
 * distinct value from the one it started with (`page-response.ts` clones
 * before calling this, precisely so the mutation never reaches the
 * Mongoose-owned `Revision.renderedAst` object).
 */
export async function redispatchPendingCodeBlocks(
  tree: Root,
  registry: RendererRegistryImpl,
  ctx: RenderContext,
  deps: CodeBlockDispatchDeps,
): Promise<{ changed: boolean }> {
  const candidates = collectPendingCandidates(tree);
  if (candidates.length === 0) return { changed: false };

  let changed = false;
  await Promise.all(
    candidates.map(async (candidate) => {
      const registration = registry.getCodeBlockRenderer(candidate.lang);
      if (!registration) return; // plugin no longer registered — leave the marker as-is
      const { scopedCtx, adaptor, input } = buildDispatchContext(registration, candidate, ctx, deps);
      const outcome = await cachedRenderOrPending(deps.cache, registration.plugin, adaptor, input, scopedCtx, { priority: 'high' });
      if (outcome.kind === 'pending') return; // still failing — node (and its marker) stays untouched
      const html: Html = { type: 'html', value: outcome.html };
      candidate.parent.children[candidate.codeIndex] = html;
      changed = true;
    }),
  );
  return { changed };
}
