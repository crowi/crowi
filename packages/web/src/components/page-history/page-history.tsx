'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { GitCompare, History as HistoryIcon, Loader2, Terminal } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { UserAvatar } from '@/components/user-avatar';
import { formatDateTime, formatDistanceToNow } from '@/lib/date-utils';
import { usePageRevisions } from '@/lib/use-page-revisions';
import { RevisionDiff } from './revision-diff';
import { m } from '@paraglide/messages.js';
import { getLocale } from '@paraglide/runtime.js';

interface PageHistoryProps {
  pageId: string;
  pagePath: string;
}

/**
 * Small "app" chip shown next to the author when a revision was authored
 * through the API with an access token (`editVia` of `oauth` / `pat`), as
 * opposed to the browser / collaborative editor. RFC-0010. Self-contained
 * `TooltipProvider` so it can drop into the history table (which has none).
 */
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

/**
 * History list + diff viewer for a single page.
 * - Defaults `from` to the second-newest revision and `to` to the newest, so
 *   opening the screen on a page with two or more revisions immediately shows
 *   the most recent change.
 * - The user can pick any pair via radio buttons and press Compare to refresh
 *   the diff viewer below.
 */
export function PageHistory({ pageId, pagePath }: PageHistoryProps) {
  const { revisions, isLoading, isError, error, refetch } = usePageRevisions(pageId);

  // Locale-aware joiner for the contributors list ("Alice, Bob, and
  // Carol" in en, 「Alice、Bob、Carol」 in ja). Memoised against the
  // current locale so we don't allocate a fresh formatter per render.
  const listFormatter = useMemo(() => {
    const locale = getLocale() === 'ja' ? 'ja-JP' : 'en-US';
    return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' });
  }, []);

  // 一覧上の選択状態 (まだ Compare を押していない)
  const [pendingFrom, setPendingFrom] = useState<string | null>(null);
  const [pendingTo, setPendingTo] = useState<string | null>(null);
  // 実際に diff viewer に渡す pair
  const [activePair, setActivePair] = useState<{ from: string; to: string } | null>(null);
  // どの一覧 (revisions の最新 _id) に対してデフォルト選択を初期化済みかを記録。
  // revisions が refetch などで切り替わった際にも追従できるようにする。
  const [initializedFor, setInitializedFor] = useState<string | null>(null);

  // 初回 (もしくは revisions の中身が変わった時) にデフォルト選択をセット。
  // React 19 ではエフェクトでの setState はアンチパターンなので、
  // 描画時に「変更を検知したら反映する」スタイルで行う。
  const newestId = revisions[0]?._id ?? null;
  if (newestId && newestId !== initializedFor) {
    const latest = revisions[0];
    const previous = revisions[1] ?? null;
    setInitializedFor(newestId);
    if (latest && previous) {
      setPendingFrom(previous._id);
      setPendingTo(latest._id);
      setActivePair({ from: previous._id, to: latest._id });
    } else if (latest) {
      // 1 件しかない場合は to のみ既定にする
      setPendingFrom(null);
      setPendingTo(latest._id);
      setActivePair(null);
    }
  }

  const canCompare = useMemo(() => {
    return Boolean(pendingFrom && pendingTo && pendingFrom !== pendingTo);
  }, [pendingFrom, pendingTo]);

  const isPairDirty = useMemo(() => {
    if (!activePair) return canCompare;
    return canCompare && (activePair.from !== pendingFrom || activePair.to !== pendingTo);
  }, [activePair, canCompare, pendingFrom, pendingTo]);

  const handleCompare = () => {
    if (!canCompare || !pendingFrom || !pendingTo) return;
    setActivePair({ from: pendingFrom, to: pendingTo });
  };

  // `revisions` is newest-first (index 0 = newest, larger index = older).
  // The diff is always rendered `from` → `to`, so `from` must be the
  // OLDER side and `to` the NEWER side. Disable any radio that would
  // invert that: `to` can't sit at/older than the selected `from`, and
  // `from` can't sit at/newer than the selected `to`.
  const fromIndex = pendingFrom ? revisions.findIndex((r) => r._id === pendingFrom) : -1;
  const toIndex = pendingTo ? revisions.findIndex((r) => r._id === pendingTo) : -1;

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

      {!isLoading && !isError && revisions.length === 0 && (
        <Alert>
          <AlertTitle>{m['page_history.no_revisions_title']()}</AlertTitle>
          <AlertDescription>{m['page_history.no_revisions_body']()}</AlertDescription>
        </Alert>
      )}

      {!isLoading && !isError && revisions.length === 1 && (
        <section aria-label="Revision diff">
          <RevisionDiff fromId={null} toId={revisions[0]._id} />
        </section>
      )}

      {!isLoading && !isError && revisions.length >= 2 && (
        <>
          <section aria-label="Revisions list">
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
                  {revisions.map((rev, i) => {
                    // When the revision was made via the collab
                    // `crowi:save` flow, `savedBy` holds the user who
                    // triggered the checkpoint and `contributors`
                    // lists the peers who had a live cursor on the
                    // page since the previous Save. Pre-RFC-0003
                    // revisions have neither, so we fall back to
                    // `author` (which v1.x already populated for
                    // every revision).
                    const savedBy = rev.savedBy ?? rev.author ?? null;
                    const allContributors = rev.contributors ?? [];
                    // Defensive de-dup: the server already filters
                    // savedBy out of contributors before persisting,
                    // but legacy data + future Hocuspocus changes
                    // could re-introduce the duplicate — strip it
                    // here so the UI never repeats "Saved by Alice
                    // (with Alice, Bob)". `Intl.ListFormat` then
                    // handles locale separators (English ", and";
                    // Japanese 「、」).
                    const contributors = savedBy ? allContributors.filter((c) => c._id !== savedBy._id) : allContributors;
                    const contributorNames = listFormatter.format(contributors.map((c) => c.name));
                    const isFrom = pendingFrom === rev._id;
                    const isTo = pendingTo === rev._id;
                    // Keep the from → to direction: `from` can't be newer
                    // than `to`, and `to` can't be older than `from`.
                    const fromDisabled = isTo || (toIndex !== -1 && i < toIndex);
                    const toDisabled = isFrom || (fromIndex !== -1 && i > fromIndex);
                    return (
                      <tr key={rev._id} className="border-t">
                        <td className="px-3 py-2 text-center">
                          <input
                            type="radio"
                            name="rev-from"
                            value={rev._id}
                            checked={isFrom}
                            disabled={fromDisabled}
                            onChange={() => setPendingFrom(rev._id)}
                            aria-label={`Select revision ${rev._id.slice(-8)} as from`}
                          />
                        </td>
                        <td className="px-3 py-2 text-center">
                          <input
                            type="radio"
                            name="rev-to"
                            value={rev._id}
                            checked={isTo}
                            disabled={toDisabled}
                            onChange={() => setPendingTo(rev._id)}
                            aria-label={`Select revision ${rev._id.slice(-8)} as to`}
                          />
                        </td>
                        <td className="px-3 py-2">
                          {savedBy ? (
                            <div className="flex items-center gap-2">
                              <UserAvatar user={savedBy} size="sm" />
                              <span className="truncate">{savedBy.name}</span>
                              {(rev.editVia === 'oauth' || rev.editVia === 'pat') && <ApiEditChip />}
                              {contributors.length > 0 && (
                                <span className="text-muted-foreground ml-1 text-xs">{m['collab.history_with_others']({ names: contributorNames })}</span>
                              )}
                            </div>
                          ) : (
                            <span className="text-muted-foreground">{m['page_history.unknown_author']()}</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <span title={formatDateTime(rev.createdAt)}>{formatDistanceToNow(rev.createdAt)}</span>
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">
                          <Link
                            href={`${pagePath}?revision_id=${rev._id}`}
                            className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                            title={`Open revision ${rev._id}`}
                          >
                            {rev._id.slice(-8)}
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-end gap-2 mt-3">
              <Button onClick={handleCompare} disabled={!canCompare} type="button" size="sm">
                <GitCompare className="h-4 w-4 mr-1" />
                {isPairDirty ? m['page_history.update_diff']() : m['page_history.compare']()}
              </Button>
            </div>
          </section>

          {activePair && (
            <section aria-label="Revision diff" className="border-t pt-6">
              <RevisionDiff fromId={activePair.from} toId={activePair.to} />
            </section>
          )}
        </>
      )}
    </div>
  );
}
