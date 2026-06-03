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
      });
    });

    it('roots at the space for a 2-segment page and points ⤴ to the top', () => {
      expect(pageSidebarLayout('/crowi/foo')).toEqual({
        levelPaths: ['/crowi/'],
        activeSegments: ['foo'],
        currentSegment: 'foo',
        currentLevelIndex: 0,
        upPath: '/',
      });
    });

    it('has no ⤴ for a page directly under the top page', () => {
      expect(pageSidebarLayout('/foo')).toEqual({
        levelPaths: ['/'],
        activeSegments: ['foo'],
        currentSegment: 'foo',
        currentLevelIndex: 0,
        upPath: null,
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
      });
    });
  });
});
