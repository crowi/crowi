import type { PageChildSegment } from '@crowi/api-contract';
import { describe, expect, it } from 'vitest';
import { pageSidebarLayout, resolveSidebarSelfLink } from './sidebar-paths';

describe('pageSidebarLayout', () => {
  // The defining invariant of the unified tree (feature-update-pages-list-ux
  // §2): a content path and its trailing-slash twin describe the same node,
  // so they must produce a deep-equal layout. Every other case below relies
  // on this, so it is asserted explicitly across the representative shapes.
  describe('/x ≡ /x/ identity', () => {
    it.each([
      '/crowi/project/hoge/xxx/yyy',
      '/crowi/rfc/0002-renderer',
      '/crowi/foo',
      '/foo',
      '/user/alice',
      '/user/alice/diary/2026/05/23',
    ])('pageSidebarLayout(%s) === pageSidebarLayout(%s + "/")', (path) => {
      expect(pageSidebarLayout(path)).toEqual(pageSidebarLayout(`${path}/`));
    });
  });

  describe('content / portal node (now identical)', () => {
    it("expands the current node's OWN children at the deepest level, rooted at /space/group/", () => {
      // The current node `yyy` now opens its own children (the deepest
      // levelPath is `.../yyy/`), so a content page no longer collapses its
      // subtree. The trailing-slash twin produces the same layout.
      const expected = {
        levelPaths: ['/crowi/project/', '/crowi/project/hoge/', '/crowi/project/hoge/xxx/', '/crowi/project/hoge/xxx/yyy/'],
        activeSegments: ['hoge', 'xxx', 'yyy', null],
        currentSegment: 'yyy',
        currentLevelIndex: 2,
        upPath: '/crowi/project/',
        userHome: null,
      };
      expect(pageSidebarLayout('/crowi/project/hoge/xxx/yyy')).toEqual(expected);
      expect(pageSidebarLayout('/crowi/project/hoge/xxx/yyy/')).toEqual(expected);
    });

    it('shows the parent folder as a node for a shallow node and expands its children', () => {
      // /crowi/rfc/0002 surfaces `rfc/` as a node, then opens `0002-renderer/`
      // (its own children) at the deepest level. The ⤴ links to the display
      // root `/crowi/`.
      expect(pageSidebarLayout('/crowi/rfc/0002-renderer')).toEqual({
        levelPaths: ['/crowi/', '/crowi/rfc/', '/crowi/rfc/0002-renderer/'],
        activeSegments: ['rfc', '0002-renderer', null],
        currentSegment: '0002-renderer',
        currentLevelIndex: 1,
        upPath: '/crowi/',
        userHome: null,
      });
    });

    it('shows the containing space as a node for a 2-segment node', () => {
      expect(pageSidebarLayout('/crowi/foo')).toEqual({
        levelPaths: ['/', '/crowi/', '/crowi/foo/'],
        activeSegments: ['crowi', 'foo', null],
        currentSegment: 'foo',
        currentLevelIndex: 1,
        upPath: null,
        userHome: null,
      });
    });

    it('has no ⤴ for a node directly under the top page (and expands its children)', () => {
      expect(pageSidebarLayout('/foo')).toEqual({
        levelPaths: ['/', '/foo/'],
        activeSegments: ['foo', null],
        currentSegment: 'foo',
        currentLevelIndex: 0,
        upPath: null,
        userHome: null,
      });
    });

    it('a portal page sits at the same node as its content twin', () => {
      // /a/b/c/ (portal) and /a/b/c (page) share the same ancestry, the same
      // current node `c`, and now the same deepest level (c's own children).
      // Rooting is one level above the parent that lists `c` (`/a/b/`),
      // bounded by ROOT_DEPTH, so the display root is `/a/`.
      const portal = pageSidebarLayout('/a/b/c/');
      expect(portal.levelPaths).toEqual(['/a/', '/a/b/', '/a/b/c/']);
      expect(portal.activeSegments).toEqual(['b', 'c', null]);
      expect(portal.currentSegment).toBe('c');
      expect(portal.currentLevelIndex).toBe(1);
      expect(portal.upPath).toBe('/a/');
      // And its content twin is deep-equal.
      expect(pageSidebarLayout('/a/b/c')).toEqual(portal);
    });

    it('lists top-level segments for the top page with no highlight or ⤴', () => {
      expect(pageSidebarLayout('/')).toEqual({
        levelPaths: ['/'],
        activeSegments: [null],
        currentSegment: '',
        currentLevelIndex: -1,
        upPath: null,
        userHome: null,
      });
    });
  });

  describe('user space', () => {
    it('tops a deep user page with the user home (no ⤴), roots at /user/{username}/, and expands the leaf', () => {
      expect(pageSidebarLayout('/user/alice/diary/2026/05/23')).toEqual({
        levelPaths: ['/user/alice/', '/user/alice/diary/', '/user/alice/diary/2026/', '/user/alice/diary/2026/05/', '/user/alice/diary/2026/05/23/'],
        activeSegments: ['diary', '2026', '05', '23', null],
        currentSegment: '23',
        currentLevelIndex: 3,
        upPath: null,
        userHome: 'alice',
      });
    });

    it('roots a user home page at its own namespace (lists sub-pages, no ⤴)', () => {
      // /user/alice (the home content page) and /user/alice/ both root at
      // /user/alice/ so the sidebar lists the user's sub-pages.
      expect(pageSidebarLayout('/user/alice')).toEqual({
        levelPaths: ['/user/alice/'],
        activeSegments: [null],
        currentSegment: 'alice',
        currentLevelIndex: -1,
        upPath: null,
        userHome: 'alice',
      });
      expect(pageSidebarLayout('/user/alice/').levelPaths).toEqual(['/user/alice/']);
      expect(pageSidebarLayout('/user/alice/').userHome).toBe('alice');
    });

    it('renders no tree for the member directory itself', () => {
      expect(pageSidebarLayout('/user/')).toEqual({
        levelPaths: [],
        activeSegments: [],
        currentSegment: '',
        currentLevelIndex: -1,
        upPath: null,
        userHome: null,
      });
    });
  });
});

describe('resolveSidebarSelfLink', () => {
  const seg = (over: Partial<PageChildSegment>): PageChildSegment => ({
    segment: 'c',
    path: '/a/b/c/',
    isPage: false,
    hasPortal: false,
    count: 0,
    ...over,
  });

  // /a/b/c → levels aligned with ['/a/', '/a/b/', '/a/b/c/']; the current
  // node `c` is listed at level 1 (children of /a/b/).
  const layout = pageSidebarLayout('/a/b/c');

  it('surfaces the content page as a self-link when the node is a page WITH children', () => {
    const levels: PageChildSegment[][] = [[], [seg({ isPage: true, count: 3 })], []];
    // On the content page itself → the self-link is the current node.
    expect(resolveSidebarSelfLink(layout, levels, '/a/b/c')).toEqual({ contentPath: '/a/b/c', isCurrent: true });
    // On the portal listing → same link, but the folder node stays current.
    expect(resolveSidebarSelfLink(layout, levels, '/a/b/c/')).toEqual({ contentPath: '/a/b/c', isCurrent: false });
  });

  it('returns null for a pure directory (no content page at the node)', () => {
    const levels: PageChildSegment[][] = [[], [seg({ isPage: false, count: 3 })], []];
    expect(resolveSidebarSelfLink(layout, levels, '/a/b/c')).toBeNull();
  });

  it('returns null for a childless leaf page (the node already links to /a/b/c)', () => {
    const levels: PageChildSegment[][] = [[], [seg({ isPage: true, count: 0 })], []];
    expect(resolveSidebarSelfLink(layout, levels, '/a/b/c')).toBeNull();
  });

  it('returns null at the (un-rendered) root where there is no current node', () => {
    const rootLayout = pageSidebarLayout('/');
    expect(resolveSidebarSelfLink(rootLayout, [[]], '/')).toBeNull();
  });
});
