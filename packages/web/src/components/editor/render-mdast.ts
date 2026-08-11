'use client';

import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { toHast } from 'mdast-util-to-hast';
import type { State } from 'mdast-util-to-hast';
import { raw } from 'hast-util-raw';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import type { Element as HastElement, Nodes as HastNodes, Properties as HastProperties } from 'hast';
import type { ReactNode } from 'react';
import { CrowiAlert, type CrowiAlertVariant, isCrowiAlertVariant } from './crowi-alert';
import { isKnownTag } from './known-tags';

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
  if (typeof variant === 'string') properties['data-crowi-alert-variant'] = variant;
  if (isCrowiAlertVariant(variant)) properties.className = ['crowi-alert', `crowi-alert-${variant}`];

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

// Leading tag-name of a raw-HTML chunk: `<thing …>` / `</thing>` /
// `<thing/>`. Allows `:` so namespaced paste junk (`<o:p>`) is caught.
// `<!-- … -->` / `<!doctype>` start with `<!`, never match, and pass
// through to `raw()` unchanged.
const RAW_LEADING_TAG_RE = /^\s*<\/?\s*([a-zA-Z][a-zA-Z0-9:_-]*)/;

/**
 * Escape raw-HTML chunks whose tag is one no browser recognises so they
 * render as the *literal text the user typed* instead of vanishing.
 *
 * A page body can contain inline HTML the markdown parser hands through
 * verbatim — a documentation placeholder like `<thing>` (`shows "No
 * <thing> yet" tooltip`), or namespaced junk pasted from Word (`<o:p>`).
 * Without this, `mdast-util-to-hast` + `raw()` turn `<thing>` into an
 * empty unknown DOM element: it both disappears from the output *and*
 * makes React log "The tag <thing> is unrecognized in this browser…".
 *
 * We mirror what a documentation author expects (and what the source
 * editor shows): the text stays visible. Converting the `raw` node to a
 * `text` node makes the later `raw()` serialise it with `<`/`>` escaped,
 * so `<thing>` survives as the four-plus characters rather than a tag.
 *
 * Must run BEFORE `raw()` — that's when these are still flat `raw` nodes
 * carrying their original source string. Known HTML/SVG tags and custom
 * elements (`foo-bar`) are left as `raw` so `raw()` parses them as real
 * markup — including shiki's `<pre class="shiki">` highlight blocks.
 */
export function escapeUnknownRawHtml(tree: HastLike): void {
  if (!tree.children) return;
  for (const child of tree.children) {
    if (child.children) escapeUnknownRawHtml(child);
    if (child.type === 'raw' && typeof child.value === 'string') {
      const tag = RAW_LEADING_TAG_RE.exec(child.value)?.[1];
      if (tag && !isKnownTag(tag)) {
        // Demote to text — `raw()` will HTML-escape it, so the tag shows
        // verbatim instead of being parsed into an unknown element.
        child.type = 'text';
      }
    }
  }
}

/**
 * Safety net for unknown elements that slipped past
 * {@link escapeUnknownRawHtml} — e.g. an unknown tag *nested inside* a
 * block of recognised raw HTML, which `raw()` parses as one unit. Drops
 * the element but keeps its children so no React unknown-tag warning is
 * left behind. Runs AFTER `raw()`, when such chunks have become real
 * hast elements with a `tagName`. Custom elements (`foo-bar`) pass
 * through untouched.
 */
export function stripUnknownElements(tree: HastLike): void {
  if (!tree.children) return;
  const out: HastLike[] = [];
  for (const child of tree.children) {
    if (child.children) stripUnknownElements(child);
    if (child.type === 'element' && typeof child.tagName === 'string' && !isKnownTag(child.tagName)) {
      // Unwrap: keep the (already-cleaned) children in place of the node.
      if (child.children) out.push(...child.children);
      continue;
    }
    out.push(child);
  }
  tree.children = out;
}

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
}

/**
 * Convert a server-emitted mdast tree to a React node, running the
 * same `toHast → raw → toJsxRuntime` pipeline the show page uses.
 *
 * Why share this with the preview: the show page's renderer is the
 * single source of truth for "what this body looks like". Duplicating
 * the conversion on the preview side risks drift (e.g. different
 * shiki escape behaviour for HTML fences). Going through one helper
 * means edit preview and page show are byte-identical for the same
 * input.
 *
 * `allowDangerousHtml: true` is required because shiki-highlighted
 * fences arrive as `html` mdast nodes carrying `<pre class="shiki">…`
 * markup; `mdast-util-to-hast` turns them into `raw` hast nodes which
 * `hast-util-to-jsx-runtime` ignores unless we let `hast-util-raw`
 * parse them into real elements first.
 */
export function renderMdastToReactNode(renderedAst: unknown, options: RenderMdastOptions): ReactNode {
  if (!renderedAst) return null;
  const hast = toHast(renderedAst as Parameters<typeof toHast>[0], {
    allowDangerousHtml: true,
    // `mdast-util-to-hast`'s `Handlers` type is keyed by the STANDARD
    // mdast type union, so a Crowi-owned type needs a cast here — same
    // shape-escape as the `components` cast at both `renderMdastToReactNode`
    // call sites.
    handlers: { crowiFrontmatter: crowiFrontmatterHandler, crowiAlert: crowiAlertHandler } as unknown as NonNullable<Parameters<typeof toHast>[1]>['handlers'],
  });
  if (!hast) return null;
  if (options.sectionWrap) {
    // Section wrap MUST run before `raw()` so the walker only sees the
    // shallow mdast-derived top-level tree — `raw` expands shiki output
    // into hundreds of nodes per highlighted block and walking those
    // is wasted work.
    wrapSections(hast as HastLike);
  }
  // Demote unrecognised raw-HTML tags (e.g. a literal `<thing>` typed in
  // prose) to text BEFORE `raw()` parses them, so they render as the
  // verbatim text the author typed instead of vanishing into an empty
  // unknown DOM element (which also makes React warn).
  escapeUnknownRawHtml(hast as HastLike);
  const parsed = raw(hast as HastNodes);
  // Safety net: drop any unknown element that survived (unknown tag
  // nested inside an otherwise-recognised raw-HTML block), keeping its
  // children so no React unknown-tag warning is left behind.
  stripUnknownElements(parsed as HastLike);
  return toJsxRuntime(parsed, {
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
}
