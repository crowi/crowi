import sharp from 'sharp';

/**
 * Server-side SVG → PNG rasterization for the `crowiDiagram` structured
 * sidecar (RFC-0023 §10).
 *
 * WHY the sidecar is a PNG while the html branch keeps the SVG: native
 * clients rasterize the sidecar with their own SVG renderer, and the
 * iOS one (SwiftDraw) fails on 6 of the 7 real Mermaid diagram families
 * — Mermaid's width-less `<rect class="background"/>`
 * (`missingAttribute("width")`, flowchart / class / state), d3's
 * implicit-`x1` axis `<line y2="-111"/>` (gantt), `fill="hsl(...)"`
 * (pie / ER, no `hsl()` in its colour parser) — and renders the one that
 * does parse (sequence) degraded, because its CSS selector model is
 * id/element/class only (Mermaid's descendant selectors never match),
 * `<marker>` is unimplemented (no arrowheads) and `dominant-baseline`
 * is parsed but not honoured (labels sit above their boxes). Server-side
 * rasterization moves that work to librsvg, which renders the SAME
 * sanitized bytes correctly, and hands the client a format it cannot
 * misinterpret. The web keeps the crisp, scalable SVG.
 *
 * Byte budget — the tightest cap is NOT the wire schema but the render
 * cache: `MongoCacheStorage.setOrReject` strips `result.structured`
 * (writing an html-only entry, silently costing native clients the
 * sidecar) once `JSON.stringify(structured)` exceeds
 * `SINGLE_ENTRY_REJECT_BYTES` = 100KB, and base64 inflates the PNG by
 * 4/3, so the real ceiling on the binary is ≈76KB. The schema-level
 * caps sit above that: `AST_MAX_IMAGE_BASE64_CHARS` = 140,000 chars
 * (⇒ ≤105,000 bytes) and the §10 deep validation's decoded-size cap
 * (`sanitize-ast.ts`, also mirrored by the iOS decoder's
 * `maxDecodedImageBytes`) = 100KB. `MAX_PNG_OUTPUT_BYTES` therefore
 * mirrors the SVG branch's own 60KB shape (`encode-svg.ts`): 60KB
 * base64-encodes to ~80KB, ~20% under the 100KB strip threshold even
 * after the sidecar's ~200 bytes of JSON wrapper.
 */

/** Output cap on the PNG binary, before base64 (see the module doc comment's budget derivation). */
export const MAX_PNG_OUTPUT_BYTES = 60 * 1024;

/**
 * Rasterization densities to try, in order. 72 DPI is librsvg's 1:1
 * baseline (1 SVG user unit = 1 px), so 144 is the ~2x oversampling
 * that keeps a diagram crisp on a Retina display. Lower steps are the
 * retry ladder for diagrams whose 2x raster does not fit the byte cap
 * (or the wire's dimension bounds) — a slightly softer diagram beats no
 * sidecar at all. Exhausting the ladder falls back to html-only.
 */
export const RASTER_DENSITY_LADDER: readonly number[] = [144, 108, 72];

/** librsvg's 1:1 baseline: at this density one SVG user unit rasterizes to one pixel. */
export const BASE_RASTER_DENSITY = 72;

/**
 * Convert a raster pixel extent back to the diagram's LAYOUT size in SVG
 * user units — what the sidecar reports as its intrinsic `width`/`height`.
 *
 * The raster is oversampled (see the ladder above), so its pixel count is
 * NOT the size the diagram should occupy: a client draws the PNG
 * scaled-to-fit into a box of these units, which is what makes the extra
 * pixels show up as sharpness rather than as a diagram laid out twice as
 * large as on the web.
 */
export function toLayoutUnits(rasterExtent: number, density: number): number {
  return Math.max(1, Math.round(rasterExtent / (density / BASE_RASTER_DENSITY)));
}

/**
 * Peak raster budget, as a pixel count. Bounds what a single render can
 * allocate in the MAIN api process (16.7M px ≈ 67MB RGBA) — sharp
 * rejects the input before rasterizing rather than after, so a diagram
 * declaring a huge viewBox costs an exception, not the memory. Matches
 * the iOS raster budget's own 4096-px longest side
 * (`RenderedAstRasterBudget.maxPixelSize`), beyond which the client
 * downsamples anyway and the extra bytes are pure waste.
 */
const MAX_RASTER_PIXELS = 4096 * 4096;

/** `CrowiDimensionSchema`'s closed interval — a raster outside it could never reach a client. */
const MAX_WIRE_DIMENSION = 16_384;

export type RasterizePngResult = { ok: true; png: Buffer; width: number; height: number; density: number } | { ok: false };

/**
 * Rasterize a sanitized SVG to a PNG that fits the sidecar's caps.
 * Walks `RASTER_DENSITY_LADDER` from the crispest step down, returning
 * the first raster within `maxBytes` and the wire dimension bounds.
 *
 * Never throws: an SVG librsvg cannot parse, or one whose raster would
 * exceed the pixel budget, yields `{ ok: false }` — the caller then
 * emits html-only output (no `structured`), exactly like the other
 * sidecar-derivation failure paths. A raster failure must never degrade
 * the html the web renders, and must never surface as a
 * classification-B infra error.
 */
export async function rasterizeSvgToPng(svg: string, maxBytes: number = MAX_PNG_OUTPUT_BYTES): Promise<RasterizePngResult> {
  const input = Buffer.from(svg, 'utf8');
  for (const density of RASTER_DENSITY_LADDER) {
    let png: Buffer;
    let width: number;
    let height: number;
    try {
      // `resolveWithObject` hands back the output dimensions sharp
      // already knows, so the sidecar's REQUIRED intrinsic dimensions
      // come straight from the encoder rather than from a second parse
      // of the bytes we just produced (PlantUML's `png-dimensions.ts`
      // reads the IHDR chunk only because its PNG arrives over the wire
      // from a foreign server, with no metadata attached).
      const { data, info } = await sharp(input, { density, limitInputPixels: MAX_RASTER_PIXELS })
        .png({ compressionLevel: 9 })
        .toBuffer({ resolveWithObject: true });
      png = data;
      width = info.width;
      height = info.height;
    } catch {
      // Unparseable SVG, or a raster over the pixel budget. The latter
      // gets smaller at the next density, so keep walking the ladder.
      continue;
    }
    if (png.byteLength > maxBytes) continue;
    if (width < 1 || height < 1 || width > MAX_WIRE_DIMENSION || height > MAX_WIRE_DIMENSION) continue;
    return { ok: true, png, width, height, density };
  }
  return { ok: false };
}
