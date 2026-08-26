'use client';

import { m } from '@paraglide/messages.js';
import { Loader2 } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useTheme } from 'next-themes';
import { useMemo, useState } from 'react';
import { DiffMethod } from 'react-diff-viewer-continued';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useRevisionPair } from '@/lib/use-page-revisions';

// react-diff-viewer-continued depends on @emotion which uses browser-only APIs
// at module load time, so we render it client-side only.
const ReactDiffViewer = dynamic(() => import('react-diff-viewer-continued'), {
  ssr: false,
  loading: () => (
    <div className="flex items-center gap-2 text-muted-foreground py-4">
      <Loader2 className="h-4 w-4 animate-spin" />
      <span className="text-sm">{m['page_history.diff_loading_viewer']()}</span>
    </div>
  ),
});

interface RevisionDiffProps {
  // 古い側 (oldValue) のリビジョン id。null を渡すと oldValue は空文字列になり、
  // ページ作成時の最初の revision を「全文追加」として表示するときに使う。
  fromId: string | null;
  // 新しい側 (newValue) のリビジョン id
  toId: string;
}

export function RevisionDiff({ fromId, toId }: RevisionDiffProps) {
  const { revisions, displayedFromId, displayedToId, isLoading, isFetching, isError, error, refetch } = useRevisionPair(fromId, toId);
  const [splitView, setSplitView] = useState(true);
  // GitHub-style fold: by default only the changed lines (+3 lines of
  // surrounding context) render, and unchanged regions collapse behind a
  // click-to-expand indicator. This toggle switches to showing every line.
  const [showAllLines, setShowAllLines] = useState(false);
  // RevisionDiff stays mounted while the parent swaps `fromId`/`toId` (no
  // `key` remount), so without this the "show all lines" choice would leak
  // into the next revision pair. Reset it during render when the compared
  // pair changes — the React-recommended way to adjust state in response to
  // a prop change without an effect (avoids an extra commit + the
  // synchronous-setState-in-effect lint rule) — matching the non-persistent
  // fold state required by the spec.
  const [comparedPair, setComparedPair] = useState({ fromId, toId });
  if (comparedPair.fromId !== fromId || comparedPair.toId !== toId) {
    setComparedPair({ fromId, toId });
    setShowAllLines(false);
  }
  // react-diff-viewer-continued ships its own light/dark palettes via
  // `useDarkTheme`. Drive it from the app theme so the diff colours match
  // the rest of the UI; `resolvedTheme` is `'dark'` for explicit dark or
  // system + OS dark, anything else (incl. pre-mount `undefined`) is light.
  const { resolvedTheme } = useTheme();

  const { fromRevision, toRevision } = useMemo(() => {
    if (!revisions) return { fromRevision: null, toRevision: null };
    return {
      fromRevision: displayedFromId == null ? null : (revisions.find((r) => r._id === displayedFromId) ?? null),
      toRevision: revisions.find((r) => r._id === displayedToId) ?? null,
    };
  }, [revisions, displayedFromId, displayedToId]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-6" role="status">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">{m['page_history.diff_loading_revisions']()}</span>
      </div>
    );
  }

  if (isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>{m['page_history.diff_failed_title']()}</AlertTitle>
        <AlertDescription>
          {error?.message ?? m['common.try_again_later']()}
          <div className="mt-3">
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              {m['common.retry']()}
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    );
  }

  if (!toRevision || (displayedFromId != null && !fromRevision)) {
    return (
      <Alert>
        <AlertTitle>{m['page_history.diff_revisions_unavailable_title']()}</AlertTitle>
        <AlertDescription>{m['page_history.diff_revisions_unavailable_body']()}</AlertDescription>
      </Alert>
    );
  }

  const oldValue = fromRevision?.body ?? '';
  const newValue = toRevision.body ?? '';
  const fromLabel = fromRevision ? fromRevision._id.slice(-8) : m['page_history.diff_initial_revision']();
  // showDiffOnly folds unchanged regions down to a single "Expand N lines"
  // indicator, so an exact-match pair collapses the whole file into one
  // block — technically clickable but not a helpful way to say "nothing
  // changed". Detect it up front and show a plain message instead.
  const hasNoChanges = oldValue === newValue;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          <span className="font-medium">{m['page_history.diff_from']()}</span> <code className="bg-muted px-1.5 py-0.5 rounded text-xs">{fromLabel}</code>
          <span className="mx-2">→</span>
          <span className="font-medium">{m['page_history.diff_to']()}</span>{' '}
          <code className="bg-muted px-1.5 py-0.5 rounded text-xs">{toRevision._id.slice(-8)}</code>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="inline-flex size-4 shrink-0 items-center justify-center"
            role={isFetching ? 'status' : undefined}
            aria-label={isFetching ? m['page_history.diff_loading_revisions']() : undefined}
          >
            {isFetching && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />}
          </span>
          {!hasNoChanges && (
            <Button variant="outline" size="sm" onClick={() => setShowAllLines((v) => !v)} type="button">
              {showAllLines ? m['page_history.diff_show_changes_only']() : m['page_history.diff_show_all_lines']()}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => setSplitView((v) => !v)} type="button">
            {splitView ? m['page_history.diff_unified_view']() : m['page_history.diff_split_view']()}
          </Button>
        </div>
      </div>
      {hasNoChanges ? (
        <div className="rounded-md border p-6 text-sm text-muted-foreground text-center">{m['page_history.diff_no_changes']()}</div>
      ) : (
        <div className="rounded-md border overflow-hidden text-sm">
          <ReactDiffViewer
            oldValue={oldValue}
            newValue={newValue}
            splitView={splitView}
            useDarkTheme={resolvedTheme === 'dark'}
            // markdown 本文は行単位での差分が分かりやすい
            compareMethod={DiffMethod.LINES}
            leftTitle={`From: ${fromLabel}`}
            rightTitle={splitView ? `To: ${toRevision._id.slice(-8)}` : undefined}
            // GitHub-style fold by default: only changed lines plus 3 lines
            // of surrounding context render, and unchanged regions collapse
            // behind a click-to-expand indicator. These two match the
            // library's own defaults, but are pinned explicitly here so the
            // intent doesn't depend on defaults that could change upstream.
            // The header toggle flips `showDiffOnly` off to show every line,
            // including unchanged context.
            showDiffOnly={!showAllLines}
            extraLinesSurroundingDiff={3}
          />
        </div>
      )}
    </div>
  );
}
