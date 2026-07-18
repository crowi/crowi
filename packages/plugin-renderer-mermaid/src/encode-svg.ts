/**
 * spec §1 / §6 — output size cap (60KB, sanitized SVG before base64) +
 * base64 `data:` URL assembly. 60KB base64-encodes to roughly 80KB
 * (4/3 expansion), leaving a comfortable margin under the shared render
 * cache's 100KB per-entry reject threshold
 * (`packages/api/src/renderer/cache/mongodb-cache.ts`) even after the
 * few hundred bytes of wrapper HTML `index.ts` adds on top.
 */

export const MAX_SVG_OUTPUT_BYTES = 60 * 1024;

export type EncodeSvgResult = { ok: true; dataUrl: string } | { ok: false };

export function encodeSvgToDataUrl(svg: string, maxBytes: number = MAX_SVG_OUTPUT_BYTES): EncodeSvgResult {
  const bytes = Buffer.byteLength(svg, 'utf8');
  if (bytes > maxBytes) return { ok: false };
  const base64 = Buffer.from(svg, 'utf8').toString('base64');
  return { ok: true, dataUrl: `data:image/svg+xml;base64,${base64}` };
}
