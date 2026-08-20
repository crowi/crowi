import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type PropsWithChildren } from 'react';
import type { PageHistoryContentRow, PageHistoryEntry, PageHistoryEventRow, PageUser } from '@crowi/api-contract';
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

type ContentRowFixture = PageHistoryContentRow & {
  savedBy?: PageUser | null;
  contributors?: PageUser[];
  editVia?: 'web' | 'oauth' | 'pat';
};

const baseUser = (id: string, name: string): PageUser => ({
  _id: id,
  id,
  username: name.toLowerCase(),
  name,
  email: `${name.toLowerCase()}@example.com`,
  image: null,
  createdAt: '2026-08-20T00:00:00.000Z',
});

const baseContentRow = (overrides: Partial<ContentRowFixture> = {}): ContentRowFixture => ({
  id: overrides.id ?? 'content-1',
  type: 'content_revision',
  revisionId: overrides.revisionId ?? 'rev-1',
  sequence: overrides.sequence === undefined ? 1 : overrides.sequence,
  occurredAt: overrides.occurredAt ?? '2026-08-20T00:00:00.000Z',
  actor: overrides.actor ?? null,
  savedBy: overrides.savedBy,
  contributors: overrides.contributors,
  editVia: overrides.editVia,
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
    tracking: { state: 'untracked' },
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
    const selectedTo = screen.getByRole('radio', { name: 'リビジョン sion-new を To に選択' });
    const selectedFrom = screen.getByRole('radio', { name: 'リビジョン sion-old を From に選択' });
    expect(selectedTo).toBeChecked();
    expect((selectedTo as HTMLInputElement).value).toBe('content-new');
    expect(selectedFrom).toBeChecked();
    expect((selectedFrom as HTMLInputElement).value).toBe('content-old');
  });

  it('initializes a default pair after loading an older content row on the next page', () => {
    mockHistory([baseContentRow({ id: 'content-new', revisionId: 'revision-new' })], { hasNextPage: true });

    const { rerender } = render(createElement(PageHistory, { pageId: 'page-1', pagePath: '/some/page' }), { wrapper: makeWrapper() });
    expect(screen.queryByTestId('revision-diff')).toBeNull();

    mockHistory([baseContentRow({ id: 'content-new', revisionId: 'revision-new' }), baseContentRow({ id: 'content-old', revisionId: 'revision-old' })]);
    rerender(createElement(PageHistory, { pageId: 'page-1', pagePath: '/some/page' }));

    expect(screen.getByTestId('revision-diff')).toHaveTextContent('revision-old:revision-new');
  });

  it('compares a lone content row against empty only after pagination is exhausted', () => {
    mockHistory([baseContentRow({ id: 'content-only', revisionId: 'revision-only' })]);

    render(createElement(PageHistory, { pageId: 'page-1', pagePath: '/some/page' }), { wrapper: makeWrapper() });

    expect(screen.getByTestId('revision-diff')).toHaveTextContent('empty:revision-only');
  });

  it('keeps a manually compared pair when an older page appends more content rows', () => {
    mockHistory([
      baseContentRow({ id: 'content-new', revisionId: 'revision-new' }),
      baseContentRow({ id: 'content-middle', revisionId: 'revision-middle' }),
      baseContentRow({ id: 'content-old', revisionId: 'revision-old' }),
    ]);

    const { rerender } = render(createElement(PageHistory, { pageId: 'page-1', pagePath: '/some/page' }), { wrapper: makeWrapper() });
    fireEvent.click(screen.getByRole('radio', { name: 'リビジョン sion-old を From に選択' }));
    fireEvent.click(screen.getByRole('button', { name: '差分を更新' }));
    expect(screen.getByTestId('revision-diff')).toHaveTextContent('revision-old:revision-new');

    mockHistory([
      baseContentRow({ id: 'content-new', revisionId: 'revision-new' }),
      baseContentRow({ id: 'content-middle', revisionId: 'revision-middle' }),
      baseContentRow({ id: 'content-old', revisionId: 'revision-old' }),
      baseContentRow({ id: 'content-ancient', revisionId: 'revision-ancient' }),
    ]);
    rerender(createElement(PageHistory, { pageId: 'page-1', pagePath: '/some/page' }));

    expect(screen.getByTestId('revision-diff')).toHaveTextContent('revision-old:revision-new');
    expect(screen.getByRole('radio', { name: 'リビジョン sion-old を From に選択' })).toBeChecked();
  });

  it('disables choices that would invert the older-to-newer diff direction', () => {
    mockHistory([
      baseContentRow({ id: 'content-new', revisionId: 'revision-new' }),
      baseContentRow({ id: 'content-middle', revisionId: 'revision-middle' }),
      baseContentRow({ id: 'content-old', revisionId: 'revision-old' }),
    ]);

    render(createElement(PageHistory, { pageId: 'page-1', pagePath: '/some/page' }), { wrapper: makeWrapper() });

    expect(screen.getByRole('radio', { name: 'リビジョン sion-new を From に選択' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'リビジョン sion-old を To に選択' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'リビジョン sion-old を From に選択' })).toBeEnabled();
    expect(screen.getByRole('radio', { name: 'リビジョン sion-new を To に選択' })).toBeEnabled();
  });

  it('shows the tracking boundary before legacy content rows', () => {
    mockHistory(
      [
        baseContentRow({ id: 'tracked', revisionId: 'revision-tracked', sequence: 1 }),
        baseContentRow({ id: 'legacy', revisionId: 'revision-legacy', sequence: null }),
      ],
      { tracking: { state: 'ready', trackingStartedAt: '2026-08-20T00:00:00.000Z' } },
    );

    render(createElement(PageHistory, { pageId: 'page-1', pagePath: '/some/page' }), { wrapper: makeWrapper() });

    expect(screen.getByText('これより前は記録開始前の履歴です')).toBeDefined();
  });

  it('preserves saved-by, contributors, and API-token attribution on content rows', () => {
    const alice = baseUser('alice-id', 'Alice');
    const bob = baseUser('bob-id', 'Bob');
    mockHistory([
      baseContentRow({ id: 'content-new', revisionId: 'revision-new', actor: bob, savedBy: alice, contributors: [alice, bob], editVia: 'oauth' }),
      baseContentRow({ id: 'content-old', revisionId: 'revision-old', actor: bob }),
    ]);

    render(createElement(PageHistory, { pageId: 'page-1', pagePath: '/some/page' }), { wrapper: makeWrapper() });

    expect(screen.getByText('Alice')).toBeDefined();
    const withOthers = screen.getByText('(Bob と共同)');
    expect(withOthers.textContent).not.toContain('Alice');
    expect(screen.getByLabelText('OAuth トークンを用いた API 経由での更新です')).toBeDefined();
  });

  it('links each content row to its revision deep link', () => {
    mockHistory([baseContentRow({ id: 'content-new', revisionId: 'revision-new' }), baseContentRow({ id: 'content-old', revisionId: 'revision-old' })]);

    render(createElement(PageHistory, { pageId: 'page-1', pagePath: '/some/page' }), { wrapper: makeWrapper() });

    expect(screen.getByRole('link', { name: 'sion-new' })).toHaveAttribute('href', '/some/page?revision_id=revision-new');
  });

  it('loads the next page of timeline entries', () => {
    const fetchNextPage = vi.fn();
    mockHistory([baseContentRow({ id: 'content-new', revisionId: 'revision-new' })], { hasNextPage: true, fetchNextPage });

    render(createElement(PageHistory, { pageId: 'page-1', pagePath: '/some/page' }), { wrapper: makeWrapper() });
    fireEvent.click(screen.getByRole('button', { name: '履歴をさらに読み込む' }));

    expect(fetchNextPage).toHaveBeenCalledOnce();
  });
});
