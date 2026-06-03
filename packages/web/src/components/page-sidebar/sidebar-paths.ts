/**
 * Pure path math for the page sidebar tree.
 *
 * Both list (portal) pages and content pages render the SAME expanded
 * ancestry tree: at each level the sibling directories / pages are
 * listed, and the branch leading to where you are is opened one level
 * deeper, down to the current node. The only difference is the deepest
 * node:
 *
 *   - content page (`/a/b/c/d`)  → the leaf page `d` is highlighted; its
 *     directory `/a/b/c/` supplies its siblings.
 *   - portal page  (`/a/b/c/`)   → the directory `c/` is highlighted AND
 *     expanded, so its own children (`/a/b/c/` listing) show below it.
 *
 * Navigating from a page to one of its ancestor portals therefore keeps
 * the surrounding tree (siblings, ancestors, the ⤴ affordance) in place
 * instead of collapsing to just the portal's children.
 *
 * To bound the tree, the inline root is capped at `ROOT_DEPTH` segments
 * (`/space/group/`). Anything above that is reachable via the ⤴
 * "up one level" affordance (`upPath`).
 */

// `/space/group/` — the directory depth at which the inline tree roots.
export const ROOT_DEPTH = 2;

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
   * Where the ⤴ affordance links (one level above the display root), or
   * `null` when the root is already the top — nowhere further up.
   */
  upPath: string | null;
}

/**
 * Compute the sidebar layout for any wiki path (portal or content page).
 *
 *   /crowi/project/hoge/xxx/yyy (page) →
 *     levelPaths:    ['/crowi/project/', '/crowi/project/hoge/', '/crowi/project/hoge/xxx/']
 *     activeSegments:['hoge', 'xxx', 'yyy']
 *     currentSegment:'yyy'  currentLevelIndex: 2  upPath: '/crowi/'
 *
 *   /crowi/project/hoge/ (portal) →
 *     levelPaths:    ['/crowi/project/', '/crowi/project/hoge/']
 *     activeSegments:['hoge', null]
 *     currentSegment:'hoge' currentLevelIndex: 0  upPath: '/crowi/'
 */
export function pageSidebarLayout(path: string): PageSidebarLayout {
  const isPortal = path.endsWith('/');
  const segs = path.split('/').filter(Boolean);
  // Deepest directory whose children we fetch & expand:
  //   portal page  → the portal itself (every segment is a directory)
  //   content page → the directory that contains the leaf page
  const maxDepth = Math.max(0, isPortal ? segs.length : segs.length - 1);
  // Root no deeper than that directory.
  const rootDepth = Math.min(ROOT_DEPTH, maxDepth);

  const dirPathAt = (depth: number) => (depth === 0 ? '/' : `/${segs.slice(0, depth).join('/')}/`);

  const levelPaths: string[] = [];
  const activeSegments: (string | null)[] = [];
  for (let depth = rootDepth; depth <= maxDepth; depth++) {
    levelPaths.push(dirPathAt(depth));
    // The child at this level that continues toward the current node
    // (the path's segment at this depth); null at the deepest portal
    // level, where there is nothing further to open.
    activeSegments.push(segs[depth] ?? null);
  }

  const currentSegment = segs[segs.length - 1] ?? '';
  const currentLevelIndex = segs.length - 1 - rootDepth;
  const upPath = rootDepth === 0 ? null : dirPathAt(rootDepth - 1);

  return { levelPaths, activeSegments, currentSegment, currentLevelIndex, upPath };
}
