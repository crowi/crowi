import { pageBasename } from './page-path';

/** Punctuation a filename cannot contain: path separators plus the set
 * Windows forbids. Control characters (code points 0-31) are handled
 * separately in {@link isForbiddenChar} rather than spelled out here, to
 * avoid an error-prone literal control-character range in a regex class. */
const FORBIDDEN_PUNCTUATION = new Set(['\\', '/', ':', '*', '?', '"', '<', '>', '|']);

function isForbiddenChar(char: string): boolean {
  return FORBIDDEN_PUNCTUATION.has(char) || char.charCodeAt(0) <= 0x1f;
}

/** Leading/trailing whitespace and dots — Windows cannot handle a filename
 * ending in either. */
const EDGE_WHITESPACE_OR_DOT_RE = /^[\s.]+|[\s.]+$/g;

/** Most filesystems cap filenames at 255 bytes; a multi-byte (e.g. Japanese,
 * up to 3 bytes/char in UTF-8) name needs a character-count limit well under
 * that to stay safe, so the base name is capped at 100 characters. */
const MAX_BASE_NAME_LENGTH = 100;

/**
 * Derives a `.md` download filename from a wiki page path: the last
 * non-empty path segment, sanitized for filesystem safety, with Unicode
 * preserved as-is. Falls back to `fallback` (the page id) when the path
 * yields no usable segment.
 *
 *   /foo/bar   -> bar.md
 *   /foo/bar/  -> bar.md   (portal: trailing slash drops the empty segment)
 *   /          -> `${fallback}.md`
 */
export function toMarkdownFileName(path: string, fallback: string): string {
  const baseName = sanitizeBaseName(pageBasename(path));
  return `${baseName.length > 0 ? baseName : fallback}.md`;
}

function sanitizeBaseName(raw: string): string {
  const withoutForbiddenChars = Array.from(raw)
    .map((char) => (isForbiddenChar(char) ? '-' : char))
    .join('');
  const trimmed = withoutForbiddenChars.replace(EDGE_WHITESPACE_OR_DOT_RE, '');
  // `.slice` counts UTF-16 code units, which can split an astral character
  // (e.g. an emoji) into a lone surrogate; `Array.from` iterates by code
  // point instead, so the cut always lands on a character boundary.
  const truncated = Array.from(trimmed).slice(0, MAX_BASE_NAME_LENGTH).join('');
  // Truncation can re-expose a trailing space/dot that was interior to the
  // pre-truncation string; trim once more so the invariant holds regardless
  // of where the cut lands.
  return truncated.replace(EDGE_WHITESPACE_OR_DOT_RE, '');
}
