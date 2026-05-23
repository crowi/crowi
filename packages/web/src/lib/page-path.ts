/**
 * The last non-empty segment of a wiki path — the page's short name, used
 * for document titles / tab labels. Returns '' for the top page ('/').
 *
 *   /crowi/rfc/0001-plugin-architecture → '0001-plugin-architecture'
 *   /foo/                               → 'foo'
 *   /                                   → ''
 */
export function pageBasename(path: string): string {
  const segments = path.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? '';
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

function isNumericSegment(segment: string): boolean {
  return segment.length > 0 && /^\d+$/.test(segment);
}

/**
 * Find the index at which the trailing numeric run starts. A "numeric run" is
 * one or more consecutive all-digit path segments at the end of the path —
 * the date-hierarchy idiom Crowi leans on (`/日報/2026/05/23`).
 *
 * Returns `segments.length` when the path has no segments, or when the last
 * segment is not numeric (no run to collapse).
 */
function trailingNumericRunStart(segments: string[]): number {
  if (segments.length === 0) return 0;
  if (!isNumericSegment(segments[segments.length - 1])) return segments.length - 1;
  let start = segments.length - 1;
  while (start > 0 && isNumericSegment(segments[start - 1])) {
    start--;
  }
  return start;
}

/**
 * The display name of a page — like `pageBasename`, but when the last
 * segments form a date hierarchy (consecutive all-digit segments) it
 * returns the whole run joined by `/` instead of just the leaf. This is
 * the path-based-page-name affordance Crowi is built around: a daily
 * note at `/user/foo/日報/2026/05/23` is "2026/05/23", not "23".
 *
 *   /user/foo/日報/2026/05/23 → '2026/05/23'
 *   /user/foo/日報/2026/05/   → '2026/05'
 *   /user/foo/日報/2026/      → '2026'
 *   /crowi/rfc/0001-plugin    → '0001-plugin'
 *   /foo/                     → 'foo'
 *   /                         → ''
 */
export function pageDisplayName(path: string): string {
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return '';
  const start = trailingNumericRunStart(segments);
  return segments.slice(start).join('/');
}

/**
 * The parent portion of `pageDisplayName` — everything before the date
 * run / leaf. Pairs with `pageDisplayName` so that
 * `pageDisplayParent(p) + pageDisplayName(p) === <p without trailing /'s>`
 * for any non-root path. Used by the list view to keep the muted
 * directory prefix short when the title already absorbs the date tail.
 *
 *   /user/foo/日報/2026/05/23 → '/user/foo/日報/'
 *   /user/foo/日報/2026/      → '/user/foo/日報/'
 *   /foo/bar/page              → '/foo/bar/'
 *   /foo                       → '/'
 *   /                          → '/'
 */
export function pageDisplayParent(path: string): string {
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return '/';
  const start = trailingNumericRunStart(segments);
  return start === 0 ? '/' : `/${segments.slice(0, start).join('/')}/`;
}
