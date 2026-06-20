import { describe, expect, it } from 'vitest';
import { pageSidebarLayout } from './sidebar-paths';

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
