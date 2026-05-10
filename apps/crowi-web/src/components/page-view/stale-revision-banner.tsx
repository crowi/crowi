'use client';

import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { m } from '@paraglide/messages.js';

interface StaleRevisionBannerProps {
  pagePath: string;
}

export function StaleRevisionBanner({ pagePath }: StaleRevisionBannerProps) {
  return (
    <Alert className="border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
      <AlertTriangle className="h-4 w-4" />
      <AlertDescription className="flex items-center gap-3">
        <span className="font-medium">{m['page.stale_revision_warning']()}</span>
        <Link href={pagePath} className="underline underline-offset-2 hover:no-underline">
          {m['page.stale_revision_show_latest']()}
        </Link>
      </AlertDescription>
    </Alert>
  );
}
