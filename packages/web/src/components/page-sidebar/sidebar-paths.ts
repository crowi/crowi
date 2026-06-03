/**
 * Pure path math for the single-page sidebar tree.
 *
 * The single-page sidebar shows the current page's ancestry as an
 * expanded breadcrumb tree: at each level the sibling directories /
 * pages are listed, and the branch leading to the current page is opened
 * one level deeper, all the way down to the current page itself.
 *
 * To bound the tree, the inline root is capped at `ROOT_DEPTH` segments
 * (`/space/group/`). Anything above that is reachable via the ⤴
 * "up one level" affordance (`upPath`).
 */

// `/space/group/` — the directory depth at which the inline tree roots.
export const ROOT_DEPTH = 2;

export interface SingleSidebarLayout {
  /**
   * Directory paths whose children form each tree level, ordered from
   * the display root down to the directory containing the current page.
   * Each is trailing-slashed (a portal path).
   */
  levelPaths: string[];
  /**
   * The segment to expand at each level (aligned with `levelPaths`).
   * For every level but the last this is the next ancestor directory;
   * at the last level it is the current page's own leaf segment.
   */
  activeSegments: string[];
  /** The current page's leaf segment, highlighted at the deepest level. */
  currentSegment: string;
  /**
   * Where the ⤴ affordance links (one level above the display root), or
   * `null` when the root is already the top — nowhere further up.
   */
  upPath: string | null;
}

/**
 * Compute the single-page sidebar layout for a (non-portal) page path.
 *
 *   /crowi/project/hoge/xxx/yyy →
 *     levelPaths:     ['/crowi/project/', '/crowi/project/hoge/', '/crowi/project/hoge/xxx/']
 *     activeSegments: ['hoge', 'xxx', 'yyy']
 *     currentSegment: 'yyy'
 *     upPath:         '/crowi/'
 */
export function singleSidebarLayout(pagePath: string): SingleSidebarLayout {
  const segs = pagePath.split('/').filter(Boolean);
  const dirSegs = segs.slice(0, -1);
  const currentSegment = segs[segs.length - 1] ?? '';
  // Root no deeper than the directory that actually contains the page.
  const rootDepth = Math.min(ROOT_DEPTH, dirSegs.length);

  const dirPathAt = (depth: number) => (depth === 0 ? '/' : `/${dirSegs.slice(0, depth).join('/')}/`);

  const levelPaths: string[] = [];
  const activeSegments: string[] = [];
  for (let depth = rootDepth; depth <= dirSegs.length; depth++) {
    levelPaths.push(dirPathAt(depth));
    activeSegments.push(depth < dirSegs.length ? dirSegs[depth] : currentSegment);
  }

  const upPath = rootDepth === 0 ? null : dirPathAt(rootDepth - 1);

  return { levelPaths, activeSegments, currentSegment, upPath };
}
