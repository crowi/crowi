/**
 * Extract the candidate Crowi page path from each shared Slack link that
 * points at this wiki's host, keyed by the original URL (so the
 * `chat.unfurl` payload can map results back to the exact link Slack
 * sent). Links to other hosts are dropped.
 *
 * A Crowi page URL is `{CLIENT_URL}/<page-path>` — the URL pathname IS the
 * page path (including the leading slash). `_id` permalinks
 * (`{base}/<24-hex>`) resolve to the same pathname; `events.ts` first
 * tries the path then falls back to `_id` for the bare-hex form, so this
 * parser stays a pure host-filter + pathname-extractor with no Mongo
 * coupling.
 *
 * Pure function (no I/O) so the host-matching + decoding rules are
 * unit-testable.
 */
export function extractPagePaths(urls: string[], baseUrl: string): Map<string, string> {
  const out = new Map<string, string>();

  let wikiHost: string;
  try {
    wikiHost = new URL(baseUrl).host;
  } catch {
    return out;
  }

  for (const url of urls) {
    const path = pagePathFromUrl(url, wikiHost);
    if (path) {
      out.set(url, path);
    }
  }
  return out;
}

/**
 * The page path for a single URL, or null when it doesn't point at the
 * wiki host or has no usable path. The query string / fragment are
 * dropped (e.g. `?compare=…`, `#heading`) — they don't change which page
 * is referenced.
 */
function pagePathFromUrl(url: string, wikiHost: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.host !== wikiHost) {
    return null;
  }

  // `URL.pathname` is percent-encoded; decode so it matches the stored
  // page path (which holds raw UTF-8). Decoding can throw on malformed
  // sequences — treat those as no-match rather than crashing.
  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }

  // The root (`/`) is the top portal, not an unfurlable page.
  if (!path || path === '/') {
    return null;
  }

  return path;
}

/** True when a path segment is a bare Mongo ObjectId permalink (`/<24-hex>`). */
export function isPageIdPath(path: string): boolean {
  return /^\/[0-9a-f]{24}$/i.test(path);
}

/** Strip the leading slash to get the `_id` from an id-permalink path. */
export function pageIdFromPath(path: string): string {
  return path.replace(/^\//, '');
}
