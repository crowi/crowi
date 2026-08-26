'use client';

import type { PageHistoryContentRow } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { getLocale } from '@paraglide/runtime.js';
import { History as HistoryIcon, Loader2, Terminal } from 'lucide-react';
import Link from 'next/link';
import { Fragment, useMemo, useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { UserAvatar } from '@/components/user-avatar';
import { formatDateTime, formatHistoryDate } from '@/lib/date-utils';
import { usePageHistory } from '@/lib/use-page-history';

import { PageEventRow } from './page-event-row';
import { RevisionDiff } from './revision-diff';

interface PageHistoryProps {
  pageId: string;
  pagePath: string;
}

function ApiEditChip() {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="inline-flex items-center gap-1 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase leading-none text-muted-foreground"
            aria-label={m['page_history.api_update_tooltip']()}
          >
            <Terminal className="h-3 w-3" aria-hidden="true" />
            {m['page_history.api_chip_label']()}
          </span>
        </TooltipTrigger>
        <TooltipContent>{m['page_history.api_update_tooltip']()}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function PageHistory({ pageId, pagePath }: PageHistoryProps) {
  const { entries, tracking, isLoading, isError, error, hasNextPage, isFetchingNextPage, fetchNextPage, refetch } = usePageHistory(pageId);
  const contentRows = useMemo(() => entries.filter((entry): entry is PageHistoryContentRow => entry.type === 'content_revision'), [entries]);
  const contentIndexById = useMemo(() => new Map(contentRows.map((row, index) => [row.id, index])), [contentRows]);
  const trackingBoundaryIndex = useMemo(() => (tracking?.state === 'ready' ? entries.findIndex((entry) => entry.sequence === null) : -1), [entries, tracking]);
  const listFormatter = useMemo(() => {
    const locale = getLocale() === 'ja' ? 'ja-JP' : 'en-US';
    return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' });
  }, []);

  const [selectedFrom, setSelectedFrom] = useState<string | null>(null);
  const [selectedTo, setSelectedTo] = useState<string | null>(null);
  const [selectionPageId, setSelectionPageId] = useState(pageId);
  const [defaultPairInitialized, setDefaultPairInitialized] = useState(false);

  if (selectionPageId !== pageId) {
    setSelectionPageId(pageId);
    setDefaultPairInitialized(false);
    setSelectedFrom(null);
    setSelectedTo(null);
  } else if (!defaultPairInitialized && contentRows.length >= 2) {
    const latest = contentRows[0];
    const previous = contentRows[1];
    setDefaultPairInitialized(true);
    setSelectedFrom(previous.id);
    setSelectedTo(latest.id);
  }

  const selectedFromRow = selectedFrom ? contentRows.find((row) => row.id === selectedFrom) : null;
  const selectedToRow = selectedTo ? contentRows.find((row) => row.id === selectedTo) : null;
  const fromIndex = selectedFrom ? (contentIndexById.get(selectedFrom) ?? -1) : -1;
  const toIndex = selectedTo ? (contentIndexById.get(selectedTo) ?? -1) : -1;

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
          <span className="text-sm">{m['page_history.history_loading']()}</span>
        </div>
      )}

      {isError && (
        <Alert variant="destructive">
          <AlertTitle>{m['page_history.history_failed']()}</AlertTitle>
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
          <AlertTitle>{m['page_history.no_history_title']()}</AlertTitle>
          <AlertDescription>{m['page_history.no_history_body']()}</AlertDescription>
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
                {entries.map((entry, entryIndex) => {
                  const boundary = entryIndex === trackingBoundaryIndex && (
                    <tr className="border-t bg-muted/40">
                      <td colSpan={5} className="px-3 py-2 text-center text-xs font-medium text-muted-foreground">
                        {m['page_history.tracking_boundary']()}
                      </td>
                    </tr>
                  );
                  if (entry.type === 'page_event') {
                    return (
                      <Fragment key={entry.id}>
                        {boundary}
                        <PageEventRow event={entry} />
                      </Fragment>
                    );
                  }

                  const contentIndex = contentIndexById.get(entry.id) ?? -1;
                  const isFrom = selectedFrom === entry.id;
                  const isTo = selectedTo === entry.id;
                  const fromDisabled = isTo || (toIndex !== -1 && contentIndex < toIndex);
                  const toDisabled = isFrom || (fromIndex !== -1 && contentIndex > fromIndex);
                  const savedBy = entry.savedBy ?? entry.actor ?? null;
                  const allContributors = entry.contributors ?? [];
                  const contributors = savedBy ? allContributors.filter((contributor) => contributor._id !== savedBy._id) : allContributors;
                  const contributorNames = listFormatter.format(contributors.map((contributor) => contributor.name));
                  return (
                    <Fragment key={entry.id}>
                      {boundary}
                      <tr className="border-t">
                        <td className="px-3 py-2 text-center">
                          <input
                            type="radio"
                            name="rev-from"
                            value={entry.id}
                            checked={isFrom}
                            disabled={fromDisabled}
                            onChange={() => setSelectedFrom(entry.id)}
                            aria-label={m['page_history.select_from']({ revision: entry.revisionId.slice(-8) })}
                          />
                        </td>
                        <td className="px-3 py-2 text-center">
                          <input
                            type="radio"
                            name="rev-to"
                            value={entry.id}
                            checked={isTo}
                            disabled={toDisabled}
                            onChange={() => setSelectedTo(entry.id)}
                            aria-label={m['page_history.select_to']({ revision: entry.revisionId.slice(-8) })}
                          />
                        </td>
                        <td className="px-3 py-2">
                          {savedBy ? (
                            <div className="flex items-center gap-2">
                              <UserAvatar user={savedBy} size="sm" />
                              <span className="truncate">{savedBy.name}</span>
                              {(entry.editVia === 'oauth' || entry.editVia === 'pat') && <ApiEditChip />}
                              {contributors.length > 0 && (
                                <span className="text-muted-foreground ml-1 text-xs">{m['collab.history_with_others']({ names: contributorNames })}</span>
                              )}
                            </div>
                          ) : (
                            <span className="text-muted-foreground">{m['page_history.unknown_author']()}</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <span title={formatDateTime(entry.occurredAt)}>{formatHistoryDate(entry.occurredAt)}</span>
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">
                          <Link
                            href={`${pagePath}?revision_id=${entry.revisionId}`}
                            className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                            title={m['page_history.open_revision']({ revision: entry.revisionId })}
                          >
                            {entry.revisionId.slice(-8)}
                          </Link>
                        </td>
                      </tr>
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {hasNextPage && (
            <div className="flex items-center justify-end mt-3">
              <Button variant="outline" onClick={() => fetchNextPage()} disabled={isFetchingNextPage} type="button" size="sm">
                {isFetchingNextPage ? m['page_history.loading_more']() : m['page_history.load_more']()}
              </Button>
            </div>
          )}
        </section>
      )}

      {!isLoading && !isError && contentRows.length === 1 && !hasNextPage && (
        <section aria-label={m['page_history.diff_region_label']()}>
          <RevisionDiff fromId={null} toId={contentRows[0].revisionId} />
        </section>
      )}

      {!isLoading && !isError && contentRows.length >= 2 && selectedFromRow && selectedToRow && (
        <section aria-label={m['page_history.diff_region_label']()} className="border-t pt-6">
          <RevisionDiff fromId={selectedFromRow.revisionId} toId={selectedToRow.revisionId} />
        </section>
      )}
    </div>
  );
}
