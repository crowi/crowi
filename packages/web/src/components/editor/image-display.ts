import type { CSSProperties } from 'react';

/**
 * RFC-0015 image display attributes — the SINGLE shared helper that
 * re-validates `data-crowi-image-*` transport properties by VALUE
 * before deriving any style/class. Consumed by `page-content.tsx`
 * (plain img + attachment img), `MarkdownPreview.tsx` (plain img), and
 * `InlineAttachmentLink` (attachment img variant) — every image/figure
 * render path in the app funnels through this module (AC-B1).
 *
 * **Security model (RFC §D4/§D5/§D6 — read before touching this
 * file)**: `data-crowi-image-*` is NOT a trust boundary by itself. The
 * web renderer allows raw HTML (`render-mdast.ts`'s `allowDangerousHtml`
 * + `hast-util-raw`), so an author can write
 * `<img data-crowi-image-align="center">` directly and it reaches the
 * SAME `img` component override as a transform-emitted one (both are
 * just `properties` on a hast element by the time `passNode: false`
 * hands us the rest-props bag — there is no way to tell them apart).
 * The only trust boundary is this module's per-render VALUE
 * re-validation: the exact same DROP rules as the API transform
 * (`packages/api/src/renderer/core/image-attrs.ts` — kept in lockstep
 * intentionally) are applied regardless of whether the value came from
 * the transform or was forged via raw HTML. A well-formed forged value
 * is indistinguishable from (and no more powerful than) a value the
 * author could have written as legitimate Markdown attrs — it is never
 * a way to inject arbitrary `style`/`class`/script.
 *
 * **Layer split (RFC §D5b)**: width/height apply ONLY to the `<img>` /
 * `InlineAttachmentLink` layer (`getImageDisplayStyle`); align/float
 * apply ONLY to the synthesized `<figure>` layer
 * (`getFigureLayoutClassName`). An `img` component override has no
 * node context (`passNode: false`) to know whether it sits inside a
 * standalone figure, so it must never apply block-level align/float —
 * only the figure (which only exists for a standalone image) does.
 *
 * **Raw-HTML scope is narrow (AC-X1/AC-B3)**: the only thing this
 * module does to a raw, unrelated `<img>`/`<figure>` is strip the 4
 * `data-crowi-image-*` keys so they never leak onto the DOM. Every
 * other prop (`style`, `class`, `width`, `height`, unrelated `data-*`)
 * passes through untouched — `mergeImageClassName`/`mergeImageStyle`
 * below are the MERGE half of that contract (folding a renderer-owned
 * base `className`/re-validated display `style` into whatever the
 * caller already had, never replacing it), so callers don't each
 * reinvent the same merge and risk dropping the incoming value.
 */

const WIDTH_KEBAB = 'data-crowi-image-width';
const WIDTH_CAMEL = 'dataCrowiImageWidth';
const HEIGHT_KEBAB = 'data-crowi-image-height';
const HEIGHT_CAMEL = 'dataCrowiImageHeight';
const ALIGN_KEBAB = 'data-crowi-image-align';
const ALIGN_CAMEL = 'dataCrowiImageAlign';
const FLOAT_KEBAB = 'data-crowi-image-float';
const FLOAT_CAMEL = 'dataCrowiImageFloat';

/**
 * Every transport key, both casings. `hast-util-to-jsx-runtime`
 * delivers unrecognised `data-*` properties to component overrides in
 * camelCase in the common case, but (mirroring the defensive read
 * already used for `data-source-line` in `page-content.tsx`'s
 * `TargetedSection`) some versions hand them through hyphenated
 * instead — read/strip both forms so neither leaks regardless of
 * library version.
 */
const TRANSPORT_KEYS = [WIDTH_KEBAB, WIDTH_CAMEL, HEIGHT_KEBAB, HEIGHT_CAMEL, ALIGN_KEBAB, ALIGN_CAMEL, FLOAT_KEBAB, FLOAT_CAMEL] as const;

function readTransportString(props: Record<string, unknown>, kebabKey: string, camelKey: string): string | undefined {
  const value = props[kebabKey] ?? props[camelKey];
  return typeof value === 'string' ? value : undefined;
}

// `<number>(%|px)`. Kept in lockstep with the API transform's
// `SIZE_RE` (`packages/api/src/renderer/core/image-attrs.ts`).
const SIZE_RE = /^(\d+(?:\.\d+)?)(%|px)$/;

/**
 * Re-validate a width/height value. MUST stay identical to the API
 * transform's `validateSize` (RFC §D3/§D5 — the "same DROP rule on
 * both sides" invariant): `%` in `1..100`, `px` in `1..4096`, both
 * closed intervals; anything else (non-numeric, unit-less, out of
 * range) is DROPPED, never clamped.
 */
function validateSize(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = SIZE_RE.exec(value);
  if (!match) return undefined;
  const num = Number(match[1]);
  if (!Number.isFinite(num)) return undefined;
  const max = match[2] === '%' ? 100 : 4096;
  if (num < 1 || num > max) return undefined;
  return value;
}

const ALIGN_VALUES = new Set(['left', 'center', 'right']);
const FLOAT_VALUES = new Set(['left', 'right']);

type Align = 'left' | 'center' | 'right';
type Float = 'left' | 'right';

function validateAlign(value: string | undefined): Align | undefined {
  return value !== undefined && ALIGN_VALUES.has(value) ? (value as Align) : undefined;
}

function validateFloat(value: string | undefined): Float | undefined {
  return value !== undefined && FLOAT_VALUES.has(value) ? (value as Float) : undefined;
}

/**
 * img-layer (RFC §D5b): re-validated width/height as an inline React
 * `style`. Callers MERGE this onto their own base style (never
 * replace it) so an unrelated existing style (e.g.
 * `InlineAttachmentLink`'s `cursor: 'zoom-in'`) survives. Returns `{}`
 * when neither value is present/valid — spreading an empty style
 * object is a no-op.
 *
 * Never reads align/float — those are figure-only (see
 * `getFigureLayoutClassName`).
 */
export function getImageDisplayStyle(props: Record<string, unknown>): CSSProperties {
  const width = validateSize(readTransportString(props, WIDTH_KEBAB, WIDTH_CAMEL));
  const height = validateSize(readTransportString(props, HEIGHT_KEBAB, HEIGHT_CAMEL));
  const style: CSSProperties = {};
  if (width) style.width = width;
  if (height) style.height = height;
  return style;
}

// Fixed, renderer-owned layout classes (RFC §D12) — CSS lives in
// `globals.css`. `float` wins over `align` when a standalone image
// specifies both (RFC §D3/§AC-A4) — layout is never both at once.
const ALIGN_CLASS: Record<Align, string> = {
  left: 'crowi-image-align-left',
  center: 'crowi-image-align-center',
  right: 'crowi-image-align-right',
};
const FLOAT_CLASS: Record<Float, string> = {
  left: 'crowi-image-float-left',
  right: 'crowi-image-float-right',
};

/**
 * figure-layer (RFC §D5b/§D6): re-validated align/float as ONE safe,
 * fixed layout class (or `''` when neither is valid). This is the
 * `getFigureLayoutClassName` half of the "forged-marker-safe" model —
 * see `hasFigureMarker`'s doc comment for the full security argument.
 * Never reads width/height — those are img-layer only.
 */
export function getFigureLayoutClassName(props: Record<string, unknown>): string {
  const float = validateFloat(readTransportString(props, FLOAT_KEBAB, FLOAT_CAMEL));
  if (float) return FLOAT_CLASS[float];
  const align = validateAlign(readTransportString(props, ALIGN_KEBAB, ALIGN_CAMEL));
  if (align) return ALIGN_CLASS[align];
  return '';
}

/**
 * True when `className` (string or array — `hast-util-to-jsx-runtime`
 * may deliver either) carries the `crowi-figure` marker.
 *
 * **The marker is forgeable and is NOT a trust/origin proof (RFC
 * §D6)**: raw HTML can write `<figure class="crowi-figure ...">` and
 * `hast-util-raw` parses it into a hast element with the same
 * `className`, indistinguishable from a transform-synthesized figure
 * by the time the `figure` component override sees it (`passNode:
 * false` — no node context). The marker only GATES whether the figure
 * override applies ITS OWN re-derived safe layout class
 * (`getFigureLayoutClassName`, built from re-validated
 * `data-crowi-image-align`/`-float` values only) — it never causes the
 * incoming raw `style`/`class` to be honoured. A forged marker with a
 * forged `data-crowi-image-align` therefore receives, at most, one of
 * the fixed CSS classes above: cosmetic layout the author could
 * already achieve by writing raw HTML, never script/style injection.
 */
export function hasFigureMarker(className: unknown): boolean {
  if (typeof className === 'string') return className.split(/\s+/).includes('crowi-figure');
  if (Array.isArray(className)) return className.some((c) => typeof c === 'string' && c === 'crowi-figure');
  return false;
}

/**
 * Strip all 4 `data-crowi-image-*` transport keys (both casings) from
 * a props bag so they never leak onto the final DOM element,
 * regardless of whether the caller ends up applying them (AC-B3). Only
 * these 4 keys are touched — every other prop passes through
 * unchanged, keyed by reference equality where possible.
 */
export function stripImageDisplayTransportProps<T extends Record<string, unknown>>(props: T): T {
  const rest: Record<string, unknown> = { ...props };
  for (const key of TRANSPORT_KEYS) delete rest[key];
  return rest as T;
}

/**
 * Merge a base, renderer-owned `className` with the incoming raw
 * `className` (string, or an array — `hast-util-to-jsx-runtime` may
 * deliver either) so an unrelated raw `<img>`'s/`<figure>`'s own
 * `class` attribute survives instead of being replaced (AC-B3
 * passthrough — this module's `className` handling never touches
 * anything beyond fold-in-the-4-keys). Mirrors `list-classnames.ts`'s
 * `mergeListClassName` merge algorithm; kept as a separate export here
 * (rather than imported from that unrelated list-styling module) so
 * every image/figure display-prop concern lives in this one shared
 * helper (AC-B1).
 */
export function mergeImageClassName(base: string, incoming: unknown): string {
  if (typeof incoming === 'string' && incoming.length > 0) return `${base} ${incoming}`;
  if (Array.isArray(incoming)) {
    const joined = incoming.filter((c): c is string => typeof c === 'string').join(' ');
    return joined ? `${base} ${joined}` : base;
  }
  return base;
}

/**
 * Merge an incoming raw `style` (by the time an `img`/`figure`
 * override sees it, `hast-util-to-jsx-runtime` has already parsed a
 * raw-HTML `style="..."` string into a `CSSProperties`-shaped object)
 * with the re-validated display style. The display style wins ONLY on
 * a literal key collision (e.g. an unrelated raw `style="width:10px"`
 * competing with a re-validated `data-crowi-image-width`) — that
 * collision is the entire point of the feature; every other raw style
 * property passes through untouched (AC-B3). Spreading `undefined` is
 * a no-op, so callers don't need to guard the no-raw-style case.
 */
export function mergeImageStyle(rawStyle: CSSProperties | undefined, displayStyle: CSSProperties): CSSProperties {
  return { ...rawStyle, ...displayStyle };
}
