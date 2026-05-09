'use client';

import { useState } from 'react';
import { Check, Copy, Link2 } from 'lucide-react';
import type { PageWithRevision } from '@crowi/api-contract';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { useAppInfo } from '@/lib/use-app-info';
import { m } from '@paraglide/messages.js';

interface LinkSharePopoverProps {
  page: PageWithRevision;
}

function buildIdUrl(pageId: string): string {
  if (typeof window === 'undefined') return `/${pageId}`;
  return `${window.location.origin}/${pageId}`;
}

export function LinkSharePopover({ page }: LinkSharePopoverProps) {
  const { data: appInfo } = useAppInfo();
  const [open, setOpen] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const idUrl = buildIdUrl(page._id);
  const title = appInfo?.title || 'Crowi';
  const shareLink = `${title} ${page.path} ${idUrl}`;
  const markdown = `[${page.path}](${idUrl})`;

  const copy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
    } catch {
      // clipboard unavailable (insecure context, denied) — surface nothing,
      // input is selectable so the user can still copy manually.
    }
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) copy('idUrl', idUrl);
  };

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
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
        <DropdownMenuLabel className="flex items-center gap-2 px-2 pb-1">
          {copiedKey === 'idUrl' ? (
            <>
              <Check className="h-3.5 w-3.5 text-emerald-600" />
              <span className="text-emerald-700 dark:text-emerald-400">{m['page.share.url_copied']()}</span>
            </>
          ) : (
            <>
              <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
              {m['page.share.title']()}
            </>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <ShareRow label={m['page.share.link_label']()} value={shareLink} copied={copiedKey === 'shareLink'} onCopy={() => copy('shareLink', shareLink)} />
        <ShareRow label={m['page.share.markdown_label']()} value={markdown} copied={copiedKey === 'markdown'} onCopy={() => copy('markdown', markdown)} />
      </DropdownMenuContent>
    </DropdownMenu>
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
