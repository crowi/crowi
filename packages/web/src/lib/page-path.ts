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
 * Whether `path` is a user's home page (`/user/<username>`, optional trailing
 * slash). Its path is bound to the username, so it cannot be renamed or
 * deleted — the server enforces this (`isRenamableName` / `isDeletableName`)
 * and the UI hides the actions. Deeper pages under the home (e.g.
 * `/user/<username>/memo`) are normal pages and are NOT matched.
 */
export function isUserHomePath(path: string): boolean {
  return /^\/user\/[^/]+\/?$/.test(path);
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

/**
 * The default H1 title text for a brand-new page at `path`.
 *
 * Crowi leans on the date-hierarchy idiom (`<notebook>/YYYY/MM/DD`), so
 * the rule is:
 *
 *   - When the path ends in a date run (one or more trailing all-digit
 *     segments), the title is that run PLUS the single segment in front
 *     of it (the "notebook" label) — so a daily note keeps its context.
 *   - Otherwise the title is just the leaf segment.
 *
 *   /user/sotarok/memo/2026/06/08          → 'memo/2026/06/08'
 *   /user/sotarok/zyx/134/hoge-fuga-piyo   → 'hoge-fuga-piyo'
 *   /crowi/qa/2026/06/08/rfc-0011-mcp      → 'rfc-0011-mcp'
 *   /crowi/qa/rfc-0011-mcp                 → 'rfc-0011-mcp'
 *   /crowi/日報/2026/06/08                 → '日報/2026/06/08'
 *   /                                      → ''
 *
 * Note the deliberate difference from `pageDisplayName`, which drops the
 * notebook segment (it collapses to just the date run). Here we keep it
 * so the seeded H1 reads like the page's own name, not a bare date.
 */
export function pageDefaultTitle(path: string): string {
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return '';
  const last = segments[segments.length - 1];
  // No trailing date run → the leaf segment is the whole title.
  if (!isNumericSegment(last)) return last;
  // A trailing all-digit run exists; keep the one segment before it
  // (the notebook label) alongside the run.
  const runStart = trailingNumericRunStart(segments);
  const notebookStart = Math.max(0, runStart - 1);
  return segments.slice(notebookStart).join('/');
}

/**
 * The markdown body seeded into a freshly-created draft page: a path-
 * derived H1, a blank line, then the line the cursor lands on. Falls
 * back to a single newline (the legacy default) for the rootless edge
 * case where no title can be derived.
 *
 *   /user/sotarok/memo/2026/06/08 → '# memo/2026/06/08\n\n'
 */
export function defaultDraftBody(path: string): string {
  const title = pageDefaultTitle(path);
  if (!title) return '\n';
  return `# ${title}\n\n`;
}

/**
 * Wiki page paths may contain spaces. Following legacy Crowi, the URL
 * renders each space as `+` (far more readable than `%20`) and reads `+`
 * back as a space, so `/Weall/dev/infra/v0/mysql+connect+to+production+db`
 * resolves to the page `/Weall/dev/infra/v0/mysql connect to production db`.
 * The API and every stored path use real spaces — these two helpers
 * convert only at the Next.js routing boundary.
 *
 * Mirrors the server-side `encodeSpace` / `decodeSpace`
 * (`packages/api/src/util/path.ts`), which apply the same rule to
 * `[[wiki links]]` inside page bodies.
 */

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
  return decodeURIComponent(urlPath).replace(/\+/g, ' ');
}
