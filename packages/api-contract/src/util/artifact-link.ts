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

function decodeFragment(raw: string): string | null {
  const decoded = decodeOnce(raw);
  if (decoded === null) return null;
  if (decoded.includes('\\') || decoded.includes('%') || hasControlCharOrLoneSurrogate(decoded)) return null;
  return decoded;
}

export type ArtifactPageLinkParseFailure = 'PAGE_LINK_QUERY' | 'PAGE_LINK_PERCENT_ENCODING' | 'PAGE_LINK_INVALID';

export type ArtifactPageLinkParseResult =
  | Readonly<{ ok: true; link: ParsedArtifactPageLink }>
  | Readonly<{ ok: false; diagnosticCode: ArtifactPageLinkParseFailure }>;

const INVALID: ArtifactPageLinkParseResult = { ok: false, diagnosticCode: 'PAGE_LINK_INVALID' };
const QUERY: ArtifactPageLinkParseResult = { ok: false, diagnosticCode: 'PAGE_LINK_QUERY' };
const PERCENT_ENCODING: ArtifactPageLinkParseResult = { ok: false, diagnosticCode: 'PAGE_LINK_PERCENT_ENCODING' };

/**
 * Same acceptance set as `parseArtifactPageLink`, with the reason for a
 * refusal. Failures are checked in a fixed order so one href always yields one
 * code: length / control / backslash, then structure (`#` split, empty path,
 * `//`, scheme-like), then a raw `?` in the path, then each path segment's
 * escapes, then the fragment. The result never carries the href itself.
 */
export function parseArtifactPageLinkDetailed(rawHref: string): ArtifactPageLinkParseResult {
  // The length gate runs before any split / decode so cost stays linear in a bounded input.
  if (rawHref.length < 1 || rawHref.length > ARTIFACT_LINK_MAX_LENGTH) return INVALID;
  if (rawHref !== rawHref.trim()) return INVALID;
  if (rawHref.includes('\\') || hasControlCharOrLoneSurrogate(rawHref)) return INVALID;

  const hashIndex = rawHref.indexOf('#');
  const rawPath = hashIndex === -1 ? rawHref : rawHref.slice(0, hashIndex);
  const rawFragment = hashIndex === -1 ? null : rawHref.slice(hashIndex + 1);

  if (rawPath === '' || rawPath.includes('//')) return INVALID;

  const absolute = rawPath.startsWith('/');
  const trailingSlash = rawPath.endsWith('/');
  const rawSegments = rawPath.split('/');
  if (absolute) rawSegments.shift();
  if (trailingSlash) rawSegments.pop();

  // A relative path whose first segment looks like `scheme:` is a URL, not a page name.
  // `./section:1` / `/team/section:1` are the spellings for a page name that contains a colon.
  if (!absolute && rawSegments.length > 0 && SCHEME_LIKE_FIRST_SEGMENT.test(rawSegments[0])) return INVALID;

  if (rawPath.includes('?')) return QUERY;

  const segments: string[] = [];
  for (const rawSegment of rawSegments) {
    if (rawSegment === '') return INVALID;
    const decoded = decodeOnce(rawSegment);
    if (decoded === null) return PERCENT_ENCODING;
    if (/[/\\?#]/.test(decoded) || hasControlCharOrLoneSurrogate(decoded)) return INVALID;
    segments.push(decoded);
  }

  let fragment: string | null = null;
  if (rawFragment !== null) {
    if (rawFragment === '' || rawFragment.includes('#')) return INVALID;
    fragment = decodeFragment(rawFragment);
    if (fragment === null) return INVALID;
  }

  return { ok: true, link: { absolute, segments, trailingSlash, fragment } };
}

export function parseArtifactPageLink(rawHref: string): ParsedArtifactPageLink | null {
  const result = parseArtifactPageLinkDetailed(rawHref);
  return result.ok ? result.link : null;
}
