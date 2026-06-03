import { describe, expect, it } from 'vitest';
import { singleSidebarLayout } from './sidebar-paths';

describe('singleSidebarLayout', () => {
  it('expands the ancestry of a deep page, rooted at /space/group/', () => {
    expect(singleSidebarLayout('/crowi/project/hoge/xxx/yyy')).toEqual({
      levelPaths: ['/crowi/project/', '/crowi/project/hoge/', '/crowi/project/hoge/xxx/'],
      activeSegments: ['hoge', 'xxx', 'yyy'],
      currentSegment: 'yyy',
      upPath: '/crowi/',
    });
  });

  it('roots no deeper than the directory containing the page (3-segment page)', () => {
    // /crowi/rfc/0001 — the page lives directly under /crowi/rfc/, so the
    // root is /crowi/rfc/ and ⤴ goes up to /crowi/.
    expect(singleSidebarLayout('/crowi/rfc/0001')).toEqual({
      levelPaths: ['/crowi/rfc/'],
      activeSegments: ['0001'],
      currentSegment: '0001',
      upPath: '/crowi/',
    });
  });

  it('roots at the space for a 2-segment page and points ⤴ to the top', () => {
    expect(singleSidebarLayout('/crowi/foo')).toEqual({
      levelPaths: ['/crowi/'],
      activeSegments: ['foo'],
      currentSegment: 'foo',
      upPath: '/',
    });
  });

  it('has no ⤴ for a page directly under the top page', () => {
    expect(singleSidebarLayout('/foo')).toEqual({
      levelPaths: ['/'],
      activeSegments: ['foo'],
      currentSegment: 'foo',
      upPath: null,
    });
  });
});
