/**
 * Lexical parser for the page references an artifact author writes in
 * `<a href>` / `<area href>`. Pure string handling — no DOM, window, web route
 * table or node built-in — so ingest (api) and the wiki page (web) share one
 * definition of what is a well-formed page link. Whether the parsed link may
 * be followed is a separate, web-side decision.
 */

export const ARTIFACT_LINK_MAX_LENGTH = 4096;

export type ParsedArtifactPageLink = Readonly<{
  absolute: boolean;
  /** Percent-decoded exactly once; `+` is left as is and `.` / `..` are kept. */
  segments: readonly string[];
  trailingSlash: boolean;
  /** Percent-decoded exactly once, or null when the href has no fragment. */
  fragment: string | null;
}>;

// C0 / DEL / C1 control characters.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Whether `value` holds a C0 / DEL / C1 control character or an unpaired UTF-16 surrogate. */
export function hasControlCharOrLoneSurrogate(value: string): boolean {
  return CONTROL_CHARS.test(value) || LONE_SURROGATE.test(value);
}

const SCHEME_LIKE_FIRST_SEGMENT = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const INVALID_ESCAPE = /%(?![0-9A-Fa-f]{2})/;
const ESCAPE_RUN = /(?:%[0-9A-Fa-f]{2})+/g;

/** Decodes each `%HH` run once; null for an invalid escape or invalid UTF-8. */
function decodeOnce(raw: string): string | null {
  if (INVALID_ESCAPE.test(raw)) return null;
  try {
    return raw.replace(ESCAPE_RUN, (run) => decodeURIComponent(run));
  } catch {
    return null;
  }
}

function decodeSegment(raw: string): string | null {
  const decoded = decodeOnce(raw);
  if (decoded === null) return null;
  if (/[/\\?#]/.test(decoded) || hasControlCharOrLoneSurrogate(decoded)) return null;
  return decoded;
}

function decodeFragment(raw: string): string | null {
  const decoded = decodeOnce(raw);
  if (decoded === null) return null;
  if (decoded.includes('\\') || decoded.includes('%') || hasControlCharOrLoneSurrogate(decoded)) return null;
  return decoded;
}

export function parseArtifactPageLink(rawHref: string): ParsedArtifactPageLink | null {
  // The length gate runs before any split / decode so cost stays linear in a bounded input.
  if (rawHref.length < 1 || rawHref.length > ARTIFACT_LINK_MAX_LENGTH) return null;
  if (rawHref !== rawHref.trim()) return null;
  if (rawHref.includes('\\') || hasControlCharOrLoneSurrogate(rawHref)) return null;

  const hashIndex = rawHref.indexOf('#');
  const rawPath = hashIndex === -1 ? rawHref : rawHref.slice(0, hashIndex);
  const rawFragment = hashIndex === -1 ? null : rawHref.slice(hashIndex + 1);

  let fragment: string | null = null;
  if (rawFragment !== null) {
    if (rawFragment === '' || rawFragment.includes('#')) return null;
    fragment = decodeFragment(rawFragment);
    if (fragment === null) return null;
  }

  if (rawPath === '' || rawPath.includes('?') || rawPath.includes('//')) return null;

  const absolute = rawPath.startsWith('/');
  const trailingSlash = rawPath.endsWith('/');
  const rawSegments = rawPath.split('/');
  if (absolute) rawSegments.shift();
  if (trailingSlash) rawSegments.pop();

  // A relative path whose first segment looks like `scheme:` is a URL, not a page name.
  // `./section:1` / `/team/section:1` are the spellings for a page name that contains a colon.
  if (!absolute && rawSegments.length > 0 && SCHEME_LIKE_FIRST_SEGMENT.test(rawSegments[0])) return null;

  const segments: string[] = [];
  for (const rawSegment of rawSegments) {
    if (rawSegment === '') return null;
    const segment = decodeSegment(rawSegment);
    if (segment === null) return null;
    segments.push(segment);
  }

  return { absolute, segments, trailingSlash, fragment };
}
