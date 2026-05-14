'use client';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { m } from '@paraglide/messages.js';

interface CollabForceReloadDialogProps {
  open: boolean;
  /**
   * Optional human-readable reason forwarded by the server in the
   * `crowi:force-reload` stateless message. Typically `'admin-edit'`
   * or `'yjs-state-corrupted'` — surfaced verbatim in the description
   * since the server controls the wording.
   */
  reason?: string;
  /**
   * Override the reload behaviour for tests. In production the default
   * `window.location.reload()` is what the user wants — they're
   * acknowledging that local Y.Doc state is now divergent from the
   * server's authoritative `Page.body`.
   */
  onReload?: () => void;
}

/**
 * RFC-0003 Phase 8 — modal that announces an external page-body edit
 * detected by the collab server and prompts the user to reload. We
 * deliberately do NOT auto-reload after a countdown:
 *
 *   - the user may have local unsaved changes (in the editor before
 *     yCollab applied the server's authoritative state) — giving them
 *     a moment to copy text out is more respectful than yanking the
 *     page out from under them
 *   - the explicit click is the user's signal that they've seen the
 *     warning, which keeps blame clear if they later complain about
 *     "lost work"
 *
 * Cancel button is intentionally omitted: the editor is effectively
 * inoperable once the server-side Y.Doc has been replaced, so
 * "Cancel + keep editing the stale doc" is not a valid mode.
 *
 * Controlled component: parent owns `open` so the dialog can be
 * driven by the `subscribeStateless` listener that hears
 * `crowi:force-reload` arrive.
 */
export function CollabForceReloadDialog({ open, reason, onReload }: CollabForceReloadDialogProps) {
  const handleReload = () => {
    if (onReload) {
      onReload();
      return;
    }
    // Real reload in production. Wrapped in a typeof check so SSR
    // (Next.js server-side render) doesn't blow up before hydration.
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  return (
    <AlertDialog open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{m['collab.force_reload_title']()}</AlertDialogTitle>
          <AlertDialogDescription>{m['collab.force_reload_description']({ reason: reason ?? '' })}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction onClick={handleReload}>{m['collab.force_reload_action']()}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
