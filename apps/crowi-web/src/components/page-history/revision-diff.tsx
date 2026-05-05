'use client';

import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { Loader2 } from 'lucide-react';
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
      <span className="text-sm">Loading diff viewer...</span>
    </div>
  ),
});

interface RevisionDiffProps {
  // 古い側 (oldValue) のリビジョン id
  fromId: string;
  // 新しい側 (newValue) のリビジョン id
  toId: string;
}

export function RevisionDiff({ fromId, toId }: RevisionDiffProps) {
  const { revisions, isLoading, isError, error, refetch } = useRevisionPair(fromId, toId);
  const [splitView, setSplitView] = useState(true);

  const { fromRevision, toRevision } = useMemo(() => {
    if (!revisions) return { fromRevision: null, toRevision: null };
    return {
      fromRevision: revisions.find((r) => r._id === fromId) ?? null,
      toRevision: revisions.find((r) => r._id === toId) ?? null,
    };
  }, [revisions, fromId, toId]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-6" role="status">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">Loading revisions...</span>
      </div>
    );
  }

  if (isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Failed to load diff</AlertTitle>
        <AlertDescription>
          {error?.message ?? 'Please try again later.'}
          <div className="mt-3">
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    );
  }

  if (!fromRevision || !toRevision) {
    return (
      <Alert>
        <AlertTitle>Revisions not available</AlertTitle>
        <AlertDescription>選択したリビジョンが見つかりませんでした。</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          <span className="font-medium">From</span> <code className="bg-muted px-1.5 py-0.5 rounded text-xs">{fromRevision._id.slice(-8)}</code>
          <span className="mx-2">→</span>
          <span className="font-medium">To</span> <code className="bg-muted px-1.5 py-0.5 rounded text-xs">{toRevision._id.slice(-8)}</code>
        </div>
        <Button variant="outline" size="sm" onClick={() => setSplitView((v) => !v)} type="button">
          {splitView ? 'Unified view' : 'Split view'}
        </Button>
      </div>
      <div className="rounded-md border overflow-hidden text-sm">
        <ReactDiffViewer
          oldValue={fromRevision.body ?? ''}
          newValue={toRevision.body ?? ''}
          splitView={splitView}
          useDarkTheme={false}
          // markdown 本文は行単位での差分が分かりやすい
          compareMethod={DiffMethod.LINES}
          leftTitle={`From: ${fromRevision._id.slice(-8)}`}
          rightTitle={splitView ? `To: ${toRevision._id.slice(-8)}` : undefined}
          showDiffOnly={false}
        />
      </div>
    </div>
  );
}
