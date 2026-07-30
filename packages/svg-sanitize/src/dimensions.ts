/**
 * Parses a root `<svg>` element's `viewBox` (`minX minY width height`) to
 * derive intrinsic pixel dimensions. Shared by
 * `@crowi/plugin-renderer-mermaid` (its original home — the `<img>`
 * `width`/`height` intrinsic-size fix) and, since RFC-0023,
 * `@crowi/plugin-renderer-plantuml`'s SVG sidecar path — both need the
 * same derivation and both already bundle this package, so it lives
 * here rather than being copied per plugin.
 *
 * Reads attributes off the sanitized SVG source string only — never
 * decodes any `data:` payload.
 */

/**
 * Upper bound for an accepted `width`/`height` (spec-independent — no real
 * diagram lays out anywhere near this many pixels). Guards against an
 * implausible value round-tripping through `Number()` and re-stringifying
 * in exponential notation (`1e+21`) when interpolated into an `<img>`
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
