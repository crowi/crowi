import type { PageChildSegment } from '@crowi/api-contract';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The month expansion's rendering half. `sidebar-paths.test.ts` pins which
 * path has a month and how a deep response is grouped; this pins what the
 * tree does with that — which days open, where each day's rows come from,
 * and what depth each level is fetched at.
 */

const { usePageChildrenLevels } = vi.hoisted(() => ({ usePageChildrenLevels: vi.fn() }));
vi.mock('@/lib/use-page-children', () => ({ usePageChildrenLevels }));

import { SidebarTree } from './sidebar-tree';

const dir = (path: string, count = 1): PageChildSegment => ({
  segment: path.replace(/\/$/, '').split('/').pop() as string,
  path,
  isPage: false,
  hasPortal: false,
  count,
});

const page = (path: string): PageChildSegment => ({ ...dir(path, 0), isPage: true });

/** A directory that exists only because a portal page was saved at it. */
const emptyDir = (path: string): PageChildSegment => ({ ...dir(path, 0), hasPortal: true });

/** Serve `levels` positionally, and record the depth asked for at each level. */
const serveLevels = (levels: PageChildSegment[][]) => {
  const requestedDepths: number[][] = [];
  usePageChildrenLevels.mockImplementation((_paths: string[], depths: number[] = []) => {
    requestedDepths.push(depths);
    return levels.map((children) => ({ data: { children }, isLoading: false }));
  });
  return { lastDepths: () => requestedDepths[requestedDepths.length - 1] };
};

beforeEach(() => usePageChildrenLevels.mockReset());
afterEach(cleanup);

describe('SidebarTree inside a date hierarchy', () => {
  // /s/2026/08/07/report → levels ['/s/2026/', '/s/2026/08/', '/s/2026/08/07/',
  // '/s/2026/08/07/report/'], with the month at index 1.
  const monthLevels = () => [
    [dir('/s/2026/08/', 3)],
    // The month, fetched two deep: every day AND the pages inside them.
    [dir('/s/2026/08/03/'), page('/s/2026/08/03/spec/'), dir('/s/2026/08/07/'), page('/s/2026/08/07/report/'), emptyDir('/s/2026/08/09/')],
    [page('/s/2026/08/07/report/')],
    [],
  ];

  it("opens a day the viewer is NOT on, from the month level's deeper rows", () => {
    serveLevels(monthLevels());
    render(<SidebarTree path="/s/2026/08/07/report" />);
    expect(screen.getByText('spec')).toBeTruthy();
  });

  it('renders the active day from its own level, not twice', () => {
    serveLevels(monthLevels());
    render(<SidebarTree path="/s/2026/08/07/report" />);
    // `report` reaches the tree from two sources — the month's deep rows and
    // the day's own level. Only the latter may draw it, or the current node
    // would appear twice with one copy unhighlighted.
    const rows = screen.getAllByText('report');
    expect(rows).toHaveLength(1);
    expect(rows[0].closest('a')?.getAttribute('aria-current')).toBe('page');
  });

  it('leaves a day that holds no pages as a bare row', () => {
    serveLevels(monthLevels());
    render(<SidebarTree path="/s/2026/08/07/report" />);
    expect(screen.getByText('09/')).toBeTruthy();
  });

  it('asks for depth 2 at the month level and 1 everywhere else', () => {
    const { lastDepths } = serveLevels(monthLevels());
    render(<SidebarTree path="/s/2026/08/07/report" />);
    expect(lastDepths()).toEqual([1, 2, 1, 1]);
  });

  it('expands nothing extra at a year node — there is no month yet', () => {
    // /s/2026/ → levels ['/', '/s/', '/s/2026/'], no month anywhere.
    const { lastDepths } = serveLevels([[dir('/s/')], [dir('/s/2026/')], [dir('/s/2026/08/'), dir('/s/2026/09/')]]);
    render(<SidebarTree path="/s/2026/" />);
    expect(lastDepths()).toEqual([1, 1, 1]);
    expect(screen.getByText('08/')).toBeTruthy();
    // The months are listed, but nothing below them is.
    expect(screen.queryByText('03/')).toBeNull();
  });
});
