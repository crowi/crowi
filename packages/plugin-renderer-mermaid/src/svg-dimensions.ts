/**
 * Parses a root `<svg>` element's `viewBox` (`minX minY width height`) to
 * derive HTML `width`/`height` attributes for the outer `<img>` this
 * renderer emits (`index.ts`). Mermaid's own SVG output declares
 * `width="100%"` with no absolute `height` — a percentage width gives an
 * `<img>` no resolvable intrinsic size, so inside `RendererPresentation`'s
 * `inline-block` wrapper (whose own width is itself `auto`, sized from its
 * content) the two collapse to 0×0: the wrapper waits on the image for a
 * width, the image waits on the wrapper. Explicit `width`/`height`
 * attributes on the `<img>` tag are a standard, independent intrinsic-size
 * source (the same mechanism browsers use for CLS-safe image loading) that
 * breaks the circularity; CSS `max-width: 100%; height: auto` then scales
 * the result proportionally. This does not require decoding the `data:`
 * payload at all — it only reads attributes already visible on the
 * sanitized SVG source string passed in.
 */
/**
 * Upper bound for an accepted `width`/`height` (spec-independent — no real
 * Mermaid diagram lays out anywhere near this many pixels). Guards against
 * an implausible value round-tripping through `Number()` and re-stringifying
 * in exponential notation (`1e+21`) when interpolated into the `<img>`
 * tag's `width="${...}"` attribute — HTML doesn't accept that form, so an
 * unbounded value could silently degrade back to the no-intrinsic-size
 * failure mode this module exists to fix.
 */
const MAX_DIMENSION_PX = 1_000_000;

export function extractSvgDimensions(svg: string): { width: number; height: number } | null {
  const match = /\bviewBox\s*=\s*["']\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)\s*["']/.exec(svg);
  if (!match) return null;
  const width = Math.round(Number(match[3]));
  const height = Math.round(Number(match[4]));
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0 || width > MAX_DIMENSION_PX || height > MAX_DIMENSION_PX) return null;
  return { width, height };
}
