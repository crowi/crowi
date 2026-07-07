import type { Image, Paragraph, PhrasingContent, Text } from 'mdast';
import type { Position } from 'unist';
import type { UnifiedTransformPlugin } from './headings';

/**
 * Core renderer transform — RFC-0015 image display attributes.
 *
 * Detects a Pandoc-style `{width= height= align= float=}` attribute
 * block immediately following a Markdown image (`![alt](url){...}`),
 * allow-list-validates the four supported keys, and emits the
 * re-validated values as `data-crowi-image-*` properties.
 *
 * Two outcomes depending on the **standalone predicate** (RFC §6.3 —
 * decided by trailing text / other inline siblings, NOT by which
 * attributes are present):
 *   - **standalone** (the image is the paragraph's only meaningful
 *     content once the attribute block is consumed): the containing
 *     `paragraph` is replaced with a synthesized `crowiFigure` node
 *     carrying the `crowi-figure` marker class + `align`/`float`
 *     `data-*` (width/height stay on the inner `image` node — layer
 *     split, RFC §6.3/§6.4).
 *   - **inline** (trailing text or another inline sibling remains):
 *     the `image` node is kept in place with only `width`/`height`
 *     applied; `align`/`float` are discarded entirely (RFC §6.4 —
 *     block placement / text-wrap has no coherent inline meaning).
 *
 * Security note: this transform only decides what gets emitted from
 * **Markdown-authored** `{...}` blocks. The `data-crowi-image-*` names
 * it emits are NOT a trust boundary by themselves — the web renderer
 * re-validates every `data-crowi-image-*` value it encounters
 * (including ones forged via raw HTML) through the same value-based
 * rules before deriving any style/class (RFC §6.3/§9). See
 * `packages/web/src/components/editor/image-display.ts`.
 *
 * Registration: inserted directly after `makeRemarkHeadings` and
 * before `remarkWikiLinks` in `buildCorePlugins` (`core/index.ts`) so
 * the `{...}` text is still intact (wikilinks/mentions split text
 * nodes on their own patterns and would otherwise interleave with —
 * or accidentally match inside — an attribute block).
 */

/** Allow-listed display attributes, already re-validated (never raw user text beyond the numeric/enum value itself). */
interface ScannedAttrs {
  /** `<number>%` in `1..100`, or `<number>px` in `1..4096` (closed intervals). Re-emitted verbatim (e.g. `"60%"`). */
  width?: string;
  height?: string;
  align?: 'left' | 'center' | 'right';
  float?: 'left' | 'right';
}

/**
 * Synthesized standalone-image wrapper — RFC §D9's option (a), resolved
 * (open question #1 in the spec): a `hName`-only transport, WITHOUT
 * `hChildren`. This is a deliberate, verified choice, not a partial
 * implementation of the RFC's "`hName`/`hChildren`" phrasing — read on
 * before "fixing" this to add `hChildren`.
 *
 * `mdast-util-to-hast`'s documented behaviour for an unknown node type
 * (one with no registered handler — `crowiFigure` has none) is (from
 * its readme, "Unknown nodes" section): *"otherwise, create a `<div>`
 * element (which could be changed with `data.hName`), **with its
 * children mapped from mdast to hast as well**"*. Concretely
 * (`mdast-util-to-hast`'s `defaultUnknownHandler` in `lib/state.js`):
 * it builds `{ tagName: 'div', children: state.all(node) }` — i.e. it
 * already recurses this node's real mdast `children` (our inner
 * `image`, a genuine mdast node with its own registered handler) through
 * the NORMAL conversion pipeline — and only THEN does `applyData`
 * rename the tag to `data.hName` ('figure') and merge
 * `data.hProperties`. `hChildren` is a SEPARATE, opt-in override
 * (`applyData` only replaces `result.children` when `hChildren` is
 * set) for cases that need to hand `toHast` pre-built hast nodes
 * instead of mdast ones (e.g. `remark-shiki`-style external highlighting
 * output) — this transform has no such need: the inner `image` node
 * IS a real mdast node and already round-trips correctly through its
 * own standard handler, `data-crowi-image-*` `hProperties` included.
 * Setting `hChildren` here would mean hand-constructing a hast `<img>`
 * element ourselves (duplicating `mdast-util-to-hast`'s own `image`
 * handler — src/alt/title/`hProperties` merging — on the API side,
 * which doesn't otherwise depend on hast types), for strictly
 * equivalent output. Verified end-to-end by `image-attrs.test.ts`'s
 * toHast-output case (AC-A12): `<figure>` + inner `<img>` with
 * src/alt/`data-crowi-image-*` all present.
 *
 * Also uses `data.hProperties` (the same `mdast-util-to-hast`
 * "unknown node" convention as `headings.ts`'s `hProperties.id` and
 * `wikilinks.ts`'s `hProperties.className`) for the marker
 * class/align/float.
 *
 * Deliberately NOT registered as a real mdast `RootContentMap` /
 * `BlockContentMap` member (no `declare module 'mdast'` augmentation):
 * the generic tree walker below (mirroring `wikilinks.ts` /
 * `mentions.ts`) types node children loosely as `unknown[]`, so
 * inserting this shape needs no global type-system change — keeping
 * the diff scoped to this file.
 */
export interface ImageFigureNode {
  type: 'crowiFigure';
  /** Always exactly the (possibly attribute-stamped) source image node — the figure never inherits its own `src`/`alt` (RFC §6.3). */
  children: [Image];
  data: {
    hName: 'figure';
    /** `className` + optional `data-crowi-image-align`/`-float`. Never `width`/`height` — those stay on the inner `image` (layer split, RFC §6.3/§6.4). */
    hProperties: Record<string, string>;
  };
  /** Copied from the source paragraph so scroll-sync (`data-source-line`, keyed off top-level `position.start.line`) survives the replacement (RFC §6.3 — regression-critical). */
  position?: Position;
}

// Image → attribute-block prefix: 0+ ASCII space/tab, OR exactly one
// soft line break followed by 0+ space/tab, then the opening brace.
// Anything else (2+ soft breaks, non-whitespace text, no `{` at all)
// leaves the text node untouched — matched at index 0 only (`^`), so
// checking it costs a handful of character comparisons regardless of
// how long the following text is.
const PREFIX_RE = /^(?:[ \t]*|\n[ \t]*)\{/;

// Bounded linear scan for the closing `}`: mirrors the bounded-regex
// style of `wikilinks.ts` (`{1,256}`) / `mentions.ts` (`{1,64}`) but as
// an explicit window rather than a capture-group cap, since the body
// itself isn't matched by one contiguous character class. A stray
// unterminated `{` followed by tens of thousands of characters costs
// at most this many character comparisons (`String#indexOf` over a
// bounded slice), never a scan of the whole remaining document —
// this is what keeps AC-A10 (huge malformed `{...`) O(1)-ish per
// candidate instead of O(document length).
const MAX_ATTR_BODY_LEN = 1024;

const ALIGN_VALUES = new Set(['left', 'center', 'right']);
const FLOAT_VALUES = new Set(['left', 'right']);

// `<number>(%|px)`. Decimal widths (`12.5%`) are accepted; the DROP
// range check below is what actually enforces the RFC §5/§9 bounds.
const SIZE_RE = /^(\d+(?:\.\d+)?)(%|px)$/;

/**
 * Validate a `width=`/`height=` value against the canonical DROP rule
 * (RFC §5/§9 — duplicated intentionally in the web helper, kept in
 * lockstep): `%` must be in `1..100`, `px` must be in `1..4096`, both
 * closed intervals. Out-of-range, non-numeric, or unit-less values are
 * DROPPED (return `undefined`) — never clamped/capped.
 */
function validateSize(value: string): string | undefined {
  const match = SIZE_RE.exec(value);
  if (!match) return undefined;
  const num = Number(match[1]);
  if (!Number.isFinite(num)) return undefined;
  const max = match[2] === '%' ? 100 : 4096;
  if (num < 1 || num > max) return undefined;
  return value;
}

/**
 * Parse the (already shape-validated — no newline, no leading/trailing
 * whitespace) attribute-block body into allow-listed attrs. Unknown
 * keys and malformed tokens (no `=`, empty key/value) are silently
 * ignored — v1 grammar never treats an unrecognised token as a parse
 * error (RFC §5: "unknown key は無視"). When the same key repeats,
 * the last VALID occurrence wins; an invalid repeat does not clear an
 * earlier valid one (an edge case with no dedicated AC — chosen for
 * determinism, not tested to the letter).
 */
function parseAttrBody(body: string): ScannedAttrs {
  const attrs: ScannedAttrs = {};
  if (body === '') return attrs;
  for (const token of body.split(/\s+/)) {
    const eq = token.indexOf('=');
    if (eq <= 0) continue;
    const key = token.slice(0, eq).toLowerCase();
    const value = token.slice(eq + 1);
    if (value === '') continue;
    switch (key) {
      case 'width': {
        const validated = validateSize(value);
        if (validated) attrs.width = validated;
        break;
      }
      case 'height': {
        const validated = validateSize(value);
        if (validated) attrs.height = validated;
        break;
      }
      case 'align': {
        if (ALIGN_VALUES.has(value)) attrs.align = value as 'left' | 'center' | 'right';
        break;
      }
      case 'float': {
        if (FLOAT_VALUES.has(value)) attrs.float = value as 'left' | 'right';
        break;
      }
      default:
        break;
    }
  }
  return attrs;
}

interface ScanResult {
  attrs: ScannedAttrs;
  /** Number of characters to remove from the START of the text node's value (whitespace prefix + `{...}` inclusive). */
  consumedLength: number;
}

/**
 * Look for a recognised attribute block at the very start of `value`
 * (the text node immediately following an image). Returns `null` — the
 * text is left byte-identical — when:
 *   - there's no allowed whitespace-prefix + `{` at all (AC-A8),
 *   - the block is unterminated / the closing `}` doesn't appear
 *     within the bounded scan window (AC-A10),
 *   - the body spans a newline (multi-line blocks aren't v1 grammar),
 *   - the body has leading/trailing whitespace (`{ width=60%}` is an
 *     unrecognised block per RFC §5 grammar, not a lenient-trimmed one
 *     — AC-A8),
 *   - every parsed attribute was unknown-key / out-of-range / invalid
 *     (AC-A5 — zero valid attrs means "nothing recognized here",
 *     which must leave the source text completely untouched, not
 *     silently strip a block the author will never see again).
 */
function scanAttrsFromText(value: string): ScanResult | null {
  const prefixMatch = PREFIX_RE.exec(value);
  if (!prefixMatch) return null;
  const bodyStart = prefixMatch[0].length;
  const windowEnd = Math.min(value.length, bodyStart + MAX_ATTR_BODY_LEN);
  const relClose = value.slice(bodyStart, windowEnd).indexOf('}');
  if (relClose === -1) return null;
  const closeIdx = bodyStart + relClose;
  const body = value.slice(bodyStart, closeIdx);
  if (body.includes('\n')) return null;
  if (body !== body.trim()) return null;
  const attrs = parseAttrBody(body);
  if (Object.keys(attrs).length === 0) return null;
  return { attrs, consumedLength: closeIdx + 1 };
}

/** True for a `text` node whose value is empty or whitespace-only (tabs/spaces/newlines). */
function isWhitespaceOnlyText(node: PhrasingContent): boolean {
  return node.type === 'text' && (node as Text).value.trim() === '';
}

/** Stamp validated width/height onto the image's `data.hProperties` (additive — never clears an unrelated existing key). */
function applyImageSizeProps(image: Image, attrs: ScannedAttrs): void {
  const hProps: Record<string, string> = {};
  if (attrs.width) hProps['data-crowi-image-width'] = attrs.width;
  if (attrs.height) hProps['data-crowi-image-height'] = attrs.height;
  if (Object.keys(hProps).length === 0) return;
  const data = (image.data ?? (image.data = {})) as { hProperties?: Record<string, unknown> };
  data.hProperties = { ...(data.hProperties ?? {}), ...hProps };
}

/**
 * Process one `paragraph`'s direct children: find an `image` node
 * immediately followed by a `text` node carrying a recognised
 * attribute block, apply width/height to that image, and consume the
 * matched substring from the text node (partial preservation — only
 * the matched prefix is removed, AC-A9). Only DIRECT paragraph
 * children are inspected (not images nested inside e.g. a link or
 * emphasis run) — out of RFC scope, no AC covers it.
 *
 * Returns a replacement `crowiFigure` node when the paragraph turns
 * out to be standalone (RFC §6.3 standalone predicate — exactly one
 * image total in the paragraph, no other non-whitespace content),
 * else `null` (paragraph mutated in place — width/height applied,
 * consumed text trimmed/removed — but not replaced; `align`/`float`
 * are simply never read again once the inline branch is taken, so
 * they are effectively discarded per RFC §6.4/§D10).
 */
function processParagraph(paragraph: Paragraph): ImageFigureNode | null {
  const children = paragraph.children;
  let imageCount = 0;
  let matchedImage: Image | null = null;
  let matchedAttrs: ScannedAttrs | null = null;

  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (node.type !== 'image') continue;
    imageCount++;

    const next = children[i + 1];
    if (!next || next.type !== 'text') continue;
    const scanned = scanAttrsFromText((next as Text).value);
    if (!scanned) continue;

    applyImageSizeProps(node, scanned.attrs);

    const remaining = (next as Text).value.slice(scanned.consumedLength);
    if (remaining === '') {
      children.splice(i + 1, 1);
    } else {
      (next as Text).value = remaining;
    }

    matchedImage = node;
    matchedAttrs = scanned.attrs;
  }

  // Nothing in this paragraph carried a recognised attribute block —
  // complete no-op, byte-identical to pre-Phase-8 behaviour (AC-X1).
  if (!matchedImage || !matchedAttrs) return null;

  // Standalone predicate (RFC §6.3): exactly one image in the whole
  // paragraph, and every other sibling (if any) is whitespace-only
  // text. Deliberately independent of WHICH attrs were found — a
  // width-only standalone image still becomes a figure (AC-A1/AC-A6).
  const standalone = imageCount === 1 && children.every((c) => c === matchedImage || isWhitespaceOnlyText(c));
  if (!standalone) return null;

  const figureHProperties: Record<string, string> = { className: 'crowi-figure' };
  if (matchedAttrs.align) figureHProperties['data-crowi-image-align'] = matchedAttrs.align;
  if (matchedAttrs.float) figureHProperties['data-crowi-image-float'] = matchedAttrs.float;

  const figure: ImageFigureNode = {
    type: 'crowiFigure',
    children: [matchedImage],
    data: { hName: 'figure', hProperties: figureHProperties },
  };
  if (paragraph.position) figure.position = paragraph.position;
  return figure;
}

/**
 * `remarkImageAttrs` doesn't need the shared `metadata` bag (nothing to
 * aggregate across the document — contrast `remarkCodeBlockLanguages`),
 * but keeps the standard `UnifiedTransformPlugin` factory shape so it
 * slots into `buildCorePlugins` identically to every other core
 * transform.
 */
export const remarkImageAttrs: UnifiedTransformPlugin = (_metadata) => (tree) => {
  walk(tree as unknown as { type?: string; children?: unknown[] });

  function walk(node: { type?: string; children?: unknown[] }): void {
    if (node.type === 'code' || node.type === 'inlineCode') return;
    if (!Array.isArray(node.children)) return;
    const children = node.children as Array<{ type?: string; children?: unknown[] }>;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.type === 'paragraph') {
        const figure = processParagraph(child as unknown as Paragraph);
        if (figure) {
          children[i] = figure as unknown as { type?: string; children?: unknown[] };
        }
        // A paragraph's own children are phrasing content — it cannot
        // contain a nested paragraph, so no further recursion here.
        continue;
      }
      walk(child);
    }
  }
};
