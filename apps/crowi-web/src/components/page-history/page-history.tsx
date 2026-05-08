'use client';

import { useMemo, useState } from 'react';
import { GitCompare, History as HistoryIcon, Loader2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { formatDateTime, formatDistanceToNow } from '@/lib/date-utils';
import { usePageRevisions } from '@/lib/use-page-revisions';
import { RevisionDiff } from './revision-diff';
import { m } from '@paraglide/messages.js';

interface PageHistoryProps {
  pageId: string;
  pagePath: string;
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
                  {revisions.map((rev) => {
                    const author = rev.author ?? null;
                    const isFrom = pendingFrom === rev._id;
                    const isTo = pendingTo === rev._id;
                    return (
                      <tr key={rev._id} className="border-t">
                        <td className="px-3 py-2 text-center">
                          <input
                            type="radio"
                            name="rev-from"
                            value={rev._id}
                            checked={isFrom}
                            disabled={isTo}
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
                            disabled={isFrom}
                            onChange={() => setPendingTo(rev._id)}
                            aria-label={`Select revision ${rev._id.slice(-8)} as to`}
                          />
                        </td>
                        <td className="px-3 py-2">
                          {author ? (
                            <div className="flex items-center gap-2">
                              <Avatar className="h-6 w-6">
                                <AvatarImage src={author.image || undefined} alt={author.name} />
                                <AvatarFallback className="bg-primary/10 text-primary text-xs">{author.name.charAt(0).toUpperCase()}</AvatarFallback>
                              </Avatar>
                              <span className="truncate">{author.name}</span>
                            </div>
                          ) : (
                            <span className="text-muted-foreground">{m['page_history.unknown_author']()}</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <span title={formatDateTime(rev.createdAt)}>{formatDistanceToNow(rev.createdAt)}</span>
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{rev._id.slice(-8)}</td>
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
