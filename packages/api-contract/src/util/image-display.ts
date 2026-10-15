const SIZE_RE = /^(\d+(?:\.\d+)?)(%|px)$/;

export const IMAGE_ALIGN_VALUES: ReadonlySet<string> = new Set(['left', 'center', 'right']);
export const IMAGE_FLOAT_VALUES: ReadonlySet<string> = new Set(['left', 'right']);

/**
 * Validates an image `width` / `height` value: `%` must be in `1..100` and
 * `px` in `1..4096`, both closed. Out-of-range, non-numeric or unit-less
 * values are dropped (`undefined`), never clamped.
 */
export function validateImageSize(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = SIZE_RE.exec(value);
  if (!match) return undefined;
  const num = Number(match[1]);
  if (!Number.isFinite(num)) return undefined;
  const max = match[2] === '%' ? 100 : 4096;
  if (num < 1 || num > max) return undefined;
  return value;
}
