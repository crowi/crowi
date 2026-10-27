/**
 * Top-level path segments the server reserves as system / backend routes,
 * never creatable as wiki pages. Mirrors the named-prefix alternation in
 * the server's `Page.isCreatableName` (`packages/api/src/models/page.ts`):
 * those entries — plus `api`, the reverse-proxied backend namespace added
 * in v2 — are the ones that can leak to the Next.js catch-all and must not
 * be rendered as a missing page offering "create this page".
 *
 * `user` is deliberately absent: `/user` / `/user/` render the member
 * directory (a dedicated view in the catch-all) and deeper `/user/<name>`
 * pages are normal, creatable pages — so the catch-all handles those itself
 * rather than 404-ing them here.
 */
export const RESERVED_TOP_LEVEL_NAMES = ['installer', 'register', 'login', 'logout', 'admin', 'me', 'files', 'trash', 'paste', 'comments', 'api'] as const;

// Case-sensitive on purpose, like the server's `Page.isCreatableName`, which builds its own pattern from
// `RESERVED_TOP_LEVEL_NAMES`; `classifyArtifactPagePath` lowercases before calling this, the model does not.
const RESERVED_TOP_LEVEL_PATH = new RegExp(`^/(${RESERVED_TOP_LEVEL_NAMES.join('|')})(/.*|$)`);

/**
 * Whether `path` is a reserved system / backend route that the wiki must
 * never treat as a creatable page. The catch-all 404s these instead of
 * offering the "create this page" affordance for a path the server would
 * refuse to create anyway (and, for `/api/*`, one the front proxy routes
 * to the api in production).
 *
 * The match is segment-bounded (mirroring the server), so a real page such
 * as `/apiary` or `/meeting` stays a normal wiki page.
 *
 *   /api, /api/x, /paste, /admin/x → true
 *   /apiary, /meeting, /crowi/api     → false
 */
export function isReservedPagePath(path: string): boolean {
  return RESERVED_TOP_LEVEL_PATH.test(path);
}

/**
 * The directory portion of a wiki path — everything up to and including the
 * final slash before the basename. The natural pair of `pageBasename`, used
 * by the list view to render a muted path prefix beneath the page title.
 *
 *   /crowi/rfc/0001-plugin-architecture → '/crowi/rfc/'
 *   /foo/bar/                           → '/foo/'
 *   /foo                                → '/'
 *   /                                   → '/'
 */
export function pageDirname(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx <= 0 ? '/' : `${trimmed.slice(0, idx)}/`;
}

/**
 * Real page path → href. Spaces become `+`; every other character is left
 * for Next.js / the browser to percent-encode, exactly as before.
 *
 *   /a b/c → /a+b/c
 */
export function pagePathToHref(path: string): string {
  return path.replace(/ /g, '+');
}

/**
 * URL pathname (or a `?path=` value) → real page path. Both `+` and `%20`
 * decode to a space, so — as in legacy Crowi — a literal `+` cannot appear
 * in a page path (it is always read as a space).
 *
 *   /a+b/c   → /a b/c
 *   /a%20b/c → /a b/c
 */
export function decodePagePathFromUrl(urlPath: string): string {
  // Percent-decode first, then hand off to `decodeRouteParamSegment` for the
  // `+`-as-space half — so that rule is written once and the two helpers'
  // relationship is structural rather than a comment asking you to keep them
  // in step.
  return decodeRouteParamSegment(decodeURIComponent(urlPath));
}

/**
 * Next.js catch-all route param → real page path segment. `params.slug[]`
 * segments from a `[[...slug]]` dynamic route come out of Next's route
 * matcher already `decodeURIComponent`d, unlike `usePathname()` (used by the
 * catch-all page above), which stays percent-encoded. Running
 * `decodePagePathFromUrl` (which calls `decodeURIComponent` again) on an
 * already-decoded route-param segment double-decodes it. This helper covers
 * only the `+`-as-space half of the contract — no percent-decoding, since
 * the route matcher already did that.
 *
 *   'a+b'   → 'a b'   (same `+`-as-space rule as decodePagePathFromUrl)
 *   'a%20b' → 'a%20b' (NOT decoded again — already decoded upstream)
 */
export function decodeRouteParamSegment(segment: string): string {
  return segment.replace(/\+/g, ' ');
}

/** One `[label](/destination)` candidate found by `scanRawSpaceLinkGrammar`. */
export interface RawSpaceLinkMatch {
  /** Index in the scanned string where the match (`[`) starts. */
  start: number;
  /** Index (exclusive) just after the closing `)`. */
  end: number;
  label: string;
  destination: string;
}

/**
 * Lists `[label](/destination)` candidates left to right, non-overlapping.
 * The label has no `[` / `]` / newline; the destination starts with `/` and
 * has no `(` / `)` / newline. The bounds keep a pathological run of unmatched
 * brackets from a runaway scan. This is the single definition shared by the
 * renderer (which turns accepted candidates into links) and the editor (which
 * colours them), so the two cannot drift apart.
 */
export function scanRawSpaceLinkGrammar(source: string): RawSpaceLinkMatch[] {
  const out: RawSpaceLinkMatch[] = [];
  for (const m of source.matchAll(/\[([^[\]\n]{1,512})\]\((\/[^()\n]{1,2048})\)/g)) {
    out.push({ start: m.index, end: m.index + m[0].length, label: m[1], destination: m[2] });
  }
  return out;
}

/**
 * Whether a candidate is a raw-space link that should be recovered as a link.
 * `source` is the string the candidate was scanned from (the renderer passes
 * the de-escaped text value). `raw` is the same candidate located in the
 * original markdown, needed only to see a backslash that parsing already
 * removed from `source`; omit it when no original text is available.
 */
export function isRawSpaceLinkRecoverable(source: string, match: RawSpaceLinkMatch, raw?: { source: string; start: number }): boolean {
  // `![alt](/a b)` fails to parse as an image for the same reason it fails as a link.
  if (match.start > 0 && source[match.start - 1] === '!') return false;
  if (!match.destination.includes(' ')) return false;
  // A `"` looks like a title continuation; leave it rather than guess a wrong URL.
  if (match.destination.includes('"')) return false;
  if (raw && raw.start > 0 && raw.source[raw.start - 1] === '\\') return false;
  return true;
}
