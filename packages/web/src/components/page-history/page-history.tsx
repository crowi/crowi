'use client';

import type { PageHistoryContentRow } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { GitCompare, History as HistoryIcon, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/user-avatar';
import { formatDateTime, formatDistanceToNow } from '@/lib/date-utils';
import { usePageHistory } from '@/lib/use-page-history';

import { PageEventRow } from './page-event-row';
import { RevisionDiff } from './revision-diff';

interface PageHistoryProps {
  pageId: string;
  pagePath: string;
}

export function PageHistory({ pageId, pagePath }: PageHistoryProps) {
  const { entries, isLoading, isError, error, hasNextPage, isFetchingNextPage, fetchNextPage, refetch } = usePageHistory(pageId);
  const contentRows = useMemo(() => entries.filter((entry): entry is PageHistoryContentRow => entry.type === 'content_revision'), [entries]);

  const [pendingFrom, setPendingFrom] = useState<string | null>(null);
  const [pendingTo, setPendingTo] = useState<string | null>(null);
  const [activePair, setActivePair] = useState<{ from: string; to: string } | null>(null);
  const [initializedFor, setInitializedFor] = useState('');

  const contentSetKey = contentRows.map((row) => row.id).join('\u0000');
  if (contentSetKey !== initializedFor) {
    const latest = contentRows[0] ?? null;
    const previous = contentRows[1] ?? null;
    setInitializedFor(contentSetKey);
    if (latest && previous) {
      setPendingFrom(previous.id);
      setPendingTo(latest.id);
      setActivePair({ from: previous.revisionId, to: latest.revisionId });
    } else if (latest) {
      setPendingFrom(null);
      setPendingTo(latest.id);
      setActivePair(null);
    } else {
      setPendingFrom(null);
      setPendingTo(null);
      setActivePair(null);
    }
  }

  const canCompare = Boolean(pendingFrom && pendingTo && pendingFrom !== pendingTo);
  const pendingFromRow = pendingFrom ? contentRows.find((row) => row.id === pendingFrom) : null;
  const pendingToRow = pendingTo ? contentRows.find((row) => row.id === pendingTo) : null;
  const fromIndex = pendingFrom ? contentRows.findIndex((row) => row.id === pendingFrom) : -1;
  const toIndex = pendingTo ? contentRows.findIndex((row) => row.id === pendingTo) : -1;
  const isPairDirty = canCompare && (!activePair || activePair.from !== pendingFromRow?.revisionId || activePair.to !== pendingToRow?.revisionId);

  const handleCompare = () => {
    if (!pendingFromRow || !pendingToRow || pendingFromRow.id === pendingToRow.id) return;
    setActivePair({ from: pendingFromRow.revisionId, to: pendingToRow.revisionId });
  };

  return (
    <div className="space-y-6">
      <header className="border-b pb-4">
        <div className="flex items-center gap-2">
          <HistoryIcon className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-2xl font-bold">{m['page_history.heading']()}</h1>
        </div>
        <p className="text-muted-foreground text-sm mt-1 truncate">{pagePath}</p>
      </header>

      {isLoading && (
        <div className="flex items-center gap-2 text-muted-foreground py-6" role="status">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">{m['page_history.revisions_loading']()}</span>
        </div>
      )}

      {isError && (
        <Alert variant="destructive">
          <AlertTitle>{m['page_history.revisions_failed']()}</AlertTitle>
          <AlertDescription>
            {error?.message ?? m['common.try_again_later']()}
            <div className="mt-3">
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                {m['common.retry']()}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {!isLoading && !isError && entries.length === 0 && (
        <Alert>
          <AlertTitle>{m['page_history.no_revisions_title']()}</AlertTitle>
          <AlertDescription>{m['page_history.no_revisions_body']()}</AlertDescription>
        </Alert>
      )}

      {!isLoading && !isError && entries.length > 0 && (
        <section aria-label={m['page_history.timeline_label']()}>
          <div className="rounded-md border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 text-center font-medium w-16">
                    {m['page_history.col_from']()}
                  </th>
                  <th scope="col" className="px-3 py-2 text-center font-medium w-16">
                    {m['page_history.col_to']()}
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    {m['page_history.col_author']()}
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    {m['page_history.col_created']()}
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    {m['page_history.col_revision']()}
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  if (entry.type === 'page_event') return <PageEventRow key={entry.id} event={entry} />;

                  const contentIndex = contentRows.findIndex((row) => row.id === entry.id);
                  const isFrom = pendingFrom === entry.id;
                  const isTo = pendingTo === entry.id;
                  const fromDisabled = isTo || (toIndex !== -1 && contentIndex < toIndex);
                  const toDisabled = isFrom || (fromIndex !== -1 && contentIndex > fromIndex);
                  return (
                    <tr key={entry.id} className="border-t">
                      <td className="px-3 py-2 text-center">
                        <input
                          type="radio"
                          name="rev-from"
                          value={entry.id}
                          checked={isFrom}
                          disabled={fromDisabled}
                          onChange={() => setPendingFrom(entry.id)}
                          aria-label={`Select revision ${entry.revisionId.slice(-8)} as from`}
                        />
                      </td>
                      <td className="px-3 py-2 text-center">
                        <input
                          type="radio"
                          name="rev-to"
                          value={entry.id}
                          checked={isTo}
                          disabled={toDisabled}
                          onChange={() => setPendingTo(entry.id)}
                          aria-label={`Select revision ${entry.revisionId.slice(-8)} as to`}
                        />
                      </td>
                      <td className="px-3 py-2">
                        {entry.actor ? (
                          <div className="flex items-center gap-2">
                            <UserAvatar user={entry.actor} size="sm" />
                            <span className="truncate">{entry.actor.name}</span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">{m['page_history.unknown_user']()}</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span title={formatDateTime(entry.occurredAt)}>{formatDistanceToNow(entry.occurredAt)}</span>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">
                        <Link
                          href={`${pagePath}?revision_id=${entry.revisionId}`}
                          className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                          title={`Open revision ${entry.revisionId}`}
                        >
                          {entry.revisionId.slice(-8)}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-end gap-2 mt-3">
            {hasNextPage && (
              <Button variant="outline" onClick={() => fetchNextPage()} disabled={isFetchingNextPage} type="button" size="sm">
                {isFetchingNextPage ? m['page_history.loading_more']() : m['page_history.load_more']()}
              </Button>
            )}
            {contentRows.length >= 2 && (
              <Button onClick={handleCompare} disabled={!canCompare} type="button" size="sm">
                <GitCompare className="h-4 w-4 mr-1" />
                {isPairDirty ? m['page_history.update_diff']() : m['page_history.compare']()}
              </Button>
            )}
          </div>
        </section>
      )}

      {!isLoading && !isError && contentRows.length === 1 && (
        <section aria-label="Revision diff">
          <RevisionDiff fromId={null} toId={contentRows[0].revisionId} />
        </section>
      )}

      {!isLoading && !isError && contentRows.length >= 2 && activePair && (
        <section aria-label="Revision diff" className="border-t pt-6">
          <RevisionDiff fromId={activePair.from} toId={activePair.to} />
        </section>
      )}
    </div>
  );
}
