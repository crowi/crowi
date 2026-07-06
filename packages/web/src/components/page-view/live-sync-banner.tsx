'use client';

import { RefreshCw, X } from 'lucide-react';
import { m } from '@paraglide/messages.js';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { LiveSyncBannerState } from './live-sync-banner-state';

/**
 * feature-live-page-content-sync — the fixed top-center banner that
 * announces a live body swap and offers to jump between the latest and
 * the previously-read revision. A persistent action bar (Google
 * Docs / Notion style), so it deliberately does NOT use the
 * bottom-right `sonner` toaster (auto-dismiss stack, single fixed
 * position). Sits above the `(auth)` app header (`z-40`) and the compact
 * page header (`z-30`) at `z-50`.
 *
 * Pure presentational: all state lives in the PageView-owned
 * {@link LiveSyncBannerState} reducer; this component only renders it and
 * wires the three actions.
 */
interface LiveSyncBannerProps {
  state: LiveSyncBannerState;
  /** "read the previous version" — offered while showing the latest. */
  onReadOld: () => void;
  /** "show the latest" / "back to the latest" — offered while showing old. */
  onShowLatest: () => void;
  /** Dismiss the banner (X). */
  onDismiss: () => void;
}

export function LiveSyncBanner({ state, onReadOld, onShowLatest, onDismiss }: LiveSyncBannerProps) {
  if (state.kind === 'hidden') return null;

  const { title, description, action } = describe(state, onReadOld, onShowLatest);

  return (
    <div className="fixed left-1/2 top-3 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2" data-testid="live-sync-banner" data-kind={state.kind}>
      <Alert className="items-center border-primary/30 bg-card shadow-header [&>svg]:translate-y-0">
        <RefreshCw className="h-4 w-4 text-primary" aria-hidden="true" />
        <div className="col-start-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="min-w-0 space-y-0.5">
            <AlertTitle>{title}</AlertTitle>
            <AlertDescription>{description}</AlertDescription>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {action && (
              <Button variant="outline" size="sm" onClick={action.onClick} className="shrink-0">
                {action.label}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onDismiss}
              aria-label={m['page.live_sync_dismiss']()}
              title={m['page.live_sync_dismiss']()}
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </Alert>
    </div>
  );
}

function describe(
  state: Exclude<LiveSyncBannerState, { kind: 'hidden' }>,
  onReadOld: () => void,
  onShowLatest: () => void,
): { title: string; description: string; action: { label: string; onClick: () => void } | null } {
  switch (state.kind) {
    case 'showing-latest':
      return {
        title: m['page.live_sync_updated_by']({ name: state.editorDisplayName }),
        description: m['page.live_sync_showing_latest'](),
        action: { label: m['page.live_sync_read_previous'](), onClick: onReadOld },
      };
    case 'showing-old':
      return {
        title: m['page.live_sync_updated_by']({ name: state.editorDisplayName }),
        description: m['page.live_sync_showing_old'](),
        action: { label: m['page.live_sync_show_latest'](), onClick: onShowLatest },
      };
    case 'showing-latest-again':
      return {
        title: m['page.live_sync_newer_saved']({ name: state.editorDisplayName }),
        description: m['page.live_sync_showing_old'](),
        action: { label: m['page.live_sync_show_latest'](), onClick: onShowLatest },
      };
  }
}
