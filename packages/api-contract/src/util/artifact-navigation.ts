import { ARTIFACT_LINK_MAX_LENGTH, hasControlCharOrLoneSurrogate, parseArtifactPageLink, type ParsedArtifactPageLink } from './artifact-link';
import { isObjectId } from './object-id';
import { decodePagePathFromUrl, decodeRouteParamSegment, isReservedPagePath, pageDirname, pagePathToHref } from './page-path';

export type ArtifactNavigationTarget = Readonly<{ pagePath: string; href: string }>;

export type ArtifactPagePathClassification = 'page' | 'reserved-route' | 'invalid-path';

// An origin that can never be a real one: only used to check that a resolved href stays on whatever origin it is later joined to.
const PROBE_ORIGIN = 'https://crowi.invalid';

/**
 * Whether `pagePath` has the canonical shape of a stored `Page.path`: a
 * decoded absolute path with real spaces. `%` and `:` are ordinary page-name
 * characters, so they stay valid; a literal `+` is not (a path's `+` always
 * reads back as a space), nor is anything that would change meaning if it
 * were placed in a URL.
 */
export function isCanonicalPagePath(pagePath: string): boolean {
  if (pagePath.length === 0 || pagePath.length > ARTIFACT_LINK_MAX_LENGTH) return false;
  if (!pagePath.startsWith('/') || pagePath.includes('//')) return false;
  if (hasControlCharOrLoneSurrogate(pagePath)) return false;
  if (/[\\?#+]/.test(pagePath)) return false;
  return !pagePath.split('/').some((segment) => /^\.+$/.test(segment));
}

const asciiLowercase = (value: string): string => value.replace(/[A-Z]/g, (char) => char.toLowerCase());

// First segments the wiki app serves as something other than a wiki page. `isReservedPagePath` covers the
// ones the model refuses to create (installer … api); these are the rest of the app's page routes.
const APP_ROUTE_FIRST_SEGMENTS = new Set(['activate', 'confirm-email', 'forgot-password', 'reset-password', 'invite', 'oauth']);
const BACKEND_OR_STATIC_FIRST_SEGMENTS = new Set(['collab', 'presence', 'notifications', 'socket.io', 'logo', 'images', 'favicon.ico']);
// Dedicated tabs under `/user/<username>/`; the model reserves the same names (`Page.isCreatableName`).
const USER_TAB_PREFIXES = ['bookmarks', 'comments', 'activities', 'pages', 'recent-create', 'recent-edit'];

/**
 * Classifies a canonical page path: `invalid-path` when its structure is not
 * a stored `Page.path`, `reserved-route` when the wiki app serves it as
 * something other than a wiki page, `page` otherwise. The reserved prefixes
 * mirror `Page.isCreatableName` in `packages/api/src/models/page.ts`, but this
 * copy matches case-insensitively and also refuses a bare `/-` and a trailing
 * `/edit/`, which the model accepts, so the two are not interchangeable.
 */
export function classifyArtifactPagePath(pagePath: string): ArtifactPagePathClassification {
  if (!isCanonicalPagePath(pagePath)) return 'invalid-path';
  const lower = asciiLowercase(pagePath);
  const segments = lower.split('/').filter(Boolean);
  if (segments.length === 0) return 'page';
  const [first] = segments;

  if (isReservedPagePath(lower)) return 'reserved-route';
  if (APP_ROUTE_FIRST_SEGMENTS.has(first) || BACKEND_OR_STATIC_FIRST_SEGMENTS.has(first)) return 'reserved-route';
  if (first.startsWith('_') || first.startsWith('.') || first === '-') return 'reserved-route';

  if (first === 'user') {
    if (segments.length === 1) return 'reserved-route';
    if (segments.length >= 3 && USER_TAB_PREFIXES.some((tab) => segments[2].startsWith(tab))) return 'reserved-route';
  }

  // The ObjectId redirector grants access, so a bare id is never a link an artifact may carry.
  if (segments.length === 1 && isObjectId(first)) return 'reserved-route';

  if (/[\^$*]/.test(lower) || /\s+\/\s+/.test(lower)) return 'reserved-route';
  const withoutTrailingSlash = lower.replace(/\/+$/, '');
  if (withoutTrailingSlash.endsWith('/edit') || withoutTrailingSlash.endsWith('.md')) return 'reserved-route';
  return 'page';
}

/**
 * Whether the wiki may be sent to `pagePath` on an artifact's behalf: only
 * addresses that open an ordinary wiki page (or the user profile route, which
 * shows the user's home page).
 */
export function isSafeArtifactPagePath(pagePath: string): boolean {
  return classifyArtifactPagePath(pagePath) === 'page';
}

/**
 * Resolves an already-parsed link to a page path. Absolute links need no base;
 * a relative link resolves from the directory of `sourcePagePath` and is null
 * without a canonical one. `.` / `..` are applied, escaping the root is null.
 * The result is not checked for safety — see `classifyArtifactPagePath`.
 */
export function resolveArtifactPagePath(link: ParsedArtifactPageLink, sourcePagePath?: string): string | null {
  let stack: string[] = [];
  if (!link.absolute) {
    if (sourcePagePath === undefined || !isCanonicalPagePath(sourcePagePath)) return null;
    stack = pageDirname(sourcePagePath).split('/').filter(Boolean);
  }
  for (const rawSegment of link.segments) {
    if (rawSegment === '.') continue;
    if (rawSegment === '..') {
      if (stack.pop() === undefined) return null;
      continue;
    }
    stack.push(decodeRouteParamSegment(rawSegment));
  }
  const lastSegment = link.segments[link.segments.length - 1];
  const keepTrailingSlash = link.trailingSlash || lastSegment === '.' || lastSegment === '..';
  return stack.length === 0 ? '/' : `/${stack.join('/')}${keepTrailingSlash ? '/' : ''}`;
}

function pagePathToSafeHref(pagePath: string, fragment: string | null): string {
  const encodedPath = pagePath
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/%20/g, ' '))
    .join('/');
  return `${pagePathToHref(encodedPath)}${fragment === null ? '' : `#${encodeURIComponent(fragment)}`}`;
}

/**
 * Resolves an href an artifact author wrote against the page that holds the
 * artifact, or null when it is not a safe wiki page link. Relative links are
 * sibling-based, like the rest of Crowi: `guide` from `/team/artifact` is
 * `/team/guide`. Nothing here consults the artifact's own URL.
 */
export function resolveArtifactNavigation(sourcePagePath: string, rawHref: string): ArtifactNavigationTarget | null {
  if (!isCanonicalPagePath(sourcePagePath)) return null;
  const parsed = parseArtifactPageLink(rawHref);
  if (parsed === null) return null;

  const pagePath = resolveArtifactPagePath(parsed, sourcePagePath);
  if (pagePath === null || !isSafeArtifactPagePath(pagePath)) return null;
  const href = pagePathToSafeHref(pagePath, parsed.fragment);
  if (href.length > ARTIFACT_LINK_MAX_LENGTH) return null;

  // The href must be exactly the page we resolved and nothing else: same origin, no query, same path back.
  try {
    const url = new URL(href, PROBE_ORIGIN);
    if (url.origin !== PROBE_ORIGIN || url.search !== '' || decodePagePathFromUrl(url.pathname) !== pagePath) return null;
  } catch {
    return null;
  }
  return { pagePath, href };
}
