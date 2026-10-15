'use client';

import { isGeneratedHtmlOrigin } from '@crowi/api-contract';
import { type HtmlSanitizationPolicy, type SanitizeWebHastResult, sanitizeWebHast, validateWebRenderInput } from '@crowi/api-contract/html-sanitizer';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { toHast } from 'mdast-util-to-hast';
import type { State } from 'mdast-util-to-hast';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import type { Element as HastElement, Properties as HastProperties, Root as HastRoot } from 'hast';
import type { ReactNode } from 'react';
import { CrowiAlert, type CrowiAlertVariant, isCrowiAlertVariant } from './crowi-alert';

export { escapeUnknownRawHtml } from '@crowi/api-contract/html-sanitizer';

/**
 * feature-renderer-frontmatter §D-5 — wire shape of the `crowiFrontmatter`
 * mdast node the api's `core/frontmatter.ts` transform produces. No
 * `children` (values are never re-parsed as Markdown — an entry's `*` or
 * `[` must render as the literal character, not an accidental emphasis /
 * link).
 */
interface CrowiFrontmatterMdastNode {
  type: 'crowiFrontmatter';
  entries?: Array<{ key?: unknown; value?: unknown }>;
  data?: { hProperties?: Record<string, unknown> };
}

/**
 * Custom `toHast` handler for `crowiFrontmatter` — rendered as a `<dl>`
 * of `<dt>`/`<dd>` pairs (a 2-column grid via `.crowi-frontmatter` in
 * `globals.css`), not a `<table>`: every real `<table>` element is
 * unconditionally wrapped by `page-content.tsx`'s `MarkdownTableFullscreen`
 * / `markdown-preview.tsx`'s `w-full border-collapse` override, neither of
 * which fits a handful of metadata rows (open question default: no
 * border, muted key, body-color value). `<dl>`/`<dt>`/`<dd>` have no
 * component override in either caller, so this needs no change to
 * `page-content.tsx` or `markdown-preview.tsx` — both already share this
 * function, so page-view/preview parity is automatic. Text nodes only
 * (never markdown-reinterpreted, matching the node's `children`-less
 * mdast shape): each key/value is `entries[]`'s raw string, unescaped by
 * this handler (`hast-util-to-jsx-runtime` renders hast `text` node
 * values as plain text, not HTML).
 */
function crowiFrontmatterHandler(_state: State, node: CrowiFrontmatterMdastNode): HastElement {
  const entries = Array.isArray(node.entries) ? node.entries : [];
  const rows: HastElement[] = entries.flatMap((entry) => [
    { type: 'element', tagName: 'dt', properties: {}, children: [{ type: 'text', value: typeof entry.key === 'string' ? entry.key : '' }] },
    { type: 'element', tagName: 'dd', properties: {}, children: [{ type: 'text', value: typeof entry.value === 'string' ? entry.value : '' }] },
  ]);
  // Merge only `data.hProperties` (e.g. the editor preview's
  // `data-source-line` scroll-sync anchor, stamped per top-level node)
  // onto this handler's OWN fixed <dl> — deliberately NOT
  // `state.applyData(node, element)`, which also honors
  // `data.hName`/`data.hChildren` and would let an unexpected `data`
  // shape replace the guaranteed dl/dt/dd structure or drop the
  // `crowi-frontmatter` class AC-11 depends on. Both `className` AND
  // its HTML-attribute alias `class` are stripped before merging —
  // `hast-util-to-jsx-runtime` resolves either key to the DOM `class`
  // attribute, so leaving `class` in place while only reassigning
  // `className` would let it win over the fixed class (both keys
  // survive a spread; only the LAST one written to a given output
  // attribute is rendered).
  const {
    className: _incomingClassName,
    class: _incomingClassAlias,
    ...hProperties
  } = node.data?.hProperties && typeof node.data.hProperties === 'object' ? node.data.hProperties : {};
  return { type: 'element', tagName: 'dl', properties: { ...hProperties, className: ['crowi-frontmatter'] }, children: rows };
}

/**
 * Wire shape of the `crowiAlert` mdast node the api's
 * `core/github-alerts.ts` transform produces. The children are the
 * block quote's ORIGINAL ones, literal marker (`[!NOTE]` text + the
 * `break` remark-breaks made of its line ending) included: the marker
 * survives into the stored AST so that consumers without this handler
 * still show today's block quote verbatim.
 */
interface CrowiAlertMdastNode {
  type: 'crowiAlert';
  variant?: unknown;
  children?: unknown[];
  data?: { hProperties?: Record<string, unknown> };
}

type MdastLike = { type?: string; children?: MdastLike[]; value?: string };

/**
 * Drop the marker run — the leading `[!variant]` text and the `break`
 * that terminated its line — from a COPY of the render input, so the
 * callout body starts at the author's actual content. A marker
 * paragraph left empty by that removal is dropped whole (it would
 * otherwise render as a stray empty `<p>` above the body).
 *
 * Returns `null` when the producer's marker shape is not exactly what
 * the transform emits (a hand-written or future-shaped `crowiAlert`):
 * the defensive answer there is to show every child rather than guess
 * which one was decoration.
 */
function withoutMarker(children: MdastLike[], variant: CrowiAlertVariant): MdastLike[] | null {
  const paragraph = children[0];
  if (paragraph?.type !== 'paragraph' || !paragraph.children) return null;
  const marker = paragraph.children[0];
  // `variant` is one of five fixed lowercase tokens, so folding the
  // author's spelling down is the whole of the case-insensitive match.
  if (marker?.type !== 'text' || marker.value?.toLowerCase() !== `[!${variant}]`) return null;

  const afterMarker = paragraph.children.slice(1);
  // Marker alone in its paragraph — the body starts in a later block.
  // Drop the paragraph whole.
  if (afterMarker.length === 0) return children.slice(1);
  // The transform only ever emits the marker followed by the `break`
  // `remarkBreaks` makes of the line ending that terminated it. A marker
  // butted directly against other content is a shape we never produce, so
  // decorate nothing rather than guess which child was the author's.
  if (afterMarker[0]?.type !== 'break') return null;
  const body = afterMarker.slice(1);
  if (body.length === 0) return children.slice(1);
  return [{ ...paragraph, children: body }, ...children.slice(1)];
}

/**
 * Custom `toHast` handler for `crowiAlert` — a fixed `<aside>` that
 * `CrowiAlert` (composed into the component map below) turns into the
 * callout. Deliberately NOT `state.applyData(node, element)`: an
 * unexpected `data.hName` / `hChildren` would otherwise be able to
 * replace the guaranteed element, and the producer's own
 * `hName: 'blockquote'` (the fallback hint for bundles WITHOUT this
 * handler) would defeat the callout here. Only the editor preview's
 * `data-source-line` anchor is forwarded.
 */
function crowiAlertHandler(state: State, node: CrowiAlertMdastNode): HastElement {
  const variant = node.variant;
  const children = Array.isArray(node.children) ? (node.children as MdastLike[]) : [];
  const renderInput = isCrowiAlertVariant(variant) ? (withoutMarker(children, variant) ?? children) : children;

  const sourceLine = node.data?.hProperties?.['data-source-line'];
  const properties: HastProperties = {};
  if (typeof sourceLine === 'string' || typeof sourceLine === 'number') properties['data-source-line'] = sourceLine;
  // No `className` here on purpose: `CrowiAlert` (composed as the `aside`
  // component after the caller's map) owns the callout classes and builds
  // them from this variant attribute. A copy here would never reach the
  // DOM — it would just be a second place to edit on a class rename.
  if (typeof variant === 'string') properties['data-crowi-alert-variant'] = variant;

  return {
    type: 'element',
    tagName: 'aside',
    properties,
    children: state.all({ ...node, children: renderInput } as never),
  };
}

/**
 * Minimal hast subset used by `wrapSections`. Keeping this local
 * avoids pulling `@types/hast` into the editor surface (already
 * a dep of `page-content.tsx` but the shape is small enough that
 * duplication is cheaper than another type-export plumbing pass).
 */
export type HastLike = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastLike[];
  value?: string;
};

const HEADING_RE = /^h[1-6]$/;

/**
 * Group each heading + its following sibling content into a
 * `<section data-section-id="…">` so the URL-fragment highlight on the
 * show page has a wrappable element. Pure walk; mutates in place
 * (caller passes a fresh hast tree from `toHast`).
 *
 * Lifted out of `page-content.tsx` so the editor preview can run the
 * same wrap when `sectionWrap: true`. The preview path keeps it off
 * (no anchor jump or hover affordances exist in the preview pane).
 */
export function wrapSections(tree: HastLike): void {
  if (!tree.children) return;
  const out: HastLike[] = [];
  let current: HastLike | null = null;

  for (const child of tree.children) {
    const isHeading = child.type === 'element' && typeof child.tagName === 'string' && HEADING_RE.test(child.tagName);
    if (isHeading) {
      const id = (child.properties?.id as string | undefined) ?? undefined;
      current = {
        type: 'element',
        tagName: 'section',
        properties: id ? { 'data-section-id': id } : {},
        children: [child],
      };
      out.push(current);
    } else if (current) {
      current.children!.push(child);
    } else {
      out.push(child);
    }
  }

  tree.children = out;
}

export interface RenderMdastOptions {
  /**
   * Toggle the `wrapSections` pass + `<section>` component override.
   * The show page (`page-content.tsx`) wants the wrap so its URL hash
   * highlight can climb to the section element; the editor preview
   * never reads the URL hash, so it leaves the tree unwrapped to keep
   * the produced React tree closer to plain mdast.
   */
  sectionWrap?: boolean;
  /**
   * Components map passed to `toJsxRuntime`. Both the show page and
   * the preview want the same prose-styling overrides (h1..h6, table,
   * code, blockquote, etc.). The show page additionally injects a
   * `section` override (URL-hash highlight); the preview omits it.
   */
  components: Parameters<typeof toJsxRuntime>[1]['components'];
  /** HTML policy. Omitted means strict, which is also what any other value selects. */
  policy?: HtmlSanitizationPolicy;
}

export type RenderMdastResult =
  | { status: 'ok'; node: ReactNode }
  | { status: 'missing' }
  | { status: 'failed'; reason: NonNullable<SanitizeWebHastResult['failure']> };

/**
 * Wire shape of the local node `replaceLinkCardPreviewPlaceholders` inserts
 * into the editor preview's AST: a static card for `@[card](url)` that never
 * fetches anything.
 */
interface CrowiLinkCardPreviewMdastNode {
  type: 'crowiLinkCardPreview';
  url?: unknown;
  message?: unknown;
  sourceLine?: unknown;
}

function cardSpan(className: string, children: HastElement['children'], properties: HastProperties = {}): HastElement {
  return { type: 'element', tagName: 'span', properties: { ...properties, className: [className] }, children };
}

/**
 * Fixed `span` structure (a span, not a figure/div: the placeholder may sit
 * inside a paragraph, and `.crowi-link-card` styles it as a block). Text
 * nodes only, so the URL and the message can never become markup.
 */
function crowiLinkCardPreviewHandler(_state: State, node: CrowiLinkCardPreviewMdastNode): HastElement {
  const properties: HastProperties = {};
  if (typeof node.sourceLine === 'number' && Number.isInteger(node.sourceLine) && node.sourceLine > 0) properties['data-source-line'] = node.sourceLine;
  const url = typeof node.url === 'string' ? node.url : '';
  const message = typeof node.message === 'string' ? node.message : '';
  return cardSpan(
    'crowi-link-card',
    [
      cardSpan('crowi-link-card-preview-surface', [
        cardSpan('crowi-link-card-body', [
          cardSpan('crowi-link-card-title', [{ type: 'text', value: url }]),
          cardSpan('crowi-link-card-preview-message', [{ type: 'text', value: message }]),
        ]),
      ]),
    ],
    properties,
  );
}

/**
 * `html` nodes become `raw` hast nodes. Only an html node carrying the
 * generated-HTML mark (`data.g === 1`) keeps a mark on the raw node; the
 * sanitizer composes those as-is and puts everything else through the strict
 * author allow-list, so no attribute or class can claim generated status.
 * Every raw this handler returns is recorded in `produced` so that a raw
 * smuggled in some other way (e.g. `data.hChildren`) can be told apart.
 */
function createHtmlHandler(produced: WeakSet<object>) {
  return (state: State, node: { type: 'html'; value?: unknown; data?: { g?: unknown } }): unknown => {
    if (typeof node.value !== 'string') return undefined;
    const result: { type: 'raw'; value: string; data?: { g: 1 } } = { type: 'raw', value: node.value };
    if (isGeneratedHtmlOrigin(node.data?.g)) result.data = { g: 1 };
    produced.add(result);
    state.patch(node as never, result as never);
    return result;
  };
}

/** Drops the generated mark from any raw node the html handler did not produce. */
function dropForeignGeneratedMarks(root: unknown, produced: WeakSet<object>): void {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as { type?: string; data?: unknown; children?: unknown[] } | null;
    if (typeof node !== 'object' || node === null) continue;
    if (node.type === 'raw' && !produced.has(node)) delete node.data;
    if (Array.isArray(node.children)) for (const child of node.children) stack.push(child);
  }
}

function createSlotNonce(): string | undefined {
  const webCrypto = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;
  if (!webCrypto?.getRandomValues) return undefined;
  const bytes = webCrypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function createHandlers(produced: WeakSet<object>) {
  return {
    crowiFrontmatter: crowiFrontmatterHandler,
    crowiAlert: crowiAlertHandler,
    crowiLinkCardPreview: crowiLinkCardPreviewHandler,
    html: createHtmlHandler(produced),
  } as unknown as NonNullable<Parameters<typeof toHast>[1]>['handlers'];
}

/**
 * Convert a server-emitted mdast tree to a React node: `toHast`, then the
 * shared strict sanitizer (the single enforcement point for author HTML, used
 * by the show page, history view and editor preview alike), then
 * `toJsxRuntime`. A failure is reported, never papered over with the
 * unsanitized tree.
 *
 * `allowDangerousHtml: true` is required because generated fragments (Shiki,
 * KaTeX, diagrams, cards) arrive as `html` nodes; the sanitizer separates
 * those (marked at render time) from author HTML.
 */
export function renderMdastToReactResult(renderedAst: unknown, options: RenderMdastOptions): RenderMdastResult {
  if (!renderedAst) return { status: 'missing' };
  const invalid = validateWebRenderInput(renderedAst);
  if (invalid) return { status: 'failed', reason: invalid };

  const produced = new WeakSet<object>();
  let hast: ReturnType<typeof toHast>;
  try {
    hast = toHast(renderedAst as Parameters<typeof toHast>[0], { allowDangerousHtml: true, handlers: createHandlers(produced) });
  } catch {
    return { status: 'failed', reason: 'parse-failed' };
  }
  if (!hast) return { status: 'missing' };
  dropForeignGeneratedMarks(hast, produced);
  if (options.sectionWrap) {
    // Section wrap runs on the shallow mdast-derived tree, before the
    // sanitizer expands generated fragments into hundreds of nodes.
    wrapSections(hast as HastLike);
  }

  const slotNonce = createSlotNonce();
  if (!slotNonce) return { status: 'failed', reason: 'invalid-input' };
  const sanitized = sanitizeWebHast(hast as HastRoot, { policy: options.policy ?? 'strict', slotNonce });
  if (sanitized.failure) return { status: 'failed', reason: sanitized.failure };

  try {
    const node = toJsxRuntime(sanitized.tree, {
      Fragment,
      jsx,
      jsxs,
      // The GitHub Alerts adapter is composed AFTER the caller's map on
      // purpose: the callout DOM is this module's own contract (the page
      // view and the editor preview must not be able to drift apart on
      // it), and no caller overrides `aside` today.
      components: { ...options.components, aside: CrowiAlert },
      // `passNode: false` — otherwise every component receives a `node`
      // prop that React stringifies onto the DOM. data-* attrs still
      // flow through via the rest props bag.
      passNode: false,
    });
    return { status: 'ok', node };
  } catch {
    return { status: 'failed', reason: 'parse-failed' };
  }
}

/** Compatibility wrapper: the node on success, `null` for a missing or failed render. */
export function renderMdastToReactNode(renderedAst: unknown, options: RenderMdastOptions): ReactNode {
  const result = renderMdastToReactResult(renderedAst, options);
  return result.status === 'ok' ? result.node : null;
}
