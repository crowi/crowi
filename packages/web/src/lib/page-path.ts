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
