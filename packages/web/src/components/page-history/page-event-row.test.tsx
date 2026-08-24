import type { PageHistoryEventRow } from '@crowi/api-contract';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import enMessages from '../../../messages/en.json';
import jaMessages from '../../../messages/ja.json';
import { PageEventRow } from './page-event-row';

afterEach(cleanup);

const eventRow = (overrides: Partial<PageHistoryEventRow> = {}): PageHistoryEventRow => ({
  id: 'event-1',
  type: 'page_event',
  kind: 'page_renamed',
  payload: { fromPath: '/before', toPath: '/after', redirectCreated: false, subtree: false },
  operationId: null,
  sequence: 1,
  occurredAt: '2026-08-20T00:00:00.000Z',
  actor: null,
  ...overrides,
});

function renderEvent(event: PageHistoryEventRow) {
  return render(
    <table>
      <tbody>
        <PageEventRow event={event} />
      </tbody>
    </table>,
  );
}

describe('PageEventRow detail', () => {
  it('renders both paths for a rename', () => {
    renderEvent(eventRow());

    expect(screen.getByTestId('event-detail')).toHaveTextContent('/before → /after');
  });

  it('renders the redirect badge only when a rename created a redirect', () => {
    const { rerender } = renderEvent(eventRow({ payload: { fromPath: '/before', toPath: '/after', redirectCreated: true, subtree: false } }));

    expect(screen.getByText('リダイレクト')).toBeInTheDocument();

    rerender(
      <table>
        <tbody>
          <PageEventRow event={eventRow()} />
        </tbody>
      </table>,
    );
    expect(screen.queryByText('リダイレクト')).toBeNull();
  });

  it('renders rename detail without reading payload.subtree', () => {
    renderEvent(eventRow({ payload: { fromPath: '/before', toPath: '/after', redirectCreated: false }, subtree: false }));

    expect(screen.getByTestId('event-detail')).toHaveTextContent('/before → /after');
  });

  it('renders only the original path for a trashed page', () => {
    renderEvent(eventRow({ kind: 'page_trashed', payload: { fromPath: '/kept/path', toPath: '/trash/kept/path' } }));
    const detail = within(screen.getByTestId('event-detail'));

    expect(detail.getByText('移動元: /kept/path')).toBeInTheDocument();
    expect(detail.queryByText(/\/trash\/kept\/path/)).toBeNull();
  });

  it('renders only the restored destination for a restored page', () => {
    renderEvent(eventRow({ kind: 'page_restored', payload: { fromPath: '/deleted/a', toPath: '/a' } }));
    const detail = within(screen.getByTestId('event-detail'));

    expect(detail.getByText('復元先: /a')).toBeInTheDocument();
    expect(detail.queryByText(/\/deleted\/a/)).toBeNull();
  });

  it('renders public and link-only visibility labels', () => {
    renderEvent(eventRow({ kind: 'visibility_changed', payload: { fromGrant: 1, toGrant: 2 } }));

    expect(screen.getByTestId('event-detail')).toHaveTextContent('公開 → リンクのみ');
  });

  it('renders specified-user and owner-only visibility labels', () => {
    renderEvent(eventRow({ kind: 'visibility_changed', payload: { fromGrant: 3, toGrant: 4 } }));

    expect(screen.getByTestId('event-detail')).toHaveTextContent('指定ユーザー → 自分のみ');
  });

  it('does not render detail for draft publication', () => {
    renderEvent(eventRow({ kind: 'draft_published', payload: { fromStatus: 'draft', toStatus: 'published' } }));

    expect(screen.queryByTestId('event-detail')).toBeNull();
  });

  it('degrades to the summary when a required payload field is missing', () => {
    renderEvent(eventRow({ payload: { fromPath: '/before' } }));

    expect(screen.getByText('不明なユーザーがページ名を変更しました')).toBeInTheDocument();
    expect(screen.queryByTestId('event-detail')).toBeNull();
  });

  it.each(['page_renamed', 'visibility_changed', 'page_trashed', 'page_restored'] as const)('degrades %s to the summary when payload is null', (kind) => {
    renderEvent(eventRow({ kind, payload: null as unknown as PageHistoryEventRow['payload'] }));

    expect(screen.queryByTestId('event-detail')).toBeNull();
  });

  it('degrades a trashed event to the summary when toPath is missing', () => {
    renderEvent(eventRow({ kind: 'page_trashed', payload: { fromPath: '/a' } }));

    expect(screen.queryByTestId('event-detail')).toBeNull();
  });

  it('degrades a restored event to the summary when toPath is missing', () => {
    renderEvent(eventRow({ kind: 'page_restored', payload: { fromPath: '/deleted/a' } }));

    expect(screen.queryByTestId('event-detail')).toBeNull();
  });

  it('degrades to the summary when either visibility grant is unknown', () => {
    renderEvent(eventRow({ kind: 'visibility_changed', payload: { fromGrant: 1, toGrant: 99 } }));

    expect(screen.getByText('不明なユーザーが公開範囲を変更しました')).toBeInTheDocument();
    expect(screen.queryByTestId('event-detail')).toBeNull();
  });

  it('truncates a long path while preserving the full detail in title', () => {
    const fromPath = `/${'from-segment/'.repeat(20)}page`;
    const toPath = `/${'to-segment/'.repeat(20)}page`;
    renderEvent(eventRow({ payload: { fromPath, toPath, redirectCreated: false, subtree: false } }));

    const detailText = screen.getByTestId('event-detail-text');
    expect(detailText).toHaveClass('truncate');
    expect(detailText).toHaveAttribute('title', `${fromPath} → ${toPath}`);
  });

  it('defines the same message keys in both locale catalogs', () => {
    expect(Object.keys(jaMessages).sort()).toEqual(Object.keys(enMessages).sort());
  });
});
