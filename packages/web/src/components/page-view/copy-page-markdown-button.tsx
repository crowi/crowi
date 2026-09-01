'use client';

import type { PageWithRevision } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { AlertCircle, Check, ClipboardCopy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { copyFailureMessage, useCopyFeedback } from '@/lib/use-copy-feedback';

/**
 * Standing "copy this page as markdown" button under the TOC rail.
 *
 * The same body the dotmenu's copy action puts on the clipboard, promoted
 * to a visible control because handing a whole page to an AI assistant is
 * a repeated action that shouldn't cost a menu round-trip. The dotmenu
 * item stays — this is an additional surface, not a replacement.
 *
 * Feedback is the inline icon/label swap (`useCopyFeedback`, as used by
 * the heading-anchor and code-block copy buttons) rather than the
 * dotmenu's toast: the button is still on screen, so it can report on
 * itself. On failure the same slot swaps to an alert icon and a
 * reason-specific label (HTTPS-required for a missing `navigator.clipboard`,
 * a generic "couldn't copy" otherwise) — still no toast. Renders nothing
 * for an empty body, matching the dotmenu action's refusal to claim it
 * copied something when there is nothing to copy.
 *
 * Callers pass a page-identity `key` (see `page-view.tsx` / `page-list.tsx`)
 * so navigating to a different page remounts this component instead of
 * carrying a stale "Copied" state across pages.
 */
export function CopyPageMarkdownButton({ page }: { page: PageWithRevision }) {
  const { copied, failed, copy } = useCopyFeedback();

  const body = page.revision?.body ?? '';
  if (body.length === 0) return null;

  const label = copied ? m['page.markdown_copied']() : (copyFailureMessage(failed) ?? m['page.action_copy_markdown']());

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-8 w-full justify-start gap-2 px-2.5 text-xs font-normal text-muted-foreground hover:text-foreground"
      onClick={() => copy(body)}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
      ) : failed ? (
        <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden="true" />
      ) : (
        <ClipboardCopy className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      )}
      <span className="truncate">{label}</span>
    </Button>
  );
}
