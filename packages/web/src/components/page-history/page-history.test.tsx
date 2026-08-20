import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type PropsWithChildren } from 'react';
import type { PageHistoryContentRow, PageHistoryEntry, PageHistoryEventRow } from '@crowi/api-contract';
import { PageHistory } from './page-history';

const usePageHistoryMock = vi.fn();
vi.mock('@/lib/use-page-history', () => ({
  usePageHistory: () => usePageHistoryMock(),
}));
vi.mock('./revision-diff', () => ({
  RevisionDiff: ({ fromId, toId }: { fromId: string | null; toId: string }) => <output data-testid="revision-diff">{`${fromId ?? 'empty'}:${toId}`}</output>,
}));

afterEach(() => {
  cleanup();
  usePageHistoryMock.mockReset();
});

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return function Wrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

const baseContentRow = (overrides: Partial<PageHistoryContentRow> = {}): PageHistoryContentRow => ({
  id: overrides.id ?? 'content-1',
  type: 'content_revision',
  revisionId: overrides.revisionId ?? 'rev-1',
  sequence: overrides.sequence ?? 1,
  occurredAt: overrides.occurredAt ?? '2026-08-20T00:00:00.000Z',
  actor: overrides.actor ?? null,
  pending: overrides.pending,
});

const baseEventRow = (overrides: Partial<PageHistoryEventRow> = {}): PageHistoryEventRow => ({
  id: overrides.id ?? 'event-1',
  type: 'page_event',
  kind: overrides.kind ?? 'page_renamed',
  payload: overrides.payload ?? {},
  operationId: overrides.operationId ?? null,
  sequence: overrides.sequence ?? 1,
  occurredAt: overrides.occurredAt ?? '2026-08-20T00:00:00.000Z',
  actor: overrides.actor ?? null,
  subtree: overrides.subtree,
  pending: overrides.pending,
});

function mockHistory(entries: PageHistoryEntry[], overrides: Partial<ReturnType<typeof usePageHistoryMock>> = {}) {
  usePageHistoryMock.mockReturnValue({
    entries,
    tracking: null,
    isLoading: false,
    isError: false,
    error: null,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
    ...overrides,
  });
}

describe('PageHistory merged timeline', () => {
  it('renders metadata events without a subtree badge when no subtree operation exists', () => {
    mockHistory([
      baseEventRow({ id: 'rename-event', kind: 'page_renamed', actor: null }),
      baseContentRow({ id: 'content-new', revisionId: 'rev-new' }),
      baseContentRow({ id: 'content-old', revisionId: 'rev-old' }),
    ]);

    render(createElement(PageHistory, { pageId: 'page-1', pagePath: '/some/page' }), { wrapper: makeWrapper() });

    expect(screen.getByText('不明なユーザーがページ名を変更しました')).toBeDefined();
    expect(screen.queryByText('サブツリー')).toBeNull();
    expect(screen.getByTestId('revision-diff')).toHaveTextContent('rev-old:rev-new');
  });

  it('keeps metadata rows out of revision selection and uses stable content ids for the default pair', () => {
    mockHistory([
      baseContentRow({ id: 'content-new', revisionId: 'revision-new' }),
      baseEventRow({ id: 'event-between', kind: 'visibility_changed' }),
      baseContentRow({ id: 'content-old', revisionId: 'revision-old' }),
    ]);

    render(createElement(PageHistory, { pageId: 'page-1', pagePath: '/some/page' }), { wrapper: makeWrapper() });

    expect(screen.getAllByRole('radio')).toHaveLength(4);
    expect(screen.queryByRole('radio', { name: /event-between/i })).toBeNull();
    expect(screen.getByTestId('revision-diff')).toHaveTextContent('revision-old:revision-new');
    const selectedTo = screen.getByRole('radio', { name: 'Select revision sion-new as to' });
    const selectedFrom = screen.getByRole('radio', { name: 'Select revision sion-old as from' });
    expect(selectedTo).toBeChecked();
    expect((selectedTo as HTMLInputElement).value).toBe('content-new');
    expect(selectedFrom).toBeChecked();
    expect((selectedFrom as HTMLInputElement).value).toBe('content-old');
  });

  it('initializes a default pair after loading an older content row on the next page', () => {
    mockHistory([baseContentRow({ id: 'content-new', revisionId: 'revision-new' })], { hasNextPage: true });

    const { rerender } = render(createElement(PageHistory, { pageId: 'page-1', pagePath: '/some/page' }), { wrapper: makeWrapper() });
    expect(screen.getByTestId('revision-diff')).toHaveTextContent('empty:revision-new');

    mockHistory([baseContentRow({ id: 'content-new', revisionId: 'revision-new' }), baseContentRow({ id: 'content-old', revisionId: 'revision-old' })]);
    rerender(createElement(PageHistory, { pageId: 'page-1', pagePath: '/some/page' }));

    expect(screen.getByTestId('revision-diff')).toHaveTextContent('revision-old:revision-new');
  });

  it('loads the next page of timeline entries', () => {
    const fetchNextPage = vi.fn();
    mockHistory([baseContentRow({ id: 'content-new', revisionId: 'revision-new' })], { hasNextPage: true, fetchNextPage });

    render(createElement(PageHistory, { pageId: 'page-1', pagePath: '/some/page' }), { wrapper: makeWrapper() });
    fireEvent.click(screen.getByRole('button', { name: '履歴をさらに読み込む' }));

    expect(fetchNextPage).toHaveBeenCalledOnce();
  });
});
