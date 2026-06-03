import { describe, expect, it } from 'vitest';
import { pageSidebarLayout } from './sidebar-paths';

describe('pageSidebarLayout', () => {
  describe('content page', () => {
    it('expands the ancestry of a deep page, rooted at /space/group/', () => {
      expect(pageSidebarLayout('/crowi/project/hoge/xxx/yyy')).toEqual({
        levelPaths: ['/crowi/project/', '/crowi/project/hoge/', '/crowi/project/hoge/xxx/'],
        activeSegments: ['hoge', 'xxx', 'yyy'],
        currentSegment: 'yyy',
        currentLevelIndex: 2,
        upPath: '/crowi/',
        userHome: null,
      });
    });

    it('shows the parent folder as a node for a shallow page (not just its page list)', () => {
      // Regression: /crowi/rfc/0002 must surface `rfc/` as a node rather
      // than collapsing to the bare page list under an "⤴ crowi".
      expect(pageSidebarLayout('/crowi/rfc/0002-renderer')).toEqual({
        levelPaths: ['/crowi/', '/crowi/rfc/'],
        activeSegments: ['rfc', '0002-renderer'],
        currentSegment: '0002-renderer',
        currentLevelIndex: 1,
        upPath: '/',
        userHome: null,
      });
    });

    it('shows the containing space as a node for a 2-segment page', () => {
      expect(pageSidebarLayout('/crowi/foo')).toEqual({
        levelPaths: ['/', '/crowi/'],
        activeSegments: ['crowi', 'foo'],
        currentSegment: 'foo',
        currentLevelIndex: 1,
        upPath: null,
        userHome: null,
      });
    });

    it('has no ⤴ for a page directly under the top page', () => {
      expect(pageSidebarLayout('/foo')).toEqual({
        levelPaths: ['/'],
        activeSegments: ['foo'],
        currentSegment: 'foo',
        currentLevelIndex: 0,
        upPath: null,
        userHome: null,
      });
    });
  });

  describe('portal page', () => {
    it('highlights AND expands the current directory, keeping ancestors/siblings', () => {
      // The fix for "clicking a portal collapses the tree": a portal page
      // gets one more level than its content-page sibling, so its own
      // children show below the highlighted directory.
      expect(pageSidebarLayout('/almoha/weall/dev/ops/')).toEqual({
        levelPaths: ['/almoha/weall/', '/almoha/weall/dev/', '/almoha/weall/dev/ops/'],
        // dev expands toward ops; ops is the current node; its own level
        // has no further active child (just lists ops's children).
        activeSegments: ['dev', 'ops', null],
        currentSegment: 'ops',
        currentLevelIndex: 1,
        upPath: '/almoha/',
        userHome: null,
      });
    });

    it('is consistent with the matching content page one level shallower', () => {
      // /a/b/c/ (portal) and /a/b/c/d (page) share the same ancestry; the
      // portal just has currentLevelIndex one shallower (the dir itself).
      const portal = pageSidebarLayout('/a/b/c/');
      expect(portal.levelPaths).toEqual(['/a/b/', '/a/b/c/']);
      expect(portal.currentSegment).toBe('c');
      expect(portal.currentLevelIndex).toBe(0);
      expect(portal.upPath).toBe('/a/');
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
    it('tops a deep user page with the user home (no ⤴) and roots at /user/{username}/', () => {
      expect(pageSidebarLayout('/user/alice/diary/2026/05/23')).toEqual({
        levelPaths: ['/user/alice/', '/user/alice/diary/', '/user/alice/diary/2026/', '/user/alice/diary/2026/05/'],
        activeSegments: ['diary', '2026', '05', '23'],
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
