/**
 * RFC-0023 §10 — intrinsic-dimension derivation for the PNG output
 * branch's `crowiDiagram` sidecar. Reads the IHDR chunk directly: the
 * 8-byte PNG signature, then the first chunk's 4-byte length + 4-byte
 * type (`IHDR` is mandated to come first), then `width` / `height` as
 * 4-byte big-endian integers. A signature mismatch, wrong first-chunk
 * type or truncated buffer yields null (→ the renderer falls back to
 * html-only, no structured payload).
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** signature (8) + chunk length (4) + chunk type (4) + width (4) + height (4) */
const IHDR_MIN_BYTES = 8 + 4 + 4 + 4 + 4;

export function extractPngDimensions(png: Buffer): { width: number; height: number } | null {
  if (png.byteLength < IHDR_MIN_BYTES) return null;
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (png.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}
