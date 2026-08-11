import sharp from 'sharp';
import { BASE_RASTER_DENSITY, MAX_PNG_OUTPUT_BYTES, RASTER_DENSITY_LADDER, rasterizeSvgToPng, toLayoutUnits } from './rasterize-png';

/**
 * Unit coverage for the sidecar rasterizer, independent of Mermaid
 * itself (no child-process pool here — these are synthetic SVGs, so the
 * density ladder and the failure contract can be exercised at their
 * boundaries instead of at whatever size a real diagram happens to be).
 */

/** A viewBox-sized SVG with enough non-flat content that its PNG does not compress to nothing. */
function svgOfSize(width: number, height: number): string {
  const stripes = Array.from(
    { length: 40 },
    (_, i) => `<circle cx="${(i * 37) % width}" cy="${(i * 53) % height}" r="${8 + (i % 17)}" fill="hsl(${i * 9}, 70%, 50%)"/>`,
  ).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#fff"/>${stripes}</svg>`;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('rasterizeSvgToPng', () => {
  it("rasterizes at the crispest ladder step (~2x) and reports the PNG's own pixel dimensions", async () => {
    const result = await rasterizeSvgToPng(svgOfSize(200, 100));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.density).toBe(RASTER_DENSITY_LADDER[0]);
    // 72 DPI is librsvg's 1:1 baseline, so the first ladder step is a 2x raster.
    expect(result.width).toBe(400);
    expect(result.height).toBe(200);
    expect(result.png.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)).toBe(true);
    const meta = await sharp(result.png).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(result.width);
    expect(meta.height).toBe(result.height);
  });

  it('steps the density down (instead of giving up) when the 2x raster does not fit the byte cap', async () => {
    const svg = svgOfSize(200, 100);
    const full = await rasterizeSvgToPng(svg);
    expect(full.ok).toBe(true);
    if (!full.ok) return;

    // A cap just under what the crispest step produced — the next
    // ladder step must be tried, and its output must actually fit.
    const stepped = await rasterizeSvgToPng(svg, full.png.byteLength - 1);
    expect(stepped.ok).toBe(true);
    if (!stepped.ok) return;
    expect(stepped.density).toBeLessThan(full.density);
    expect(RASTER_DENSITY_LADDER).toContain(stepped.density);
    expect(stepped.png.byteLength).toBeLessThan(full.png.byteLength);
    expect(stepped.width).toBeLessThan(full.width);
  });

  it('falls back to `ok: false` (html-only, never an oversized sidecar) once the whole ladder is over the cap', async () => {
    const result = await rasterizeSvgToPng(svgOfSize(200, 100), 64);
    expect(result.ok).toBe(false);
  });

  it('never throws on an SVG librsvg cannot parse — the caller degrades to html-only', async () => {
    await expect(rasterizeSvgToPng('<svg not really an svg <<<')).resolves.toEqual({ ok: false });
  });

  it('refuses a raster over the in-process pixel budget rather than allocating it', async () => {
    // 20000×20000 user units is ≈400M px even at the 1:1 ladder floor —
    // over the 4096² budget at every density, so every step is rejected
    // before rasterization and the whole call degrades.
    const result = await rasterizeSvgToPng(svgOfSize(20_000, 20_000));
    expect(result.ok).toBe(false);
  });

  it('keeps its default cap in the shape the render cache needs (base64 + JSON wrapper under the 100KB strip threshold)', () => {
    const base64Chars = Math.ceil(MAX_PNG_OUTPUT_BYTES / 3) * 4;
    // The sidecar's JSON wrapper (type/kind/diagramType/alt/mediaType/
    // dimensions) is ~200 bytes; leave an order of magnitude of slack.
    expect(base64Chars + 2048).toBeLessThan(100 * 1024);
    expect(base64Chars).toBeLessThan(140_000); // AST_MAX_IMAGE_BASE64_CHARS
  });
});

describe('toLayoutUnits — the sidecar-dimension fallback', () => {
  // `index.ts` prefers the SVG's own viewBox for the sidecar's
  // dimensions, because that is the exact number the html hands the
  // browser and parity between the two clients is the whole point. This
  // function is the fallback for the case where viewBox extraction
  // fails: it must still yield LAYOUT units, so a native client lays the
  // diagram out at web's size rather than at the oversampled raster's.
  it('divides a raster extent by its own oversampling factor', () => {
    expect(toLayoutUnits(560, 144)).toBe(280);
    expect(toLayoutUnits(818, 144)).toBe(409);
    expect(toLayoutUnits(420, 108)).toBe(280);
  });

  it('is the identity at the ladder floor, where one user unit is one pixel', () => {
    expect(BASE_RASTER_DENSITY).toBe(72);
    expect(toLayoutUnits(280, BASE_RASTER_DENSITY)).toBe(280);
    expect(RASTER_DENSITY_LADDER[RASTER_DENSITY_LADDER.length - 1]).toBe(BASE_RASTER_DENSITY);
  });

  it('never reports a zero extent — a sub-unit diagram still needs a layout box', () => {
    // The wire schema's closed interval starts at 1; rounding a 1px
    // raster down to 0 would make an otherwise-fine sidecar unsendable.
    expect(toLayoutUnits(1, 144)).toBe(1);
  });
});
