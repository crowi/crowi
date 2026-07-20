'use client';

import type { PageWithRevision } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { Check, Copy, Link2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { buildPageShareUrl } from '@/lib/build-page-share-url';
import { useAppInfo } from '@/lib/use-app-info';

interface LinkSharePopoverProps {
  page: PageWithRevision;
}

export function LinkSharePopover({ page }: LinkSharePopoverProps) {
  const [open, setOpen] = useState(false);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={m['page.share.aria_open']()}
          title={m['page.share.aria_open']()}
          className="text-muted-foreground hover:text-foreground"
        >
          <Link2 className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[480px] p-2">
        {/* Lazy-mount: `DropdownMenuContent` already unmounts on close via Radix
            Presence, but gating on `open` here too makes that unmount
            synchronous (tied to React state, not to the exit-animation grace
            period) — see `SharePanelContent`'s auto-copy-on-mount effect,
            which needs a guaranteed fresh mount every time the popover opens. */}
        {open && <SharePanelContent page={page} />}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface SharePanelContentProps {
  page: PageWithRevision;
}

/**
 * The share panel body: auto-copies the id URL as soon as it mounts, then
 * offers per-row copy for the "title + URL" line and the Markdown line.
 * Shared, verbatim, by two containers:
 *   - `LinkSharePopover`'s `DropdownMenuContent` (PC / wide header)
 *   - `ShareDialog`'s `DialogContent` (mobile compact / portal dot-menu)
 *
 * Both containers only mount this component while open (either via Radix's
 * own Presence-gated unmounting, or — for `ShareDialog` — the explicit
 * `{open && ...}` lazy-mount pattern used elsewhere for dialogs, see
 * `PortalizeDialog` / `RenameDialog`), so a plain mount effect reproduces
 * the "auto-copy the instant the panel opens" contract without any
 * cross-component prop plumbing.
 *
 * `DropdownMenuLabel` / `DropdownMenuSeparator` render as plain,
 * context-free `<div>`s under the hood (no dependency on an actual
 * `DropdownMenu` being open), so reusing them here keeps the PC popover's
 * markup byte-for-byte unchanged while still working inside `ShareDialog`'s
 * `DialogContent`.
 */
export function SharePanelContent({ page }: SharePanelContentProps) {
  const { data: appInfo } = useAppInfo();
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  // Tracks the pending "reset the confirmation" timer so it can be cleared
  // on unmount (below) or superseded by a later copy — without this, a
  // panel that opens and closes within 1500ms (e.g. the auto-copy-on-open
  // effect below, on every reopen) leaves an orphaned `setTimeout` that
  // fires after the component — and in a test, the whole render
  // environment — is gone, throwing instead of silently updating state
  // that no longer matters.
  const copyResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // `copy()` is async (it awaits the clipboard write) — a panel that
  // unmounts WHILE that await is still pending would otherwise resume
  // afterward and schedule a brand-new reset timer the unmount cleanup
  // below already ran and can never clear again. Checked immediately after
  // the await, before touching state or scheduling anything.
  const isMountedRef = useRef(true);

  const idUrl = buildPageShareUrl(page._id);
  const title = appInfo?.title || 'Crowi';
  const shareLink = `${title} ${page.path} ${idUrl}`;
  const markdown = `[${page.path}](${idUrl})`;

  const copy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      if (!isMountedRef.current) return;
      setCopiedKey(key);
      if (copyResetTimeoutRef.current !== null) clearTimeout(copyResetTimeoutRef.current);
      copyResetTimeoutRef.current = setTimeout(() => {
        copyResetTimeoutRef.current = null;
        setCopiedKey((k) => (k === key ? null : k));
      }, 1500);
    } catch {
      // clipboard unavailable (insecure context, denied) — surface nothing,
      // input is selectable so the user can still copy manually.
    }
  };

  useEffect(() => {
    copy('idUrl', idUrl);
    // Intentionally mount-only — fires once per panel open (see the
    // container comments above), mirroring `idUrl` at that instant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (copyResetTimeoutRef.current !== null) clearTimeout(copyResetTimeoutRef.current);
    };
  }, []);

  return (
    <>
      <DropdownMenuLabel className="flex items-center gap-2 px-2 pb-1">
        {/* The "共有" title stays put; the copy confirmation rides on the
            right edge (auto-copy fires on open) so it never hides the
            title. `ml-auto` pushes it to the far end. */}
        <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
        {m['page.share.title']()}
        {copiedKey === 'idUrl' && (
          <span className="ml-auto flex items-center gap-1 text-xs font-normal text-emerald-700 dark:text-emerald-400">
            <Check className="h-3.5 w-3.5 text-emerald-600" />
            {m['page.share.url_copied']()}
          </span>
        )}
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      <ShareRow label={m['page.share.link_label']()} value={shareLink} copied={copiedKey === 'shareLink'} onCopy={() => copy('shareLink', shareLink)} />
      <ShareRow label={m['page.share.markdown_label']()} value={markdown} copied={copiedKey === 'markdown'} onCopy={() => copy('markdown', markdown)} />
    </>
  );
}

interface ShareRowProps {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}

function ShareRow({ label, value, copied, onCopy }: ShareRowProps) {
  return (
    <div className="grid grid-cols-[110px_1fr_auto] items-center gap-2 px-2 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <Input value={value} readOnly className="font-mono text-xs h-8 bg-muted/40" onFocus={(e) => e.currentTarget.select()} />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={onCopy}
        aria-label={copied ? m['page.share.copied']() : m['page.share.copy']()}
        title={copied ? m['page.share.copied']() : m['page.share.copy']()}
      >
        {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
      </Button>
    </div>
  );
}
