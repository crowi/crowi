import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { createElement } from 'react';
import type { Revision } from '@crowi/api-contract';
import { RevisionDiff } from './revision-diff';

// The real diff viewer depends on @emotion + a web worker and is loaded via
// `next/dynamic`; stub it with a component that surfaces the props we care
// about (`showDiffOnly` / `extraLinesSurroundingDiff`) as data attributes so
// the toggle test can assert on them without needing the real diff computation.
vi.mock('react-diff-viewer-continued', () => ({
  DiffMethod: { LINES: 'LINES' },
  default: (props: { showDiffOnly?: boolean; extraLinesSurroundingDiff?: number }) => (
    <div
      data-testid="diff-viewer"
      data-show-diff-only={String(props.showDiffOnly)}
      data-extra-lines-surrounding-diff={String(props.extraLinesSurroundingDiff)}
    />
  ),
}));

const useRevisionPairMock = vi.fn();
vi.mock('@/lib/use-page-revisions', () => ({
  useRevisionPair: (...args: unknown[]) => useRevisionPairMock(...args),
}));

afterEach(() => {
  cleanup();
  useRevisionPairMock.mockReset();
});

const baseRevision = (overrides: Partial<Revision>): Revision => ({
  _id: overrides._id ?? 'rev-1',
  path: '/some/page',
  body: overrides.body ?? '',
  format: 'markdown',
  createdAt: overrides.createdAt ?? new Date().toISOString(),
  ...overrides,
});

function mockRevisions(revisions: Revision[]) {
  useRevisionPairMock.mockReturnValue({
    revisions,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  });
}

describe('RevisionDiff fold toggle', () => {
  it('defaults to fold view (showDiffOnly=true) and flips to showAllLines on toggle click', async () => {
    mockRevisions([baseRevision({ _id: 'rev-A', body: 'line1\nline2\nline3\n' }), baseRevision({ _id: 'rev-B', body: 'line1\nCHANGED\nline3\n' })]);

    render(createElement(RevisionDiff, { fromId: 'rev-A', toId: 'rev-B' }));

    const viewer = await screen.findByTestId('diff-viewer');
    expect(viewer.dataset.showDiffOnly).toBe('true');
    expect(viewer.dataset.extraLinesSurroundingDiff).toBe('3');

    fireEvent.click(screen.getByRole('button', { name: '変更のない行も全て表示' }));

    expect((await screen.findByTestId('diff-viewer')).dataset.showDiffOnly).toBe('false');
    expect(screen.getByRole('button', { name: '変更のある行のみ表示' })).toBeDefined();

    // Toggling back returns to the fold view.
    fireEvent.click(screen.getByRole('button', { name: '変更のある行のみ表示' }));
    expect((await screen.findByTestId('diff-viewer')).dataset.showDiffOnly).toBe('true');
  });

  it('works the same way in unified view (split/unified toggle is independent of the fold toggle)', async () => {
    mockRevisions([baseRevision({ _id: 'rev-A', body: 'line1\nline2\n' }), baseRevision({ _id: 'rev-B', body: 'line1\nCHANGED\n' })]);

    render(createElement(RevisionDiff, { fromId: 'rev-A', toId: 'rev-B' }));
    await screen.findByTestId('diff-viewer');

    // Switch to unified view first.
    fireEvent.click(screen.getByRole('button', { name: '統合表示' }));
    expect(screen.getByRole('button', { name: '並列表示' })).toBeDefined();

    // Fold toggle still works after the view-mode switch.
    fireEvent.click(screen.getByRole('button', { name: '変更のない行も全て表示' }));
    expect((await screen.findByTestId('diff-viewer')).dataset.showDiffOnly).toBe('false');
  });

  it('resets showAllLines back to fold view when the revision pair changes (no key remount)', async () => {
    mockRevisions([
      baseRevision({ _id: 'rev-A', body: 'line1\nline2\nline3\n' }),
      baseRevision({ _id: 'rev-B', body: 'line1\nCHANGED\nline3\n' }),
      baseRevision({ _id: 'rev-C', body: 'line1\nline2\nOTHER\n' }),
    ]);

    const { rerender } = render(createElement(RevisionDiff, { fromId: 'rev-A', toId: 'rev-B' }));

    fireEvent.click(await screen.findByRole('button', { name: '変更のない行も全て表示' }));
    expect((await screen.findByTestId('diff-viewer')).dataset.showDiffOnly).toBe('false');

    // RevisionDiff is not remounted (page-history.tsx renders it without a
    // `key`), so the parent switching to a different revision pair must be
    // what resets the "show all lines" choice — otherwise it would leak into
    // an unrelated comparison.
    rerender(createElement(RevisionDiff, { fromId: 'rev-A', toId: 'rev-C' }));

    expect((await screen.findByTestId('diff-viewer')).dataset.showDiffOnly).toBe('true');
    expect(screen.getByRole('button', { name: '変更のない行も全て表示' })).toBeDefined();
  });

  it('shows a "no changes" message instead of the diff container for an identical revision pair', async () => {
    mockRevisions([baseRevision({ _id: 'rev-A', body: 'same\nbody\n' }), baseRevision({ _id: 'rev-B', body: 'same\nbody\n' })]);

    render(createElement(RevisionDiff, { fromId: 'rev-A', toId: 'rev-B' }));

    expect(await screen.findByText('このリビジョン間に変更はありません')).toBeDefined();
    expect(screen.queryByTestId('diff-viewer')).toBeNull();
    // The fold/show-all toggle is meaningless with no diff to fold, so it
    // is hidden; the split/unified toggle still applies.
    expect(screen.queryByRole('button', { name: '変更のない行も全て表示' })).toBeNull();
    expect(screen.getByRole('button', { name: '統合表示' })).toBeDefined();
  });
});
