/**
 * Pure path math for the page sidebar tree.
 *
 * A path and its trailing-slash twin render the EXACT SAME tree:
 * `pageSidebarLayout('/a/b/c')` and `pageSidebarLayout('/a/b/c/')` are
 * deep-equal. Both forms refer to the same node `c`, so the sidebar
 * surrounding it must look identical whether you opened the content page
 * (`/a/b/c`) or its portal (`/a/b/c/`).
 *
 * At each level the sibling directories / pages are listed, and the
 * branch leading to where you are is opened one level deeper. The current
 * node's OWN children are always fetched and expanded (the deepest level),
 * so a content page no longer collapses its subtree the way it used to —
 * `/a/b/c` shows `c/`'s children just like `/a/b/c/` does. When `c` has no
 * children that deepest level simply renders nothing.
 *
 * Navigating between a page and its portal (or to an ancestor portal)
 * therefore keeps the surrounding tree (siblings, ancestors, the ⤴
 * affordance) in place instead of jumping around.
 *
 * To bound the tree, the inline root is capped at `ROOT_DEPTH` segments
 * (`/space/group/`). Anything above that is reachable via the ⤴
 * "up one level" affordance (`upPath`).
 */

import type { PageChildSegment } from '@crowi/api-contract';

import { isNumericSegment, pageDirname } from '@/lib/page-path';

// `/space/group/` — the directory depth at which the inline tree roots.
export const ROOT_DEPTH = 2;

// The member directory: a special page list (the user roster), reached
// from the sidebar nav links rather than the hierarchy tree. It is never
// rendered as a tree node, and a user's own space (`/user/{username}/…`)
// roots at the user's home with no ⤴ above it.
export const MEMBER_DIR_PATH = '/user/';

export interface PageSidebarLayout {
  /**
   * Directory paths whose children form each tree level, ordered from
   * the display root down to (and including) the deepest expanded
   * directory. Each is trailing-slashed (a portal path).
   */
  levelPaths: string[];
  /**
   * The child segment to open at each level (aligned with `levelPaths`),
   * or `null` when there is nothing deeper to open (the deepest level of
   * a portal page just lists its children).
   */
  activeSegments: (string | null)[];
  /** The "you are here" segment, highlighted at `currentLevelIndex`. */
  currentSegment: string;
  /**
   * Index into `levelPaths` whose active child is the current node, or
   * `-1` when the current node is the (un-rendered) root — e.g. the top
   * page, or a portal shallow enough to sit at the root depth.
   */
  currentLevelIndex: number;
  /**
   * Where the ⤴ affordance links: the display root itself — the portal
   * that contains the listed children — so the user climbs one bounded
   * level at a time. `null` when the root is already the top
   * (`rootDepth === 0`) or inside a user space.
   */
  upPath: string | null;
  /**
   * When inside a user's space (`/user/{username}/…`), the username — the
   * tree is topped with that user's home as a node (user icon) instead of
   * a ⤴, since the roster is reached from the nav links. `null` otherwise.
   */
  userHome: string | null;
}

/**
 * Compute the sidebar layout for any wiki path. A path and its
 * trailing-slash twin yield the identical layout (see file header).
 *
 *   /crowi/project/hoge/xxx/yyy (or .../yyy/) →
 *     levelPaths:    ['/crowi/project/', '/crowi/project/hoge/', '/crowi/project/hoge/xxx/', '/crowi/project/hoge/xxx/yyy/']
 *     activeSegments:['hoge', 'xxx', 'yyy', null]
 *     currentSegment:'yyy'  currentLevelIndex: 2  upPath: '/crowi/project/'
 *
 *   /crowi/project/hoge (or /crowi/project/hoge/) →
 *     levelPaths:    ['/crowi/project/', '/crowi/project/hoge/']
 *     activeSegments:['hoge', null]
 *     currentSegment:'hoge' currentLevelIndex: 0  upPath: '/crowi/project/'
 */
export function pageSidebarLayout(path: string): PageSidebarLayout {
  // The member directory itself has no hierarchy tree — its content is
  // the roster, and it is reached from the nav links.
  if (path === MEMBER_DIR_PATH) {
    return { levelPaths: [], activeSegments: [], currentSegment: '', currentLevelIndex: -1, upPath: null, userHome: null };
  }

  // `filter(Boolean)` drops the empty trailing segment, so `/a/b/c` and
  // `/a/b/c/` produce the same `segs` — this is what makes the two forms
  // collapse to one layout.
  const segs = path.split('/').filter(Boolean);
  // A user's own space (`/user/{username}/…`) always roots at the user's
  // home (`/user/{username}/`, depth = ROOT_DEPTH) and shows no ⤴ — the
  // roster lives in the nav links, not above this in the tree.
  const isUserSpace = segs[0] === 'user' && segs.length >= 2;

  // The directory whose listing surfaces the current node as a child
  // (its parent; -1 for the top page, which has no parent), and the
  // deepest directory we fetch & expand (the current node's OWN
  // children). The current node always opens its children — content
  // pages no longer collapse their subtree.
  const nodeListDepth = segs.length - 1;
  const expandDepth = segs.length;
  // For a user space, never root shallower than the user's home so the
  // tree always roots there (even on the home page itself).
  const naturalRoot = Math.max(0, Math.min(ROOT_DEPTH, nodeListDepth - 1));
  const rootDepth = isUserSpace ? ROOT_DEPTH : naturalRoot;

  const dirPathAt = (depth: number) => (depth === 0 ? '/' : `/${segs.slice(0, depth).join('/')}/`);

  const levelPaths: string[] = [];
  const activeSegments: (string | null)[] = [];
  for (let depth = rootDepth; depth <= expandDepth; depth++) {
    levelPaths.push(dirPathAt(depth));
    // The child at this level that continues toward the current node
    // (the path's segment at this depth); null at the deepest level
    // (the current node's own listing), where there is nothing further
    // to open.
    activeSegments.push(segs[depth] ?? null);
  }

  const currentSegment = segs[segs.length - 1] ?? '';
  const currentLevelIndex = nodeListDepth - rootDepth;
  // ⤴ links to the display root itself — the portal that CONTAINS the
  // listed children (e.g. on `/crowi/rfc/` the tree lists `/crowi/`'s
  // children, so ⤴ goes to `/crowi/`, not its parent `/`). This lets the
  // user climb one bounded level at a time instead of skipping over the
  // container. `null` at the top (`rootDepth === 0`) or in a user space.
  const upPath = isUserSpace || rootDepth === 0 ? null : dirPathAt(rootDepth);
  const userHome = isUserSpace ? segs[1] : null;

  return { levelPaths, activeSegments, currentSegment, currentLevelIndex, upPath, userHome };
}

export interface SidebarSelfLink {
  contentPath: string;
  label: string;
  isCurrent: boolean;
}

/**
 * The content-page self-links, one slot per tree level (aligned with
 * `layout.levelPaths`): the link shown at the TOP of level `k`'s listing, or
 * `null` when that level gets none.
 *
 * A node that is BOTH a content page (`isPage`) AND a directory with
 * descendants (`count > 0`) is drawn as the folder `x/`, which links to the
 * portal-path listing `/…/x/` — so the content page at `/…/x` (no trailing
 * slash) would be unreachable from the sidebar. Wherever such a folder is
 * OPEN — the current node, or any ancestor on the branch leading to it — its
 * content page is surfaced as the first child under `x/`, a leaf row linking
 * to `/…/x`. Otherwise it would vanish as soon as you step into one of its
 * children, while that child's siblings stay listed. A collapsed folder off
 * the open branch shows no children at all, so it gets nothing (the month
 * expansion's off-branch days are the exception — see `folderPageSelfLink`,
 * which the tree applies to them directly). Level 0
 * lists the display root's children, and the root itself is stood for by the
 * ⤴ / user home, so that slot is always `null`.
 *
 * Pure so it can be unit-tested without rendering. `levels` is the fetched
 * child data positionally aligned with `layout.levelPaths`; `path` is the
 * raw current path (its trailing slash decides whether the current node's
 * self-link is the "current" row — you are on `/…/x` vs the listing `/…/x/`).
 * An ancestor's self-link is never current.
 */
export function resolveSidebarSelfLinks(layout: PageSidebarLayout, levels: PageChildSegment[][], path: string): (SidebarSelfLink | null)[] {
  return layout.levelPaths.map((_, k) => {
    if (k === 0) return null;
    const opened = layout.activeSegments[k - 1];
    const entry = (levels[k - 1] ?? []).find((c) => c.segment === opened);
    return folderPageSelfLink(entry, k - 1 === layout.currentLevelIndex && !path.endsWith('/'));
  });
}

/**
 * The self-link for one folder row whose children are shown, or `null` when
 * the row is not a folder that is also a content page. Also used for the
 * month expansion's off-branch days, which open without being on the branch.
 */
export function folderPageSelfLink(entry: PageChildSegment | undefined, isCurrent = false): SidebarSelfLink | null {
  if (!entry || !entry.isPage || entry.count <= 0) return null;
  return {
    // `entry.path` is the trailing-slashed portal path; the content page
    // sits at the same path without the slash.
    contentPath: entry.path.replace(/\/$/, ''),
    label: entry.segment,
    isCurrent,
  };
}

/**
 * The `YYYY/MM/` portal whose whole month the sidebar expands, or `null`
 * when `path` is not inside a date hierarchy deep enough to have one.
 *
 * Crowi's flow-note idiom puts one or two pages under each `YYYY/MM/DD/`,
 * so the plain ancestry tree shows a column of bare day numbers and only
 * ever opens the day you are on. Expanding the whole month instead turns
 * that column into a readable month log — the day rows keep their place,
 * but every day shows what is actually in it.
 *
 * A "date hierarchy" is the same notion the list view and default-title
 * rules use: a run of consecutive all-digit segments (`isNumericSegment`).
 * The month is the run's SECOND segment, so:
 *
 *   /s/2026                    → null   (a year has no month to expand yet)
 *   /s/2026/08                 → '/s/2026/08/'
 *   /s/2026/08/07/             → '/s/2026/08/'
 *   /s/2026/08/07/AIレポート    → '/s/2026/08/'
 *   /crowi/rfc/0002-renderer   → null   (not all-digit — not a date run)
 *
 * The anchor is the first ADJACENT PAIR of numeric segments, which is where
 * the first run of length two or more begins. Both halves matter: a lone
 * numeric segment ahead of the real hierarchy (`/123/project/2026/08/07/x`)
 * must not end the search, and a numerically-named page under a day
 * (`/log/2026/08/07/12`) must not shift the month to `08/07/`.
 *
 * A path and its trailing-slash twin always agree (the empty trailing
 * segment is filtered out), preserving `pageSidebarLayout`'s invariant.
 */
export function dateMonthPath(path: string): string | null {
  const segs = path.split('/').filter(Boolean);
  const runStart = segs.findIndex((seg, index) => isNumericSegment(seg) && isNumericSegment(segs[index + 1] ?? ''));
  if (runStart === -1) return null;
  return `/${segs.slice(0, runStart + 2).join('/')}/`;
}

/**
 * The rows of a `depth > 1` children fetch that are DIRECT children of
 * `parentPath`.
 *
 * A deep fetch returns one flat array spanning several levels (each row
 * carries its own full portal `path`), so the tree rebuilds the nesting by
 * matching each row's parent. Kept pure — the sidebar's month expansion is
 * otherwise only reachable through the network.
 */
export function deepChildRowsOf(rows: PageChildSegment[], parentPath: string): PageChildSegment[] {
  return rows.filter((row) => pageDirname(row.path) === parentPath);
}
