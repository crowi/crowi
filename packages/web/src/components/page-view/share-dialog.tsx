'use client';

import type { PageWithRevision } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { SharePanelContent } from './link-share-popover';

interface ShareDialogProps {
  page: PageWithRevision;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Mobile / touch counterpart of `LinkSharePopover` — a `DropdownMenuItem`
 * (compact sticky header, portal `foldSocial` header) opens this instead of
 * a nested popover, which doesn't work well as a touch target. Renders the
 * exact same `SharePanelContent` as the PC popover, lazily mounted
 * (`{open && ...}`, same pattern as `RenameDialog` / `PortalizeDialog`) so
 * the auto-copy-on-open behavior and the "title + URL" / Markdown rows never
 * drift between the two entry points.
 */
export function ShareDialog({ page, open, onOpenChange }: ShareDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {/* `SharePanelContent` already renders a "共有" heading visually
            (via `DropdownMenuLabel`); this title only backs `aria-labelledby`
            for screen readers, so it stays visually hidden. */}
        <DialogTitle className="sr-only">{m['page.share.title']()}</DialogTitle>
        {open && <SharePanelContent page={page} />}
      </DialogContent>
    </Dialog>
  );
}
