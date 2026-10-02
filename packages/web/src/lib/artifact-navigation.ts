import { ARTIFACT_LINK_MAX_LENGTH, hasControlCharOrLoneSurrogate, parseArtifactPageLink } from '@crowi/api-contract';

import { isObjectId } from './object-id';
import { decodePagePathFromUrl, decodeRouteParamSegment, isReservedPagePath, pageDirname, pagePathToHref } from './page-path';

export type ArtifactNavigationTarget = Readonly<{ pagePath: string; href: string }>;

// An origin that can never be a real one: only used to check that a resolved href stays on whatever origin it is later joined to.
const PROBE_ORIGIN = 'https://crowi.invalid';

/**
 * Whether `pagePath` has the canonical shape of a stored `Page.path`: a
 * decoded absolute path with real spaces. `%` and `:` are ordinary page-name
 * characters, so they stay valid; a literal `+` is not (a path's `+` always
 * reads back as a space), nor is anything that would change meaning if it
 * were placed in a URL.
 */
function isCanonicalPagePath(pagePath: string): boolean {
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
 * Whether the wiki may be sent to `pagePath` on an artifact's behalf: only
 * addresses that open an ordinary wiki page (or the user profile route, which
 * shows the user's home page). System routes, backend and static namespaces,
 * names the model refuses to create, and ObjectId shortcuts (whose redirector
 * grants access) are refused. The reserved prefixes mirror
 * `Page.isCreatableName` in `packages/api/src/models/page.ts`, but this
 * copy matches case-insensitively and also refuses a bare `/-` and a
 * trailing `/edit/`, which the model accepts, so the two are not
 * interchangeable.
 */
export function isSafeArtifactPagePath(pagePath: string): boolean {
  if (!isCanonicalPagePath(pagePath)) return false;
  const lower = asciiLowercase(pagePath);
  const segments = lower.split('/').filter(Boolean);
  if (segments.length === 0) return true;
  const [first] = segments;

  if (isReservedPagePath(lower)) return false;
  if (APP_ROUTE_FIRST_SEGMENTS.has(first) || BACKEND_OR_STATIC_FIRST_SEGMENTS.has(first)) return false;
  if (first.startsWith('_') || first.startsWith('.') || first === '-') return false;

  if (first === 'user') {
    if (segments.length === 1) return false;
    if (segments.length >= 3 && USER_TAB_PREFIXES.some((tab) => segments[2].startsWith(tab))) return false;
  }

  if (segments.length === 1 && isObjectId(first)) return false;

  if (/[\^$*]/.test(lower) || /\s+\/\s+/.test(lower)) return false;
  const withoutTrailingSlash = lower.replace(/\/+$/, '');
  if (withoutTrailingSlash.endsWith('/edit') || withoutTrailingSlash.endsWith('.md')) return false;
  return true;
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

  const stack = parsed.absolute ? [] : pageDirname(sourcePagePath).split('/').filter(Boolean);
  for (const rawSegment of parsed.segments) {
    if (rawSegment === '.') continue;
    if (rawSegment === '..') {
      if (stack.pop() === undefined) return null;
      continue;
    }
    stack.push(decodeRouteParamSegment(rawSegment));
  }
  const lastSegment = parsed.segments.at(-1);
  const keepTrailingSlash = parsed.trailingSlash || lastSegment === '.' || lastSegment === '..';
  const pagePath = stack.length === 0 ? '/' : `/${stack.join('/')}${keepTrailingSlash ? '/' : ''}`;

  if (!isSafeArtifactPagePath(pagePath)) return null;
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
