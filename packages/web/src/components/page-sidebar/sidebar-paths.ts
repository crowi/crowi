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
